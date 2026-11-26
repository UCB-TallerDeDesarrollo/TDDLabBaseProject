/**
 * Tests del CLI del Script B (`tdd:db:cycles`).
 * La BD se mockea: aquí NO se ejecuta ninguna consulta real.
 */
jest.mock("./lib/db.js", () => ({
  query: jest.fn(),
  closePool: jest.fn(async () => {}),
  missingConfigMessage: jest.fn(() => "Falta la URL de la base de datos DB-B."),
}));

import { query } from "./lib/db.js";
import { parseArgs, USAGE, runCyclesCli, findOrphans } from "./lib/cyclesCli.js";

const PROJECT = { id: "1", name: "app", link: "https://github.com/acme/app", github_user: "acme" };
const BRANCH = { id: "7", project_id: "1", name: "main" };

const GRAPH_ROW = {
  commit_sha: "sha1",
  committed_at: new Date("2026-01-01T00:00:00Z"),
  message: "feat: algo",
  additions: 10,
  deletions: 2,
  total_changes: 12,
  test_conclusion: "failure",
  passed_tests: 7,
  failed_tests: 3,
  coverage: 0.4,
};

const COMMIT_ROW = {
  sha: "sha1",
  committed_at: new Date("2026-01-01T00:00:00Z"),
  message: "feat: algo",
  author: "Dev",
  author_email: "dev@example.com",
  additions: 10,
  deletions: 2,
  changed_files: 1,
  parent_shas: ["parent"],
  executions: [],
  inherited_executions: 0,
};

/**
 * Dispatcher de consultas: devuelve filas según marcadores únicos de cada SQL.
 * El orden importa: `FROM branch_commit` contiene a `FROM branch`.
 */
function installQueryMock({ project = PROJECT, branch = BRANCH, graph = [GRAPH_ROW], commits = [COMMIT_ROW] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes("FROM project")) return { rows: project ? [project] : [] };
    if (sql.includes("as commit_sha")) return { rows: graph }; // getTDDCyclesGraph
    if (sql.includes("COALESCE(e.executions")) return { rows: commits }; // readBranchCommits
    if (sql.includes("FROM branch\n")) return { rows: branch ? [branch] : [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }));
});

describe("parseArgs", () => {
  it("sin banderas activa --audit por defecto", () => {
    const o = parseArgs([]);
    expect(o.audit).toBe(true);
    expect(o.orphans).toBe(false);
    expect(o.json).toBe(false);
  });

  it("con --orphans no activa --audit", () => {
    const o = parseArgs(["--orphans"]);
    expect(o.orphans).toBe(true);
    expect(o.audit).toBe(false);
  });

  it("lee project, branch y json", () => {
    const o = parseArgs(["--audit", "--json", "--project", "acme/app", "--branch", "main"]);
    expect(o).toMatchObject({
      audit: true,
      json: true,
      project: "acme/app",
      branch: "main",
    });
  });

  it("--help no activa --audit", () => {
    const o = parseArgs(["--help"]);
    expect(o.help).toBe(true);
    expect(o.audit).toBe(false);
  });

  it("rechaza argumentos desconocidos", () => {
    expect(() => parseArgs(["--borrar"])).toThrow(/Unknown argument/);
  });
});

describe("runCyclesCli", () => {
  it("--help imprime el uso y sale con 0", async () => {
    const lines = [];
    const code = await runCyclesCli(["--help"], { log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("--audit");
    expect(lines.join("\n")).toContain("--orphans");
    expect(query).not.toHaveBeenCalled();
  });

  it("argumento inválido sale con 1 y muestra el uso", async () => {
    const lines = [];
    const code = await runCyclesCli(["--noexiste"], { log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Unknown argument");
    expect(lines.join("\n")).toContain("--audit");
  });

  it("--audit reporta divergencias y sale con 0", async () => {
    installQueryMock();
    const lines = [];
    const code = await runCyclesCli(["--audit", "--project", "acme/app", "--branch", "main"], {
      log: (l) => lines.push(l),
    });

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("audit project=1 branch=main");
    expect(out).toContain("divergencias=1");
    // sin-ejecucion-marcado-rojo: el grafo pinta rojo y no hay ejecuciones locales
    expect(out).toContain("motivo=sin-ejecucion-marcado-rojo");
    // Solo SELECT
    for (const call of query.mock.calls) {
      expect(call[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    }
  });

  it("--audit --json emite JSON parseable", async () => {
    installQueryMock();
    const lines = [];
    const code = await runCyclesCli(["--audit", "--json"], { log: (l) => lines.push(l) });

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.branch).toBe("main");
    expect(parsed.project_id).toBe("1");
    expect(parsed.summary.divergences).toBe(1);
    expect(parsed.divergences[0].reason).toBe("sin-ejecucion-marcado-rojo");
  });

  it("sale con 1 si ningún proyecto coincide", async () => {
    installQueryMock({ project: null });
    const lines = [];
    const code = await runCyclesCli(["--audit", "--project", "acme/desconocido"], {
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("No project matched");
  });

  it("--orphans imprime el resumen por proyecto", async () => {
    installQueryMock();
    const lines = [];
    const code = await runCyclesCli(["--orphans"], { log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("orphans project=1");
  });

  it("propaga el error de configuración de BD con código 1", async () => {
    query.mockImplementation(async () => {
      throw new Error("Falta la URL de la base de datos DB-B.");
    });
    const lines = [];
    const code = await runCyclesCli(["--audit"], { log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Falta la URL");
  });

  it("un error de BD inesperado sale con código 1", async () => {
    query.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const lines = [];
    const code = await runCyclesCli(["--audit"], { log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("connection refused");
  });
});

describe("findOrphans", () => {
  it("con --project devuelve un solo reporte", async () => {
    installQueryMock();
    const report = await findOrphans("1");
    expect(Array.isArray(report)).toBe(false);
    expect(report.project).toBe("1");
    expect(report.executions_without_commit).toEqual([]);
    expect(report.head_marker_executions).toBe(0);
  });

  it("sin --project devuelve un reporte por proyecto", async () => {
    installQueryMock();
    const reports = await findOrphans(undefined);
    expect(Array.isArray(reports)).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].project).toBe("1");
  });

  it("solo emite consultas SELECT", async () => {
    installQueryMock();
    await findOrphans(undefined);
    for (const call of query.mock.calls) {
      expect(call[0]).toMatch(/^\s*SELECT/i);
    }
  });
});

describe("USAGE", () => {
  it("documenta las garantías de solo lectura", () => {
    expect(USAGE).toContain("solo lectura");
    expect(USAGE).toContain("--orphans");
    expect(USAGE).toContain("--json");
  });
});
