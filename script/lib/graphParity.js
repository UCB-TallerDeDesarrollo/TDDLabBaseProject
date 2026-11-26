/**
 * Réplica de la decisión de color del grafo que vive en el frontend
 * (`TDDLineChart.tsx` / `TDDBoard.tsx` del repo TDDLab). NO la importa el
 * frontend: existe para que `--audit` compare el color que un usuario vería.
 *
 * Port a JavaScript de `server/src/scripts/tddDb/lib/graphParity.ts`.
 */

/** @typedef {"red" | "green" | "blue" | "black"} GraphColor */

/**
 * @param {{coverage?: number|null, test_count?: number|null,
 *          conclusion?: string|null, commit: {message: string}}} commit
 * @returns {GraphColor}
 */
export function projectCommitColor(commit) {
  if (
    !commit ||
    typeof commit !== "object" ||
    !commit.commit ||
    typeof commit.commit.message !== "string"
  ) {
    return "red";
  }

  const { coverage, test_count, conclusion } = commit;

  // Desconocido: el cliente pinta negro antes que cualquier otra regla.
  if (coverage === undefined || coverage === null) return "black";

  const hasNoTestsOrCoverageFailed =
    test_count === 0 ||
    test_count === undefined ||
    test_count === null ||
    coverage === 0 ||
    conclusion === "failure";

  if (hasNoTestsOrCoverageFailed) return "red";

  const isRefactor = /\brefactor(\w*)\b/i.test(commit.commit.message);
  return isRefactor ? "blue" : "green";
}
