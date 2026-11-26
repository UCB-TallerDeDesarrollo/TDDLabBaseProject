/**
 * Lectura de datos de DB-B para el Script B (ciclos TDD).
 *
 * Port a JavaScript de:
 *  - `BranchSupportCommitHistoryReader.readBranchCommits` (repo TDDLab)
 *  - `BranchSupportRepository.getTDDCyclesGraph` (la clasificación "actual"
 *    con la que `--audit` compara)
 *
 * SOLO SELECT: no hay INSERT/UPDATE/DELETE/locks en este archivo.
 */

/**
 * Lee todos los commits de una rama con sus ejecuciones (en la rama) y el
 * conteo de ejecuciones heredadas de otras ramas.
 *
 * Unidad de clasificación: (project_id, branch_id, commit_sha) con TODAS sus
 * ejecuciones ordenadas por executed_at (nunca LIMIT 1).
 *
 * @returns {Promise<Array<{sha: string, committed_at: any, message: string,
 *   author: string, author_email: string|null, additions: number,
 *   deletions: number, changed_files: number, parent_shas: string[],
 *   executions: Array<object>, inherited_executions: number}>>}
 */
export async function readBranchCommits(query, projectId, branchId) {
  const { rows } = await query(
    `SELECT c.sha,
            c.committed_at,
            c.message,
            c.author,
            c.author_email,
            c.additions,
            c.deletions,
            c.changed_files,
            COALESCE(p.parent_shas, ARRAY[]::varchar[]) AS parent_shas,
            COALESCE(e.executions, '[]'::json)          AS executions,
            COALESCE(x.inherited, 0)::int               AS inherited_executions
       FROM branch_commit bc
       JOIN git_commit c
         ON c.project_id = bc.project_id AND c.sha = bc.commit_sha
       LEFT JOIN LATERAL (
         SELECT array_agg(cp.parent_sha ORDER BY cp.parent_order) AS parent_shas
           FROM commit_parent cp
          WHERE cp.project_id = c.project_id AND cp.commit_sha = c.sha
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', te.id,
                  'executed_at', te.executed_at,
                  'total_tests', te.total_tests,
                  'passed_tests', te.passed_tests,
                  'failed_tests', te.failed_tests,
                  'skipped_tests', te.skipped_tests,
                  'error_tests', te.error_tests,
                  'coverage', te.coverage,
                  'conclusion', te.conclusion
                ) ORDER BY te.executed_at ASC, te.id ASC) AS executions
            FROM test_execution te
           WHERE te.project_id = c.project_id
             AND te.commit_sha = c.sha
             AND te.branch_id = bc.branch_id
       ) e ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS inherited
           FROM test_execution te2
          WHERE te2.project_id = c.project_id
            AND te2.commit_sha = c.sha
            AND te2.branch_id IS DISTINCT FROM bc.branch_id
       ) x ON true
      WHERE bc.project_id = $1 AND bc.branch_id = $2
      ORDER BY c.committed_at DESC, c.sha DESC`,
    [projectId, branchId]
  );

  return rows.map((r) => ({
    sha: r.sha,
    committed_at: r.committed_at,
    message: r.message ?? "",
    author: r.author,
    author_email: r.author_email ?? null,
    additions: Number(r.additions ?? 0),
    deletions: Number(r.deletions ?? 0),
    changed_files: Number(r.changed_files ?? 0),
    parent_shas: r.parent_shas ?? [],
    executions: r.executions ?? [],
    inherited_executions: Number(r.inherited_executions ?? 0),
  }));
}

/**
 * La clasificación ACTUAL del grafo vivo (la que hoy ve el usuario).
 * Réplica exacta de `getTDDCyclesGraph`: última ejecución por commit +
 * booleano global `previousHadFailures` que NO se resetea por rama.
 *
 * @returns {Promise<Array<{commit_sha: string, message: string,
 *   test_conclusion: string|null, passed_tests: number, failed_tests: number,
 *   coverage: number|null, phase_hint: "red"|"green"|"refactor"|"unknown"}>>}
 */
export async function getTDDCyclesGraph(query, projectId, branchId) {
  let sql = `
    SELECT c.sha as commit_sha, c.committed_at, c.message,
           c.additions, c.deletions, c.total_changes,
           te.conclusion as test_conclusion,
           te.passed_tests, te.failed_tests, te.coverage
    FROM git_commit c
  `;
  const values = [projectId];

  if (branchId) {
    sql += `
      INNER JOIN branch_commit bc ON c.project_id = bc.project_id AND c.sha = bc.commit_sha
      LEFT JOIN LATERAL (
        SELECT te2.conclusion, te2.passed_tests, te2.failed_tests, te2.coverage
        FROM test_execution te2
        WHERE te2.project_id = c.project_id AND te2.commit_sha = c.sha
        ORDER BY te2.executed_at DESC LIMIT 1
      ) te ON true
      WHERE c.project_id = $1 AND bc.branch_id = $2
    `;
    values.push(branchId);
  } else {
    sql += `
      LEFT JOIN LATERAL (
        SELECT te2.conclusion, te2.passed_tests, te2.failed_tests, te2.coverage
        FROM test_execution te2
        WHERE te2.project_id = c.project_id AND te2.commit_sha = c.sha
        ORDER BY te2.executed_at DESC LIMIT 1
      ) te ON true
      WHERE c.project_id = $1
    `;
  }

  sql += ` ORDER BY c.committed_at ASC;`;

  const { rows } = await query(sql, values);

  let previousHadFailures = false;

  return rows.map((r) => {
    const failed = Number(r.failed_tests || 0);
    const passed = Number(r.passed_tests || 0);
    const additions = Number(r.additions || 0);
    const deletions = Number(r.deletions || 0);

    let phase = "unknown";

    if (r.test_conclusion === "failure" || failed > 0) {
      phase = "red";
      previousHadFailures = true;
    } else if (r.test_conclusion === "success" && passed > 0) {
      if (previousHadFailures) {
        phase = "green";
        previousHadFailures = false;
      } else if (additions > 0 || deletions > 0) {
        phase = "refactor";
      } else {
        phase = "green";
      }
    }

    return {
      commit_sha: r.commit_sha,
      committed_at: r.committed_at,
      message: r.message,
      additions,
      deletions,
      total_changes: Number(r.total_changes || additions + deletions),
      test_conclusion: r.test_conclusion,
      passed_tests: passed,
      failed_tests: failed,
      coverage: r.coverage !== null ? Number(r.coverage) : null,
      phase_hint: phase,
    };
  });
}
