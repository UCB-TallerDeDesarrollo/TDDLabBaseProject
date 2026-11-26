/**
 * Tests del CLI del Script A (`tdd:db:reach`).
 * git y la BD se mockean: aquí NO se ejecuta git real ni ninguna consulta.
 */
jest.mock("./lib/db.js", () => ({
  query: jest.fn(),
  getPool: jest.fn(),
  closePool: jest.fn(async () => {}),
  missingConfigMessage: jest.fn(() => "Falta la URL de la base de datos DB-B."),
}));

jest.mock("./lib/gitTopology.js", () => {
  const actual = jest.requireActual("./lib/gitTopology.js");
  return {
    ...actual,
    resolveRepoRoot: jest.fn(),
    currentBranch: jest.fn(),
    readReachable: jest.fn(),
    readRemoteUrl: jest.fn(),
    readCommitMeta: jest.fn(),
    readCommitStats: jest.fn(),
  };
});

import { query, getPool } from "./lib/db.js";
import {
  resolveRepoRoot,
  currentBranch,
  readReachable,
  readRemoteUrl,
  readCommitMeta,
  readCommitStats,
} from "./lib/gitTopology.js";
import { parseArgs, parseProjectArg, computePlan, applyPlan, runReachCli, EXIT, USAGE } from "./lib/reachCli.js";

const REPO = { owner: "acme", name: "app", link: "https://github.com/acme/app" };
const PROJECT = { id: "1", name: "app", link: "https://github.com/acme/app", github_user: "acme" };
const BRANCH = { id: "7", name: "main", head_commit_sha: "old", deleted_at: null };

const REACH = {
  head: "c2",
  commits: [
    { sha: "c2", parent_shas: ["c1"] },
    { sha: "c1", parent_shas: [] },
  ],
  truncated: false,
  shallow: false,
};

/** Dispatcher de consultas del plan de reconciliación. */
function installPlanQueryMock({
  project = PROJECT,
  branch = BRANCH,
  existingCommits = [],
  existingBranchCommits = [],
  existingEdges = [],
} = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes("FROM project")) return { rows: project ? [project] : [] };
    if (sql.includes("FROM branch_commit")) return { rows: existingBranchCommits };
    if (sql.includes("FROM branch")) return { rows: branch ? [branch] : [] };
    if (sql.includes("FROM commit_parent")) return { rows: existingEdges };
    if (sql.includes("FROM git_commit")) return { rows: existingCommits };
    return { rows: [] };
  });
}

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (handler) return handler(sql, params);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockImplementation(() => ({
    connect: async () => fakeClient(),
    end: async () => {},
  }));
});

describe("parseArgs", () => {
  it("dry-run por defecto y --apply solo activa la escritura", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("acepta los flags documentados", () => {
    const o = parseArgs(["--apply", "--json", "--project", "acme/app", "--branch", "main", "--max-commits", "50"]);
    expect(o).toMatchObject({
      apply: true,
      json: true,
      project: "acme/app",
      branch: "main",
      maxCommits: 50,
    });
  });

  it("rechaza argumentos desconocidos", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unknown argument/);
  });

  it("valida --max-commits", () => {
    expect(() => parseArgs(["--max-commits", "abc"])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--max-commits", "-1"])).toThrow(/non-negative integer/);
    expect(parseArgs(["--max-commits", "0"]).maxCommits).toBe(0);
  });
});

describe("parseProjectArg", () => {
  it("normaliza owner/repo", () => {
    expect(parseProjectArg("acme/app")).toEqual({
      owner: "acme",
      name: "app",
      link: "https://github.com/acme/app",
    });
  });

  it("quita el sufijo .git", () => {
    expect(parseProjectArg("acme/app.git").link).toBe("https://github.com/acme/app");
  });

  it("rechaza valores que no son owner/repo", () => {
    expect(() => parseProjectArg("acme")).toThrow(/owner\/repo/);
    expect(() => parseProjectArg("")).toThrow(/owner\/repo/);
  });
});

