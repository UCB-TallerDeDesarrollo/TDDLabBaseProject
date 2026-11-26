/**
 * Tests de la auditoría de ciclos: compara la clasificación viva de DB-B con
 * la propuesta y explica cada divergencia. Solo lectura.
 */
import { buildAuditReport } from "./lib/cycleAudit.js";

const now = () => new Date("2026-01-02T00:00:00.000Z");

const point = (over = {}) => ({
  commit_sha: "sha1",
  message: "feat: algo",
  test_conclusion: "success",
  passed_tests: 10,
  failed_tests: 0,
  coverage: 0.8,
  phase_hint: "green",
  ...over,
});

const row = (over = {}) => ({
  sha: "sha1",
  message: "feat: algo",
  parent_shas: ["parent"],
  executions: [],
  inherited_executions: 0,
  ...over,
});

const greenExec = {
  id: 1,
  executed_at: "2026-01-01T00:00:00.000Z",
  total_tests: 10,
  passed_tests: 10,
  failed_tests: 0,
  coverage: 0.8,
  conclusion: "success",
};

const redExec = {
  id: 2,
  executed_at: "2026-01-01T00:01:00.000Z",
  total_tests: 10,
  passed_tests: 7,
  failed_tests: 3,
  coverage: 0.4,
  conclusion: "failure",
};

const report = (over = {}) =>
  buildAuditReport({
    projectId: "1",
    branchId: "7",
    branchName: "main",
    current: [point()],
    rows: [row()],
    now,
    ...over,
  });

