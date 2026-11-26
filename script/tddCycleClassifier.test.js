/**
 * Tests del clasificador puro de ciclos TDD (Script B).
 * Port de las garantías de semántica de tddCycleClassifier.ts.
 */
import {
  classifyCommitCycle,
  isFailingExecution,
  isGreenExecution,
  coverageOf,
  REFACTOR_MESSAGE,
} from "./lib/tddCycleClassifier.js";

const exec = (over = {}) => ({
  id: 1,
  executed_at: "2026-01-01T00:00:00.000Z",
  total_tests: 10,
  passed_tests: 10,
  failed_tests: 0,
  coverage: 0.8,
  conclusion: "success",
  ...over,
});

const classify = (over = {}) =>
  classifyCommitCycle({
    sha: "abc123",
    message: "feat: algo",
    parentCount: 1,
    executions: [],
    ...over,
  });

describe("helpers", () => {
  it("isFailingExecution: failed_tests > 0 cuenta como rojo", () => {
    expect(isFailingExecution(exec({ failed_tests: 1 }))).toBe(true);
  });

  it("isFailingExecution: conclusion failure/error cuenta como rojo", () => {
    expect(isFailingExecution(exec({ conclusion: "failure", failed_tests: 0 }))).toBe(true);
    expect(isFailingExecution(exec({ conclusion: "error", failed_tests: 0 }))).toBe(true);
  });

  it("isGreenExecution: exige success, total > 0 y 0 fallos", () => {
    expect(isGreenExecution(exec())).toBe(true);
    expect(isGreenExecution(exec({ total_tests: 0 }))).toBe(false);
    expect(isGreenExecution(exec({ failed_tests: 2, passed_tests: 8 }))).toBe(false);
    expect(isGreenExecution(exec({ conclusion: "cancelled" }))).toBe(false);
  });

  it("coverageOf: normaliza vacíos a null y números a number", () => {
    expect(coverageOf(null)).toBeNull();
    expect(coverageOf(undefined)).toBeNull();
    expect(coverageOf("")).toBeNull();
    expect(coverageOf(0)).toBe(0);
    expect(coverageOf("0.75")).toBe(0.75);
    expect(coverageOf("abc")).toBeNull();
  });

  it("REFACTOR_MESSAGE detecta refactor sin ser case-sensitive", () => {
    expect(REFACTOR_MESSAGE.test("refactor: limpieza")).toBe(true);
    expect(REFACTOR_MESSAGE.test("Refactoring tests")).toBe(true);
    expect(REFACTOR_MESSAGE.test("feat: nueva función")).toBe(false);
  });
});

describe("commits sin ejecuciones", () => {
  it("NUNCA se clasifica como rojo: queda no-tests / unknown", () => {
    const c = classify();
    expect(c.cycle).toBe("no-tests");
    expect(c.phase_hint).toBe("unknown");
    expect(c.conclusion).toBe("neutral");
    expect(c.evidence.runs).toBe(0);
    expect(c.evidence.red_runs).toBe(0);
  });

  it("con ejecuciones heredadas queda no-tests-local (informativo)", () => {
    const c = classify({ inheritedExecutions: 3 });
    expect(c.cycle).toBe("no-tests-local");
    expect(c.phase_hint).toBe("unknown");
    expect(c.evidence.inherited_runs).toBe(3);
  });

  it("un merge sin ejecuciones queda merge/unknown (no rojo)", () => {
    const c = classify({ parentCount: 2 });
    expect(c.cycle).toBe("merge");
    expect(c.phase_hint).toBe("unknown");
    expect(c.evidence.is_merge).toBe(true);
  });
});