describe("computePlan (solo SELECT)", () => {
  it("reporta lo que falta sin escribir nada", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }],
      existingBranchCommits: [{ commit_sha: "c1" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
    });

    const plan = await computePlan({ repository: REPO, branchName: "main", reach: REACH });

    expect(plan.missing_git_commits).toEqual(["c2"]);
    expect(plan.missing_branch_commits).toEqual(["c2"]);
    expect(plan.missing_edges).toEqual([]);
    expect(plan.already_in_branch).toBe(1);
    expect(plan.stale).toEqual([]);
    expect(plan.head_changed).toBe(true); // "old" != "c2"
    expect(plan.project_exists).toBe(true);
    expect(plan.branch_exists).toBe(true);

    for (const call of query.mock.calls) {
      expect(call[0]).toMatch(/^\s*SELECT/i);
    }
  });

  it("detecta commits stale y NUNCA los propone borrar", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }, { sha: "stale1" }],
      existingBranchCommits: [{ commit_sha: "c1" }, { commit_sha: "stale1" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
    });

    const plan = await computePlan({ repository: REPO, branchName: "main", reach: REACH });
    expect(plan.stale).toEqual(["stale1"]);
    // El plan es puramente aditivo: no existe ningún campo de borrado.
    expect(Object.keys(plan).some((k) => k.startsWith("delete") || k.startsWith("remove"))).toBe(false);
  });

  it("omite aristas cuyo padre no sea alcanzable (shallow / --max-commits)", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }],
      existingBranchCommits: [{ commit_sha: "c1" }, { commit_sha: "c2" }],
      existingEdges: [],
    });
    const reach = {
      head: "c2",
      commits: [{ sha: "c2", parent_shas: ["desconocido"] }],
      truncated: true,
      shallow: false,
    };

    const plan = await computePlan({ repository: REPO, branchName: "main", reach });
    expect(plan.missing_edges).toEqual([]);
    expect(plan.skipped_edges).toBe(1);
    expect(plan.partial).toBe(true);
    expect(plan.truncated).toBe(true);
  });

  it("marca la creación de proyecto/rama cuando no existen", async () => {
    installPlanQueryMock({ project: null });
    const plan = await computePlan({ repository: REPO, branchName: "main", reach: REACH });
    expect(plan.would_create_project).toBe(true);
    expect(plan.would_create_branch).toBe(false);
    expect(plan.missing_branch_commits).toEqual(["c2", "c1"]);
    expect(plan.branch_exists).toBe(false);
  });

  it("marca la creación de rama si existe el proyecto pero no la rama", async () => {
    installPlanQueryMock({ branch: null, existingCommits: [{ sha: "c1" }, { sha: "c2" }] });
    const plan = await computePlan({ repository: REPO, branchName: "feature", reach: REACH });
    expect(plan.would_create_project).toBe(false);
    expect(plan.would_create_branch).toBe(true);
    expect(plan.missing_branch_commits).toEqual(["c2", "c1"]);
  });
});

