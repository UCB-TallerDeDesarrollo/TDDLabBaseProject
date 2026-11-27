/**
 * Tests de la integración F4: `reach` en los hooks de Git.
 *
 * Nada toca Git ni Neon: `reach` está mockeado, el `.env` se inyecta y los
 * archivos `.husky/` solo se LEEN. Estos tests verifican:
 *   1. que cada hook ejecute `reach --apply`,
 *   2. la prevención de recursividad (TDDLAB_INTERNAL / guardas),
 *   3. el comportamiento sin `.env`,
 *   4. el comportamiento cuando Neon no responde,
 *   5. que un fallo de sincronización nunca devuelva ≠ 0 (no bloquea Git),
 *   6. que `post-commit` conserve su comportamiento original.
 */
jest.mock("./lib/reachCli.js", () => ({ runReachCli: jest.fn() }));
// closePool se mockea; el resto de db.js (resolveConnectionString, readDotEnv)
// es puro y se usa real. requireActual no abre conexiones: el pool es lazy.
jest.mock("./lib/db.js", () => {
  const actual = jest.requireActual("./lib/db.js");
  return { ...actual, closePool: jest.fn(async () => {}) };
});

import fs from "node:fs";
import path from "node:path";
import { runReachCli } from "./lib/reachCli.js";
import { closePool } from "./lib/db.js";
import { HOOKS, DEFAULT_TIMEOUT_MS, resolveHookPlan, runHookSync, main } from "./lib/hookSync.js";

/** URL con credenciales: NO debe aparecer nunca en la salida. */
const ENV_OK = { BRANCH_SUPPORT_DATABASE_URL: "postgresql://user:secret-pw@host.example/db" };
const GIT = { repoRoot: "/repo/falso" };

const lines = [];
const log = (line) => lines.push(String(line));

const deps = (extra = {}) => ({ env: ENV_OK, dotEnv: {}, log, git: GIT, runReach: runReachCli, ...extra });