describe("secuencia rojo -> verde", () => {
  it("la última ejecución en fallo clasifica el commit como rojo", () => {
    const c = classify({
      executions: [exec({ id: 1, conclusion: "failure", failed_tests: 3, passed_tests: 7 })],
    });
    expect(c.cycle).toBe("failing");
    expect(c.phase_hint).toBe("red");
    expect(c.evidence.red_runs).toBe(1);
  });

  it("rojo -> verde en el MISMO commit es red-green y conserva la evidencia", () => {
    const c = classify({
      executions: [
        exec({ id: 1, executed_at: "2026-01-01T00:00:00.000Z", conclusion: "failure", failed_tests: 2 }),
        exec({ id: 2, executed_at: "2026-01-01T00:05:00.000Z" }),
      ],
    });
    expect(c.cycle).toBe("red-green");
    expect(c.phase_hint).toBe("green");
    expect(c.evidence.red_runs).toBe(1);
    expect(c.evidence.green_runs).toBe(1);
    expect(c.evidence.first_failure_at).toBe("2026-01-01T00:00:00.000Z");
    expect(c.evidence.first_green_at).toBe("2026-01-01T00:05:00.000Z");
  });

  it("ordena las ejecuciones por executed_at, no por el orden recibido", () => {
    const c = classify({
      executions: [
        exec({ id: 9, executed_at: "2026-01-01T00:10:00.000Z" }), // verde, llega primero
        exec({ id: 2, executed_at: "2026-01-01T00:00:00.000Z", conclusion: "failure", failed_tests: 1 }),
      ],
    });
    expect(c.cycle).toBe("red-green");
  });

  it("merge con evidencia rojo-> verde queda merge (no red-green)", () => {
    const c = classify({
      parentCount: 2,
      executions: [
        exec({ id: 1, conclusion: "failure", failed_tests: 1 }),
        exec({ id: 2, executed_at: "2026-01-01T00:05:00.000Z" }),
      ],
    });
    expect(c.cycle).toBe("merge");
    expect(c.phase_hint).toBe("green");
  });
});

describe("verde y refactor", () => {
  it("verde sin rojo previo queda green-only", () => {
    const c = classify({ executions: [exec()] });
    expect(c.cycle).toBe("green-only");
    expect(c.phase_hint).toBe("green");
    expect(c.test_count).toBe(10);
    expect(c.coverage).toBe(0.8);
  });

  it("mensaje refactor + diff de tests sin cambios => refactor verificable", () => {
    const c = classify({
      message: "refactor: extraer helper",
      executions: [exec()],
      testNamesChanged: false,
      hasTestResultsForComparison: true,
    });
    expect(c.cycle).toBe("refactor");
    expect(c.phase_hint).toBe("refactor");
    expect(c.confidence).toBe("high");
  });

  it("mensaje refactor sin evidencia => refactor-candidate con confianza baja", () => {
    const c = classify({
      message: "refactor: extraer helper",
      executions: [exec()],
      testNamesChanged: null,
      hasTestResultsForComparison: false,
    });
    expect(c.cycle).toBe("refactor-candidate");
    expect(c.confidence).toBe("low");
  });

  it("mensaje refactor con tests cambiados => NO se afirma refactor", () => {
    const c = classify({
      message: "refactor: cambiar firma",
      executions: [exec()],
      testNamesChanged: true,
      hasTestResultsForComparison: true,
    });
    expect(c.cycle).toBe("refactor-candidate");
    expect(c.confidence).toBe("low");
  });

  it("merge verde queda merge", () => {
    const c = classify({ parentCount: 2, executions: [exec()] });
    expect(c.cycle).toBe("merge");
    expect(c.phase_hint).toBe("green");
  });
});

describe("casos límite", () => {
  it("última ejecución cancelada => inconclusive (no rojo ni verde)", () => {
    const c = classify({
      executions: [exec({ conclusion: "cancelled", passed_tests: 0, total_tests: 0 })],
    });
    expect(c.cycle).toBe("inconclusive");
    expect(c.phase_hint).toBe("unknown");
    expect(c.confidence).toBe("low");
  });

  it("success sin tests ejecutados no cuenta como verde", () => {
    const c = classify({ executions: [exec({ total_tests: 0, passed_tests: 0 })] });
    expect(c.cycle).toBe("inconclusive");
  });

  it("una ejecución posterior en verde pisa el rojo anterior para el estado, no la evidencia", () => {
    const c = classify({
      executions: [
        exec({ id: 1, executed_at: "2026-01-01T00:00:00.000Z", conclusion: "failure", failed_tests: 1 }),
        exec({ id: 2, executed_at: "2026-01-01T00:05:00.000Z" }),
        exec({ id: 3, executed_at: "2026-01-01T00:10:00.000Z" }),
      ],
    });
    expect(c.phase_hint).toBe("green");
    expect(c.evidence.runs).toBe(3);
    expect(c.evidence.red_runs).toBe(1);
    expect(c.evidence.first_failure_at).not.toBeNull();
  });

  it("ejecuciones heredadas no se mezclan con las locales", () => {
    const local = classify({ executions: [exec()], inheritedExecutions: 0 });
    const mixed = classify({ executions: [exec()], inheritedExecutions: 5 });
    expect(local.evidence.runs).toBe(1);
    expect(mixed.evidence.runs).toBe(1);
    expect(mixed.evidence.inherited_runs).toBe(5);
    expect(mixed.cycle).toBe("green-only");
  });
});
