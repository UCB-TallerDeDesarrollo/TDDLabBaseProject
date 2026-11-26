/**
 * Clasificador puro de ciclos TDD para DB-B.
 *
 * Port a JavaScript de `server/src/modules/TDDCycles/Domain/tddCycleClassifier.ts`
 * (repo TDDLab). Sin I/O: lo consumen el CLI `tdd:db:cycles` y sus tests.
 *
 * Garantías de semántica (idénticas al original):
 *  - Un commit SIN ejecuciones NUNCA se clasifica como rojo.
 *  - Se consideran TODAS las ejecuciones del commit (no solo la última),
 *    para preservar la secuencia rojo -> verde como evidencia.
 *  - La clasificación está acotada a UNA rama: el caller pasa solo las
 *    ejecuciones registradas en esa rama; las de otras ramas llegan como
 *    `inheritedExecutions` (informativas) y nunca se mezclan.
 *  - Los merges se detectan por cantidad de padres, jamás por el mensaje.
 */

export const REFACTOR_MESSAGE = /\brefactor\w*\b/i;
const FAILED_CONCLUSIONS = new Set(["failure", "error"]);

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value) {
  if (value === undefined || value === null) return null;
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numeric(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function coverageOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isFailingExecution(exec) {
  return numeric(exec.failed_tests) > 0 || FAILED_CONCLUSIONS.has(exec.conclusion);
}

export function isGreenExecution(exec) {
  return (
    exec.conclusion === "success" &&
    numeric(exec.total_tests) > 0 &&
    numeric(exec.failed_tests) === 0
  );
}

function sortExecutions(executions) {
  return [...executions].sort((a, b) => {
    const delta = toDate(a.executed_at).getTime() - toDate(b.executed_at).getTime();
    if (delta !== 0) return delta;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

function neutral(input, cycle, inherited, evidenceBase = {}) {
  const runs = input.executions.length;
  return {
    sha: input.sha,
    cycle,
    phase_hint: "unknown",
    conclusion: "neutral",
    // Un commit sin ejecuciones debe verse "unknown" para el grafo, nunca rojo.
    test_count: 0,
    coverage: null,
    confidence: "high",
    evidence: {
      runs,
      red_runs: 0,
      green_runs: 0,
      first_failure_at: null,
      first_green_at: null,
      last_run_at: null,
      inherited_runs: inherited,
      is_merge: input.parentCount >= 2,
      tests_changed: input.testNamesChanged ?? null,
      ...evidenceBase,
    },
  };
}

/**
 * @param {{sha: string, message: string, parentCount: number,
 *          executions: Array<object>, inheritedExecutions?: number,
 *          testNamesChanged?: boolean|null,
 *          hasTestResultsForComparison?: boolean}} input
 */
export function classifyCommitCycle(input) {
  const executions = sortExecutions(input.executions ?? []);
  const inherited = Math.max(0, input.inheritedExecutions ?? 0);
  const isMerge = input.parentCount >= 2;

  const redRuns = executions.filter(isFailingExecution);
  const greenRuns = executions.filter(isGreenExecution);
  const firstFailure = redRuns.length ? toIso(redRuns[0].executed_at) : null;
  const firstGreen = greenRuns.length ? toIso(greenRuns[0].executed_at) : null;
  const lastRun = executions.length
    ? toIso(executions[executions.length - 1].executed_at)
    : null;

  const baseEvidence = {
    runs: executions.length,
    red_runs: redRuns.length,
    green_runs: greenRuns.length,
    first_failure_at: firstFailure,
    first_green_at: firstGreen,
    last_run_at: lastRun,
    inherited_runs: inherited,
    is_merge: isMerge,
    tests_changed: input.testNamesChanged ?? null,
  };

  if (executions.length === 0) {
    if (isMerge) return neutral(input, "merge", inherited, baseEvidence);
    if (inherited > 0) return neutral(input, "no-tests-local", inherited, baseEvidence);
    return neutral(input, "no-tests", inherited, baseEvidence);
  }

  const last = executions[executions.length - 1];

  if (isFailingExecution(last)) {
    return {
      sha: input.sha,
      cycle: "failing",
      phase_hint: "red",
      conclusion: "failure",
      test_count: numeric(last.total_tests),
      coverage: coverageOf(last.coverage),
      confidence: "high",
      evidence: baseEvidence,
    };
  }

  if (isGreenExecution(last)) {
    const hadRed = redRuns.length > 0;

    if (hadRed) {
      return {
        sha: input.sha,
        cycle: isMerge ? "merge" : "red-green",
        phase_hint: "green",
        conclusion: "success",
        test_count: numeric(last.total_tests),
        coverage: coverageOf(last.coverage),
        confidence: "high",
        evidence: {
          ...baseEvidence,
          // La secuencia rojo -> verde dentro del mismo commit se conserva
          // aunque el grafo solo pueda dibujar un estado por commit.
          first_failure_at: firstFailure,
          first_green_at: firstGreen,
        },
      };
    }

    if (isMerge) {
      return {
        sha: input.sha,
        cycle: "merge",
        phase_hint: "green",
        conclusion: "success",
        test_count: numeric(last.total_tests),
        coverage: coverageOf(last.coverage),
        confidence: "high",
        evidence: baseEvidence,
      };
    }

    if (REFACTOR_MESSAGE.test(input.message ?? "")) {
      const verifiable =
        input.testNamesChanged === false &&
        input.hasTestResultsForComparison === true;

      if (verifiable) {
        return {
          sha: input.sha,
          cycle: "refactor",
          phase_hint: "refactor",
          conclusion: "success",
          test_count: numeric(last.total_tests),
          coverage: coverageOf(last.coverage),
          confidence: "high",
          evidence: baseEvidence,
        };
      }

      // El refactor NO se afirma sin evidencia: es solo un candidato.
      return {
        sha: input.sha,
        cycle: "refactor-candidate",
        phase_hint: "green",
        conclusion: "success",
        test_count: numeric(last.total_tests),
        coverage: coverageOf(last.coverage),
        confidence: "low",
        evidence: baseEvidence,
      };
    }

    return {
      sha: input.sha,
      cycle: "green-only",
      phase_hint: "green",
      conclusion: "success",
      test_count: numeric(last.total_tests),
      coverage: coverageOf(last.coverage),
      confidence: "high",
      evidence: baseEvidence,
    };
  }

  // La última ejecución no es fallo ni verde (p. ej. cancelada).
  return {
    sha: input.sha,
    cycle: "inconclusive",
    phase_hint: "unknown",
    conclusion: "neutral",
    test_count: numeric(last.total_tests),
    coverage: coverageOf(last.coverage),
    confidence: "low",
    evidence: baseEvidence,
  };
}