describe("buildAuditReport: sin divergencias", () => {
  it("clasificación actual y propuesta coinciden", () => {
    const r = report({ rows: [row({ executions: [greenExec] })] });
    expect(r.summary.divergences).toBe(0);
    expect(r.summary.divergence_rate).toBe(0);
    expect(r.divergences).toEqual([]);
    expect(r.branch).toBe("main");
    expect(r.project_id).toBe("1");
    expect(r.generated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(r.summary.current.green).toBe(1);
    expect(r.summary.proposed.green).toBe(1);
    expect(r.summary.colors.current.green).toBe(1);
    expect(r.summary.colors.proposed.green).toBe(1);
  });

  it("un commit presente en git_commit pero sin punto en el grafo se reporta igual", () => {
    const r = report({ current: [], rows: [row({ executions: [greenExec] })] });
    expect(r.summary.divergences).toBe(0);
    expect(r.summary.proposed.green).toBe(1);
    expect(r.summary.current.green).toBeUndefined();
    expect(r.commits_analyzed).toBe(1);
  });
});

describe("buildAuditReport: motivos de divergencia", () => {
  it("sin-ejecucion-marcado-rojo: el grafo pinta rojo sin ejecuciones locales", () => {
    const r = report({
      current: [
        point({
          phase_hint: "red",
          test_conclusion: "failure",
          passed_tests: 7,
          failed_tests: 3,
          coverage: 0.4,
        }),
      ],
      rows: [row({ executions: [] })],
    });
    expect(r.summary.divergences).toBe(1);
    expect(r.divergences[0].reason).toBe("sin-ejecucion-marcado-rojo");
    expect(r.divergences[0].current).toEqual({ phase: "red", color: "red" });
    expect(r.divergences[0].proposed.phase).toBe("unknown");
    expect(r.summary.divergence_rate).toBe(1);
  });

  it("merge-mal-etiquetado: el merge tiene fase distinta de unknown", () => {
    const r = report({
      current: [point({ phase_hint: "red", test_conclusion: "failure", failed_tests: 1 })],
      rows: [row({ parent_shas: ["a", "b"], executions: [] })],
    });
    expect(r.divergences[0].reason).toBe("merge-mal-etiquetado");
    expect(r.divergences[0].evidence.is_merge).toBe(true);
  });

  it("secuencia-colapsada: rojo-> verde en un commit que el grafo ve solo rojo", () => {
    const r = report({
      current: [
        point({ phase_hint: "red", test_conclusion: "failure", failed_tests: 3, coverage: 0.4 }),
      ],
      rows: [row({ executions: [redExec, { ...greenExec, executed_at: "2026-01-01T00:02:00.000Z" }] })],
    });
    expect(r.divergences[0].reason).toBe("secuencia-colapsada");
    expect(r.divergences[0].proposed.cycle).toBe("red-green");
    expect(r.divergences[0].evidence.red_runs).toBe(1);
    expect(r.divergences[0].evidence.green_runs).toBe(1);
  });

  it("fuga-entre-ramas: sin ejecuciones locales pero con heredadas", () => {
    const r = report({
      current: [point({ phase_hint: "green" })],
      rows: [row({ executions: [], inherited_executions: 4 })],
    });
    expect(r.divergences[0].reason).toBe("fuga-entre-ramas");
    expect(r.divergences[0].evidence.inherited_runs).toBe(4);
  });

  it("refactor-por-diff: el grafo afirma refactor y el propuesto no lo verifica", () => {
    const r = report({
      current: [point({ phase_hint: "refactor", message: "refactor: limpiar" })],
      rows: [row({ message: "refactor: limpiar", executions: [greenExec] })],
    });
    expect(r.divergences[0].reason).toBe("refactor-por-diff");
    // Sin diff de tests no se afirma refactor: es solo un candidato de baja confianza.
    expect(r.divergences[0].proposed.cycle).toBe("refactor-candidate");
    expect(r.divergences[0].proposed.confidence).toBe("low");
  });

  it("color-distinto: fallback cuando ninguna regla anterior aplica", () => {
    const r = report({
      current: [point({ coverage: null })], // el grafo pintaría negro
      rows: [row({ executions: [greenExec] })], // el propuesto pinta verde
    });
    expect(r.divergences[0].reason).toBe("color-distinto");
    expect(r.divergences[0].current.color).toBe("black");
    expect(r.divergences[0].proposed.color).toBe("green");
  });
});

describe("buildAuditReport: agregación", () => {
  it("cuenta divergencias, colores y calcula la tasa sobre lo analizado", () => {
    const r = report({
      current: [
        point(),
        point({ commit_sha: "sha2", phase_hint: "red", test_conclusion: "failure", failed_tests: 2 }),
        point({ commit_sha: "sha3", phase_hint: "red", test_conclusion: "failure", failed_tests: 2 }),
      ],
      rows: [
        row({ executions: [greenExec] }),
        row({ sha: "sha2", message: "fix: b", executions: [] }),
        row({ sha: "sha3", message: "fix: c", executions: [greenExec] }),
      ],
    });

    expect(r.commits_analyzed).toBe(3);
    expect(r.summary.divergences).toBe(2);
    expect(r.summary.divergence_rate).toBeCloseTo(2 / 3, 5);
    expect(r.summary.current).toEqual({ green: 1, red: 2 });
    expect(r.summary.proposed).toEqual({ green: 2, "unknown": 1 });
  });

  it("no lanza con listas vacías", () => {
    const r = report({ current: [], rows: [] });
    expect(r.commits_analyzed).toBe(0);
    expect(r.summary.divergences).toBe(0);
    expect(r.summary.divergence_rate).toBe(0);
  });

  it("permite inyectar un clasificador (para tests deterministas)", () => {
    const classify = jest.fn(() => ({
      sha: "sha1",
      cycle: "green-only",
      phase_hint: "green",
      conclusion: "success",
      test_count: 10,
      coverage: 0.8,
      confidence: "high",
      evidence: {
        runs: 1,
        red_runs: 0,
        green_runs: 1,
        first_failure_at: null,
        first_green_at: "2026-01-01T00:00:00.000Z",
        last_run_at: "2026-01-01T00:00:00.000Z",
        inherited_runs: 0,
        is_merge: false,
        tests_changed: null,
      },
    }));

    const r = report({ classify, rows: [row({ executions: [greenExec] })] });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.summary.divergences).toBe(0);
  });
});