beforeEach(() => {
  runReachCli.mockReset();
  runReachCli.mockResolvedValue({ exitCode: 0, result: { action: "noop" } });
  lines.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Decisión de sincronizar
// ---------------------------------------------------------------------------

describe("resolveHookPlan", () => {
  it("solo conoce los 4 hooks de F4", () => {
    expect(HOOKS).toEqual(["post-commit", "post-merge", "post-checkout", "post-rewrite"]);
  });

  it.each(HOOKS)("programa sync para %s con configuración válida", (hook) => {
    expect(resolveHookPlan({ hook, env: ENV_OK, dotEnv: {} })).toEqual({ action: "sync", hook });
  });

  it("acepta la configuración cuando viene del .env (sin variable de entorno)", () => {
    const plan = resolveHookPlan({
      hook: "post-commit",
      env: {},
      dotEnv: { BRANCH_SUPPORT_DATABASE_URL: "postgresql://user:pw@host/db" },
    });
    expect(plan.action).toBe("sync");
  });

  it("sin .env y sin variable de entorno hace skip (no-config)", () => {
    expect(resolveHookPlan({ hook: "post-merge", env: {}, dotEnv: {} })).toEqual({
      action: "skip",
      reason: "no-config",
      hook: "post-merge",
    });
  });

  it("TDDLAB_INTERNAL=1 hace skip: anti-recursión y kill-switch manual", () => {
    const plan = resolveHookPlan({
      hook: "post-commit",
      env: { ...ENV_OK, TDDLAB_INTERNAL: "1" },
      dotEnv: {},
    });
    expect(plan).toEqual({ action: "skip", reason: "internal-guard", hook: "post-commit" });
  });

  it("rechaza hooks desconocidos", () => {
    expect(resolveHookPlan({ hook: "pre-push", env: ENV_OK, dotEnv: {} }).reason).toBe("unknown-hook");
    expect(resolveHookPlan({ hook: undefined, env: ENV_OK, dotEnv: {} }).action).toBe("skip");
    expect(resolveHookPlan({ hook: "post-commitx", env: ENV_OK, dotEnv: {} }).action).toBe("skip");
  });

  it("la variable de entorno gana sobre el .env", () => {
    const plan = resolveHookPlan({
      hook: "post-checkout",
      env: { DATABASE_URL: "postgresql://de-env/db" },
      dotEnv: { DATABASE_URL: "postgresql://de-archivo/db" },
    });
    expect(plan.action).toBe("sync");
  });
});

// ---------------------------------------------------------------------------
// 2. Ejecución de reach desde cada hook
// ---------------------------------------------------------------------------

describe.each(HOOKS)("runHookSync(%s)", (hook) => {
  it("ejecuta reach exactamente en modo --apply", async () => {
    const out = await runHookSync(hook, deps());

    expect(runReachCli).toHaveBeenCalledTimes(1);
    expect(runReachCli).toHaveBeenCalledWith(["--apply"], expect.objectContaining({ git: GIT }));
    expect(out.exitCode).toBe(0);
    expect(out.plan).toEqual({ action: "sync", hook });
    expect(lines.join("\n")).toContain(`tdd-sync: ${hook}`);
  });

  it("nunca invoca cycles (sigue siendo manual)", async () => {
    await runHookSync(hook, deps());
    const argv = runReachCli.mock.calls[0][0];
    expect(argv).toEqual(["--apply"]); // sin --cycles ni nada del Script B
    expect(argv.join(" ")).not.toMatch(/cycles|audit|orphans/);
  });

  it("cierra el pool para no dejar conexiones abiertas", async () => {
    await runHookSync(hook, deps());
    expect(closePool).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Prevención de recursividad
// ---------------------------------------------------------------------------

describe("prevención de recursividad", () => {
  it("con TDDLAB_INTERNAL=1 no se ejecuta reach", async () => {
    const out = await runHookSync("post-commit", deps({ env: { ...ENV_OK, TDDLAB_INTERNAL: "1" } }));

    expect(runReachCli).not.toHaveBeenCalled();
    expect(out.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("internal-guard");
  });

  it("la guarda aplica aunque también falte configuración (primero la guarda)", () => {
    const plan = resolveHookPlan({ hook: "post-commit", env: { TDDLAB_INTERNAL: "1" }, dotEnv: {} });
    expect(plan.reason).toBe("internal-guard");
  });

  it("el post-commit exporta TDDLAB_INTERNAL=1 alrededor del amend y lo limpia antes del sync", () => {
    const src = readHook("post-commit");
    const exportIdx = src.indexOf("export TDDLAB_INTERNAL=1");
    const amendIdx = src.indexOf("git commit --amend");
    const unsetIdx = src.indexOf("unset TDDLAB_INTERNAL");
    const syncIdx = src.indexOf("hookSync.js");

    expect(exportIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeLessThan(amendIdx); // cubre el amend (que dispara hooks)
    expect(unsetIdx).toBeGreaterThan(amendIdx);
    expect(syncIdx).toBeGreaterThan(unsetIdx); // el sync corre con el entorno limpio
  });
});

// ---------------------------------------------------------------------------
// 4. Falta de .env
// ---------------------------------------------------------------------------

describe("sin .env", () => {
  it("hace skip sin llamar a reach y sale con 0", async () => {
    const out = await runHookSync("post-checkout", deps({ env: {}, dotEnv: {} }));

    expect(runReachCli).not.toHaveBeenCalled();
    expect(out.exitCode).toBe(0);
    expect(out.reachExitCode).toBeNull();
    expect(lines.join("\n")).toContain("no-config");
  });

  it("main devuelve 0 (número) cuando falta la configuración", async () => {
    const code = await main(["post-checkout"], deps({ env: {}, dotEnv: {} }));
    expect(code).toBe(0);
    expect(typeof code).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 5. Neon no responde / fallo de sincronización
// ---------------------------------------------------------------------------

describe("cuando Neon no responde", () => {
  it("captura la excepción, reporta el error y devuelve 0", async () => {
    runReachCli.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));

    const out = await runHookSync("post-merge", deps());

    expect(out.exitCode).toBe(0);
    expect(out.reachExitCode).toBe(-1);
    expect(out.result).toEqual({ action: "error", reason: "connect ECONNREFUSED 127.0.0.1:1" });
    expect(lines.join("\n")).toContain("ECONNREFUSED");
  });

  it("main devuelve 0 aunque reach lance (Git nunca se bloquea)", async () => {
    runReachCli.mockRejectedValue(new Error("getaddrinfo ENOTFOUND neon.example"));
    const code = await main(["post-rewrite"], deps());
    expect(code).toBe(0);
    expect(typeof code).toBe("number");
  });

  it("main devuelve 0 si reach termina con código de error (≠ 0)", async () => {
    runReachCli.mockResolvedValue({ exitCode: 2, result: { action: "error", reason: "runtime" } });
    const code = await main(["post-commit"], deps());
    expect(code).toBe(0);
  });

  it("main devuelve 0 con hook desconocido o sin argumentos", async () => {
    expect(await main(["pre-push"], deps())).toBe(0);
    expect(await main([], deps())).toBe(0);
    expect(runReachCli).not.toHaveBeenCalled();
  });

  it("regresión: main devuelve SIEMPRE un número (nunca un objeto)", async () => {
    // Antes devolvía el objeto de runHookSync y Node fallaba al asignar
    // process.exitCode: "The code argument must be of type number".
    runReachCli.mockResolvedValue({ exitCode: 0, result: { action: "noop" } });
    const code = await main(["post-commit"], deps());
    expect(typeof code).toBe("number");
    expect(code).toBe(0);
  });

  it("runHookSync nunca lanza, ni siquiera con deps rotas", async () => {
    runReachCli.mockImplementation(() => {
      throw new Error("fallo síncrono inesperado");
    });
    await expect(runHookSync("post-commit", deps())).resolves.toMatchObject({ exitCode: 0 });
  });
});

// ---------------------------------------------------------------------------
// 6. Seguridad: sin credenciales en la salida
// ---------------------------------------------------------------------------

describe("salida segura", () => {
  it("no imprime la URL de conexión ni la contraseña", async () => {
    runReachCli.mockResolvedValue({
      exitCode: 0,
      result: { action: "noop", connectionString: ENV_OK.BRANCH_SUPPORT_DATABASE_URL },
    });

    await runHookSync("post-commit", deps());

    const all = lines.join("\n");
    expect(all).not.toContain("secret-pw");
    expect(all).not.toContain("postgresql://");
    expect(all).not.toContain("PGPASSWORD");
    expect(all).not.toContain("JWT_SECRET");
  });

  it("el mensaje de skip tampoco filtra credenciales", async () => {
    await runHookSync("post-commit", deps({ env: {}, dotEnv: {} }));
    expect(lines.join("\n")).not.toMatch(/postgres|:@/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Archivos .husky: integración y conservación del comportamiento original
// ---------------------------------------------------------------------------

const huskyDir = path.join(__dirname, "..", ".husky");
const readHook = (name) => fs.readFileSync(path.join(huskyDir, name), "utf8");

describe("archivos .husky", () => {
  it.each(HOOKS)("el hook %s invoca hookSync con su nombre, con || true y cierra en exit 0", (hook) => {
    const src = readHook(hook);

    expect(src).toContain('script/hookSync.js"');
    expect(src).toContain(`${hook} || true`); // doble red de seguridad
    expect(src.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("ningún hook ejecuta cycles automáticamente", () => {
    for (const hook of HOOKS) {
      const src = readHook(hook);
      expect(src).not.toMatch(/cycles\.js|--audit|--orphans/);
    }
    // ni el runner tampoco
    const runner = fs.readFileSync(path.join(__dirname, "lib", "hookSync.js"), "utf8");
    expect(runner).not.toMatch(/cyclesCli|runCyclesCli|cycles\.js/);
    // solo imports de reach/db/gitTopology (nada del Script B)
    const imports = [...runner.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./reachCli.js", "./db.js", "./gitTopology.js"]);
  });

  it("post-commit conserva el flujo original del proyecto", () => {
    const src = readHook("post-commit");

    // Guarda original
    expect(src).toContain('if [ "$HUSKY_SKIP_TRACK" = "1" ]');
    // Tracking original
    expect(src).toContain("node ./script/commitScript.js");
    expect(src).toContain('node "$REPO_DIR/script/commit-tracker.js"');
    // Amend original con su guarda HUSKY=0
    expect(src).toContain("export HUSKY=0");
    expect(src).toContain("git add script/commit-history.json");
    expect(src).toContain("git add script/tdd_log.json");
    expect(src).toContain("git commit --amend --no-edit");
    expect(src).toContain("unset HUSKY");
  });

  it("post-commit sincroniza DESPUÉS del amend (para registrar el SHA final)", () => {
    const src = readHook("post-commit");
    const amendIdx = src.indexOf("git commit --amend");
    const syncIdx = src.indexOf('hookSync.js" post-commit');

    expect(amendIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(amendIdx);
  });

  it("los 3 hooks nuevos solo agregan la línea de sync (no tocan nada más)", () => {
    for (const hook of ["post-merge", "post-checkout", "post-rewrite"]) {
      const src = readHook(hook);
      // Declaración + cálculo de REPO_DIR + sync + exit 0
      expect(src).toMatch(/git rev-parse --show-toplevel/);
      // Solo líneas de código (los comentarios mencionan `git checkout` a título informativo)
      const code = src
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .join("\n");
      expect(code).not.toMatch(/git (commit|rebase|reset|checkout|merge)/); // no modifica Git
      expect(code).not.toMatch(/DELETE|DROP|TRUNCATE/i); // no borra en Neon
      expect(code).toMatch(/hookSync\.js/);
      expect(code).toMatch(/exit 0/);
    }
  });

  it("los hooks no llevan credenciales", () => {
    for (const hook of HOOKS) {
      const src = readHook(hook);
      expect(src).not.toMatch(/postgresql:\/\/|PGPASSWORD|JWT_SECRET|neon\.tech/);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Constantes de seguridad
// ---------------------------------------------------------------------------

describe("constantes", () => {
  it("el watchdog es ≥ 30 s (un apply en frío tarda ~20 s)", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });
});
