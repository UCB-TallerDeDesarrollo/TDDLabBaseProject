/**
 * Auditoría de ciclos TDD: compara la clasificación "actual" (la que calcula
 * el grafo vivo de DB-B) contra la propuesta (el clasificador puro).
 *
 * Port a JavaScript de `server/src/scripts/tddDb/lib/cycleAudit.ts`.
 * Solo lectura: construye reportes, no escribe nada.
 */
import { classifyCommitCycle } from "./tddCycleClassifier.js";
import { projectCommitColor } from "./graphParity.js";

/**
 * @typedef {"refactor-por-diff" | "secuencia-colapsada" |
 *           "sin-ejecucion-marcado-rojo" | "fuga-entre-ramas" |
 *           "merge-mal-etiquetado" | "color-distinto"} AuditReason
 */

/** Punto que devuelve el grafo vivo (`getTDDCyclesGraph`). */
/**
 * @typedef {{commit_sha: string, message?: string, test_conclusion?: string|null,
 *            passed_tests?: number|null, failed_tests?: number|null,
 *            coverage?: number|null, phase_hint?: string}} CurrentCyclePoint
 */

function bump(bag, key) {
  bag[key] = (bag[key] ?? 0) + 1;
}

function currentColor(point) {
  const passed = Number(point.passed_tests ?? 0);
  const failed = Number(point.failed_tests ?? 0);
  const coverage =
    point.coverage === null || point.coverage === undefined
      ? null
      : Number(point.coverage);
  return projectCommitColor({
    coverage,
    test_count: passed + failed,
    conclusion: point.test_conclusion,
    commit: { message: point.message ?? "" },
  });
}

function proposedColor(row, c) {
  return projectCommitColor({
    coverage: c.coverage,
    test_count: c.test_count,
    conclusion: c.conclusion,
    commit: { message: row.message ?? "" },
  });
}

/**
 * @returns {AuditReason}
 */
function divergenceReason(row, current, proposed) {
  const isMerge = row.parent_shas.length >= 2;
  const noRuns = row.executions.length === 0;
  const currentPhase = current.phase_hint ?? "unknown";

  if (isMerge && currentPhase !== "unknown") return "merge-mal-etiquetado";
  if (noRuns && currentPhase === "red") return "sin-ejecucion-marcado-rojo";
  if (noRuns && row.inherited_executions > 0) return "fuga-entre-ramas";
  if (
    proposed.cycle === "red-green" &&
    (currentPhase === "red" || currentPhase === "unknown")
  ) {
    return "secuencia-colapsada";
  }
  if (currentPhase === "refactor" && proposed.cycle !== "refactor") {
    return "refactor-por-diff";
  }
  return "color-distinto";
}

/**
 * @param {{projectId: string, branchId: string, branchName: string,
 *          current: CurrentCyclePoint[],
 *          rows: Array<{sha: string, message: string, parent_shas: string[],
 *                       executions: Array<object>, inherited_executions: number}>,
 *          classify?: Function, now?: () => Date}} params
 */
export function buildAuditReport(params) {
  const classify = params.classify ?? classifyCommitCycle;
  const currentBySha = new Map();
  for (const point of params.current) currentBySha.set(point.commit_sha, point);

  const summary = {
    current: {},
    proposed: {},
    colors: { current: {}, proposed: {} },
    divergences: 0,
    divergence_rate: 0,
  };
  const divergences = [];

  for (const row of params.rows) {
    const proposed = classify({
      sha: row.sha,
      message: row.message,
      parentCount: row.parent_shas.length,
      executions: row.executions,
      inheritedExecutions: row.inherited_executions,
      testNamesChanged: null,
      hasTestResultsForComparison: false,
    });

    bump(summary.proposed, proposed.phase_hint);

    const current = currentBySha.get(row.sha);
    if (!current) continue;

    const currentPhase = current.phase_hint ?? "unknown";
    bump(summary.current, currentPhase);
    const cColor = currentColor(current);
    const pColor = proposedColor(row, proposed);
    bump(summary.colors.current, cColor);
    bump(summary.colors.proposed, pColor);

    if (currentPhase !== proposed.phase_hint || cColor !== pColor) {
      summary.divergences += 1;
      divergences.push({
        sha: row.sha,
        message: row.message,
        current: { phase: currentPhase, color: cColor },
        proposed: {
          phase: proposed.phase_hint,
          cycle: proposed.cycle,
          color: pColor,
          confidence: proposed.confidence,
        },
        reason: divergenceReason(row, current, proposed),
        evidence: {
          runs: proposed.evidence.runs,
          red_runs: proposed.evidence.red_runs,
          green_runs: proposed.evidence.green_runs,
          inherited_runs: proposed.evidence.inherited_runs,
          is_merge: proposed.evidence.is_merge,
          tests_changed: proposed.evidence.tests_changed,
        },
      });
    }
  }

  const analyzed = Math.max(
    params.rows.length,
    Object.values(summary.current).reduce((a, b) => a + b, 0)
  );
  summary.divergence_rate = analyzed > 0 ? summary.divergences / analyzed : 0;

  return {
    project_id: params.projectId,
    branch: params.branchName,
    branch_id: params.branchId,
    generated_at: (params.now ?? (() => new Date()))().toISOString(),
    commits_analyzed: analyzed,
    summary,
    divergences,
  };
}