describe("applyPlan (único punto de escritura)", () => {
  const planBase = {
    project_exists: true,
    project_id: "1",
    branch_exists: true,
    branch_id: "7",
    branch_deleted: false,
    branch_head: "old",
    existing_commits: ["c1"],
    existing_branch_commits: ["c1"],
    existing_edges: [],
    reachable: ["c2", "c1"],
    head: "c2",
    truncated: false,
    shallow: false,
    missing_git_commits: ["c2"],
    missing_branch_commits: ["c2"],
    missing_edges: [{ commit_sha: "c2", parent_sha: "c1", parent_order: 1 }],
    skipped_edges: 0,
    already_in_branch: 1,
    stale: [],
    head_changed: true,
    partial: false,
    would_create_project: false,
    would_create_branch: false,
  };

  const deps = (client) => ({
    connect: () => Promise.resolve(client),
    git: { repoRoot: "/repo" },
  });

  it("inserta en orden FK con ON CONFLICT DO NOTHING y sin DELETE", async () => {
    readCommitMeta.mockReturnValue({
      sha: "c2",
      parent_shas: ["c1"],
      author: "Dev",
      author_email: "dev@example.com",
      message: "feat: x",
      committed_at: "2026-01-01T00:00:00+00:00",
    });
    readCommitStats.mockReturnValue({ additions: 5, deletions: 2, changed_files: 1 });

    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO git_commit")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE branch")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const counts = await applyPlan(planBase, REPO, "main", REACH, deps(client));
    const sqls = client.calls.map((c) => c.sql);

    expect(sqls[0].trim()).toBe("BEGIN");
    expect(sqls[sqls.length - 1].trim()).toBe("COMMIT");
    expect(sqls.some((s) => s.includes("INSERT INTO git_commit"))).toBe(true);
    expect(sqls.some((s) => s.includes("ON CONFLICT (project_id, sha) DO NOTHING"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO commit_parent"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO branch_commit"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE branch"))).toBe(true);
    // Nunca borra nada.
    expect(sqls.some((s) => /\b(DELETE|TRUNCATE)\b/i.test(s))).toBe(false);

    // Orden FK: git_commit antes que commit_parent/branch_commit, y branch_commit
    // antes de actualizar el head de la rama.
    const idx = (needle) => sqls.findIndex((s) => s.includes(needle));
    expect(idx("INSERT INTO git_commit")).toBeLessThan(idx("INSERT INTO commit_parent"));
    expect(idx("INSERT INTO branch_commit")).toBeLessThan(idx("UPDATE branch"));

    expect(counts).toMatchObject({
      git_commits: 1,
      parent_edges: 1,
      branch_commits: 1,
      head_updated: true,
      project_created: false,
      branch_created: false,
    });
    expect(readCommitMeta).toHaveBeenCalledWith("/repo", "c2");
    expect(readCommitStats).toHaveBeenCalledWith("/repo", "c2", "c1");
  });

  it("inserta las aristas de padres con su orden", async () => {
    readCommitMeta.mockReturnValue({
      sha: "m1",
      parent_shas: ["c1", "c2"],
      author: "Dev",
      author_email: null,
      message: "merge",
      committed_at: "2026-01-01T00:00:00+00:00",
    });
    readCommitStats.mockReturnValue({ additions: 0, deletions: 0, changed_files: 0 });

    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO git_commit")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO commit_parent")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE branch")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const plan = {
      ...planBase,
      reachable: ["m1", "c1", "c2"],
      head: "m1",
      missing_git_commits: ["m1"],
      missing_branch_commits: ["m1", "c1", "c2"],
      missing_edges: [
        { commit_sha: "m1", parent_sha: "c1", parent_order: 1 },
        { commit_sha: "m1", parent_sha: "c2", parent_order: 2 },
      ],
      existing_commits: ["c1", "c2"],
      existing_branch_commits: [],
      already_in_branch: 0,
    };

    await applyPlan(plan, REPO, "main", { ...REACH, head: "m1" }, deps(client));

    const edgeCalls = client.calls.filter((c) => c.sql.includes("INSERT INTO commit_parent"));
    expect(edgeCalls).toHaveLength(2);
    expect(edgeCalls[0].params).toEqual(["1", "m1", "c1", 1]);
    expect(edgeCalls[1].params).toEqual(["1", "m1", "c2", 2]);
  });

  it("crea proyecto y rama si faltan (find-or-create)", async () => {
    readCommitMeta.mockReturnValue({
      sha: "c1",
      parent_shas: [],
      author: "Dev",
      author_email: null,
      message: "init",
      committed_at: "2026-01-01T00:00:00+00:00",
    });
    readCommitStats.mockReturnValue({ additions: 1, deletions: 0, changed_files: 1 });

    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO project")) return { rows: [{ id: "9" }], rowCount: 1 };
      if (sql.includes("INSERT INTO branch")) return { rows: [{ id: "11" }], rowCount: 1 };
      if (sql.includes("INSERT INTO git_commit")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE branch")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const plan = {
      ...planBase,
      project_exists: false,
      project_id: null,
      branch_exists: false,
      branch_id: null,
      would_create_project: true,
      would_create_branch: true,
      existing_commits: [],
      existing_branch_commits: [],
      missing_git_commits: ["c1"],
      missing_branch_commits: ["c1"],
      already_in_branch: 0,
    };

    const counts = await applyPlan(plan, REPO, "main", { ...REACH, head: "c1", commits: [{ sha: "c1", parent_shas: [] }] }, deps(client));

    const sqls = client.calls.map((c) => c.sql);
    expect(counts.project_created).toBe(true);
    expect(counts.branch_created).toBe(true);
    expect(sqls.findIndex((s) => s.includes("INSERT INTO project"))).toBeLessThan(
      sqls.findIndex((s) => s.includes("INSERT INTO git_commit"))
    );
    expect(sqls.findIndex((s) => s.includes("INSERT INTO branch"))).toBeLessThan(
      sqls.findIndex((s) => s.includes("INSERT INTO branch_commit"))
    );
    // ON CONFLICT en todas las escrituras
    for (const call of client.calls.filter((c) => c.sql.includes("INSERT"))) {
      expect(call.sql).toContain("ON CONFLICT");
    }
  });

  it("hace ROLLBACK si algo falla (sin dejar datos a medias)", async () => {
    readCommitMeta.mockReturnValue({
      sha: "c2",
      parent_shas: ["c1"],
      author: "Dev",
      author_email: null,
      message: "x",
      committed_at: "2026-01-01T00:00:00+00:00",
    });
    readCommitStats.mockReturnValue({ additions: 0, deletions: 0, changed_files: 0 });

    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO git_commit")) throw new Error("boom");
      return { rows: [], rowCount: 1 };
    });

    await expect(applyPlan(planBase, REPO, "main", REACH, deps(client))).rejects.toThrow("boom");
    const sqls = client.calls.map((c) => c.sql.trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("se niega a trabajar sobre una rama marcada como borrada", async () => {
    const client = fakeClient();
    await expect(
      applyPlan({ ...planBase, branch_deleted: true }, REPO, "main", REACH, deps(client))
    ).rejects.toThrow(/marcada como borrada/);
    expect(client.calls).toEqual([]); // ni BEGIN
  });
});

describe("runReachCli", () => {
  beforeEach(() => {
    resolveRepoRoot.mockReturnValue("/repo");
    currentBranch.mockReturnValue("main");
    readRemoteUrl.mockReturnValue("git@github.com:acme/app.git");
    readReachable.mockReturnValue(REACH);
  });

  it("--help imprime el uso y no toca git ni la BD", async () => {
    const lines = [];
    const r = await runReachCli(["--help"], { log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(lines.join("\n")).toContain("--apply");
    expect(resolveRepoRoot).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("argumento inválido sale con código de configuración", async () => {
    const lines = [];
    const r = await runReachCli(["--malo"], { log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT.CONFIG);
    expect(lines.join("\n")).toContain("Unknown argument");
    expect(query).not.toHaveBeenCalled();
  });

  it("se salta si el directorio no es un repositorio git", async () => {
    resolveRepoRoot.mockReturnValue(null);
    const r = await runReachCli([], { log: () => {} });
    expect(r.result.action).toBe("skipped");
    expect(r.result.reason).toBe("not-a-git-repository");
    expect(query).not.toHaveBeenCalled();
  });

  it("se salta con HEAD destacado", async () => {
    currentBranch.mockReturnValue(null);
    const r = await runReachCli([], { log: () => {} });
    expect(r.result.reason).toBe("detached-head");
    expect(query).not.toHaveBeenCalled();
  });

  it("se salta si no hay remoto y no se pasó --project", async () => {
    readRemoteUrl.mockReturnValue(null);
    const r = await runReachCli([], { log: () => {} });
    expect(r.result.reason).toBe("no-remote");
    expect(query).not.toHaveBeenCalled();
  });

  it("dry-run por defecto: reporta pero NO escribe", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }],
      existingBranchCommits: [{ commit_sha: "c1" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
    });

    const lines = [];
    const r = await runReachCli([], { log: (l) => lines.push(l), now: () => new Date("2026-01-02T00:00:00Z") });

    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.result.action).toBe("would-apply");
    expect(r.result.reason).toBe("dry-run");
    expect(r.result.mode).toBe("dry-run");
    expect(r.result.reachable).toBe(2);
    expect(r.result.already_in_branch).toBe(1);
    expect(r.result.missing_from_branch).toBe(1);
    expect(r.result.stale).toBe(0);
    expect(r.result.head_changed).toBe(true);
    expect(lines.join("\n")).toContain("would-apply");

    for (const call of query.mock.calls) {
      expect(call[0]).toMatch(/^\s*SELECT/i);
    }
  });

  it("--apply escribe y reporta los insertados", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }],
      existingBranchCommits: [{ commit_sha: "c1" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
    });
    readCommitMeta.mockReturnValue({
      sha: "c2",
      parent_shas: ["c1"],
      author: "Dev",
      author_email: null,
      message: "feat: x",
      committed_at: "2026-01-01T00:00:00+00:00",
    });
    readCommitStats.mockReturnValue({ additions: 3, deletions: 1, changed_files: 1 });

    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO git_commit")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE branch")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const lines = [];
    const r = await runReachCli(["--apply"], {
      log: (l) => lines.push(l),
      connect: () => Promise.resolve(client),
    });

    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.result.action).toBe("applied");
    expect(r.result.inserted).toMatchObject({
      git_commits: 1,
      branch_commits: 1,
      head_updated: true,
    });
    expect(client.calls[0].sql.trim()).toBe("BEGIN");
    expect(client.calls[client.calls.length - 1].sql.trim()).toBe("COMMIT");
    expect(lines.join("\n")).toContain("insertados: git_commit=1");
  });

  it("--apply sin nada que hacer es un noop idempotente", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }, { sha: "c2" }],
      existingBranchCommits: [{ commit_sha: "c1" }, { commit_sha: "c2" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
      branch: { ...BRANCH, head_commit_sha: "c2" },
    });

    const client = fakeClient();
    const r = await runReachCli(["--apply"], { log: () => {}, connect: () => Promise.resolve(client) });

    expect(r.result.action).toBe("noop");
    expect(r.result.reason).toBe("already-reconciled");
    expect(client.calls).toEqual([]);
  });

  it("reporta stale sin borrarlos", async () => {
    installPlanQueryMock({
      existingCommits: [{ sha: "c1" }, { sha: "viejo" }],
      existingBranchCommits: [{ commit_sha: "c1" }, { commit_sha: "viejo" }],
      existingEdges: [{ commit_sha: "c2", parent_sha: "c1" }],
    });

    const r = await runReachCli([], { log: () => {} });
    expect(r.result.stale).toBe(1);

    const plan = await computePlan({ repository: REPO, branchName: "main", reach: REACH });
    expect(plan.stale).toEqual(["viejo"]);
    expect(plan.missing_branch_commits).toEqual(["c2"]);
  });

  it("sale con código 1 si falta la URL de la BD", async () => {
    query.mockImplementation(async () => {
      throw new Error("Falta la URL de la base de datos DB-B.");
    });
    const lines = [];
    const r = await runReachCli([], { log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT.CONFIG);
    expect(r.result.reason).toBe("missing-database-url");
    expect(lines.join("\n")).toContain("Falta la URL");
  });

  it("se salta si git no devuelve commits", async () => {
    readReachable.mockReturnValue({ head: null, commits: [], truncated: false, shallow: false });
    const r = await runReachCli([], { log: () => {} });
    expect(r.result.reason).toBe("no-commits");
    expect(query).not.toHaveBeenCalled();
  });

  it("salta con --project inválido antes de tocar la BD", async () => {
    const r = await runReachCli(["--project", "no-es-repo"], { log: () => {} });
    expect(r.exitCode).toBe(EXIT.CONFIG);
    expect(r.result.reason).toBe("invalid-project");
    expect(query).not.toHaveBeenCalled();
  });

  it("--json emite JSON parseable", async () => {
    installPlanQueryMock({ project: null });
    const lines = [];
    const r = await runReachCli(["--json"], { log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT.OK);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.action).toBe("would-apply");
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.would_create_project).toBe(true);
  });
});

describe("USAGE", () => {
  it("documenta el dry-run y --apply", () => {
    expect(USAGE).toContain("dry-run por defecto");
    expect(USAGE).toContain("--apply");
    expect(USAGE).toContain("--max-commits");
  });
});
