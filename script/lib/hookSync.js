/**
 * Integración de `reach` (Script A) con los hooks de Git — fase F4.
 *
 * Responsabilidad ÚNICA: mantener la alcanzabilidad de DB-B actualizada
 * después de commit / merge / checkout / rewrite, sin interferir jamás con
 * las operaciones normales de Git.
 *
 * Garantías:
 *  - Solo corre `reach --apply` cuando existe una configuración válida de
 *    Neon (variable de entorno o archivo `.env` de la raíz del proyecto).
 *  - SIEMPRE devuelve exitCode 0: un fallo de sincronización nunca bloquea
 *    `git commit`, `git merge`, `git checkout` ni `git rebase`.
 *  - Guarda anti-recursión: con `TDDLAB_INTERNAL=1` no hace nada (sirve
 *    además como kill-switch manual de la auto-sincronización).
 *  - Nunca borra registros de Neon (reach es aditivo e idempotente).
 *  - Nunca ejecuta `cycles`: ese script sigue siendo manual.
 *  - Nunca imprime credenciales: la salida se resume en UNA línea
 *    `tdd-sync: ...` sin datos de conexión.
 *  - No modifica el historial de Git ni los scripts originales de registro.
 *
 * Nota de orden en `post-commit`: el hook existente hace
 * `git commit --amend --no-edit`, que CAMBIA el SHA del commit. Por eso este
 * runner se invoca DESPUÉS del amend: si corriera antes, registraría un SHA
 * que quedaría huérfano en DB-B.
 */
import { runReachCli } from "./reachCli.js";
import { resolveConnectionString, readDotEnv, closePool } from "./db.js";
import { resolveRepoRoot } from "./gitTopology.js";

/** Hooks de Git que ejecutan la auto-sincronización. */
export const HOOKS = Object.freeze([
  "post-commit",
  "post-merge",
  "post-checkout",
  "post-rewrite",
]);

/**
 * Límite de tiempo para que un `checkout` no se cuelgue esperando a Neon.
 *
 * 30 s: un `--apply` en frío (rama nueva con ~54 commits) tardó ~20 s; las
 * corridas ya reconciliadas tardan ~3 s. Si Neon no responde, el propio pool
 * corta antes (`connectionTimeoutMillis` = 10 s). Si el watchdog llega a
 * dispararse, `process.exit(0)` cierra la conexión y Postgres hace ROLLBACK
 * de la transacción abierta: no queda estado parcial (verificado).
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Decide si este hook debe sincronizar. Función pura (el `.env` se inyecta).
 *
 * @param {{hook?: string, env?: NodeJS.ProcessEnv, dotEnv?: Record<string,string>}} params
 * @returns {{action: "sync"|"skip", reason?: string, hook: string|null}}
 */
export function resolveHookPlan({ hook, env = process.env, dotEnv } = {}) {
  if (!HOOKS.includes(hook)) {
    return { action: "skip", reason: "unknown-hook", hook: hook ?? null };
  }

  // Anti-recursión / kill-switch manual.
  if (env.TDDLAB_INTERNAL === "1") {
    return { action: "skip", reason: "internal-guard", hook };
  }

  const dot = dotEnv === undefined ? readDotEnv() : dotEnv;
  const connectionString = resolveConnectionString(env, dot);
  if (!connectionString) {
    return { action: "skip", reason: "no-config", hook };
  }

  return { action: "sync", hook };
}

/**
 * Ejecuta la sincronización para un hook. **Nunca lanza y siempre devuelve
 * exitCode 0**, para que Git siga adelante pase lo que pase.
 *
 * @param {string} hook
 * @param {object} [deps] inyectable para tests: env, dotEnv, log, runReach,
 *   git, cwd, connect, now
 * @returns {Promise<{exitCode: 0, plan: object|null,
 *   reachExitCode: number|null, result: object|null}>}
 */
export async function runHookSync(hook, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => console.log(line));

  let plan;
  try {
    plan = resolveHookPlan({ hook, env, dotEnv: deps.dotEnv });
  } catch (error) {
    log(`tdd-sync: skip (config-error) hook=${hook ?? "?"} ${error?.message ?? error}`);
    return { exitCode: 0, plan: null, reachExitCode: null, result: null };
  }

  if (plan.action === "skip") {
    log(`tdd-sync: skip (${plan.reason}) hook=${plan.hook}`);
    return { exitCode: 0, plan, reachExitCode: null, result: null };
  }

  const lines = [];
  const git = deps.git ?? { repoRoot: resolveRepoRoot(deps.cwd ?? process.cwd()) };
  const reachDeps = { log: (line) => lines.push(line), git };
  if (deps.connect) reachDeps.connect = deps.connect;
  if (deps.now) reachDeps.now = deps.now;

  const runReach = deps.runReach ?? runReachCli;
  let reachExitCode = null;
  let result = null;

  try {
    const out = await runReach(["--apply"], reachDeps);
    reachExitCode = out?.exitCode ?? null;
    result = out?.result ?? null;
  } catch (error) {
    // Neon caído, DNS, timeout, permisos… da igual: no bloqueamos a Git.
    reachExitCode = -1;
    result = { action: "error", reason: String(error?.message ?? error) };
    lines.push(result.reason);
  } finally {
    // Cerrar el pool para que el hook salga de inmediato (no esperar al idle).
    await closePool().catch(() => {});
  }

  const summary = lines.join(" | ") || `action=${result?.action ?? "unknown"}`;
  log(`tdd-sync: ${plan.hook} ${summary}`);

  return { exitCode: 0, plan, reachExitCode, result };
}

/**
 * Punto de entrada de los hooks: `node script/hookSync.js <hook>`.
 * Siempre resuelve con 0 y con un watchdog para no colgar a Git.
 *
 * @param {string[]} [argv]
 * @param {object} [deps]
 * @returns {Promise<number>} siempre 0
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const hook = argv[0];
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => console.log(line));

  const raw = Number(env.TDDLAB_HOOK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;

  const timer = setTimeout(() => {
    console.error(`tdd-sync: timeout (${timeoutMs}ms) hook=${hook ?? "?"}`);
    process.exit(0);
  }, timeoutMs);

  try {
    const out = await runHookSync(hook, { ...deps, env, log });
    // SIEMPRE un número: `process.exitCode` rechaza objetos y Git recibiría
    // un error de Node en lugar del código de salida.
    return typeof out?.exitCode === "number" ? out.exitCode : 0;
  } catch (error) {
    log(`tdd-sync: error hook=${hook ?? "?"} ${error?.message ?? error}`);
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
