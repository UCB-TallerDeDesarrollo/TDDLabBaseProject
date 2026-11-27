#!/usr/bin/env node
/**
 * `tdd:db:cycles` — diagnóstico de solo lectura de la clasificación de
 * ciclos TDD en DB-B.
 *
 * Uso:
 *   npm run tdd:db:cycles -- --audit [--project <id|owner/repo>] [--branch <nombre>] [--json]
 *   npm run tdd:db:cycles -- --orphans [--project <id|owner/repo>] [--json]
 *
 * Garantías:
 *   - SOLO SELECT: sin UPDATE/INSERT/DELETE, sin migraciones, sin locks.
 *   - Nunca mezcla ramas: cada consulta está acotada a un branch_id.
 *   - `--audit` compara el clasificador vivo de DB-B con el propuesto,
 *     incluyendo el color que el frontend pintaría.
 *
 * Port a JavaScript de `server/src/scripts/tddDb/cycles.ts` (repo TDDLab),
 * adaptado a TddLabBaseProject: habla directo con Neon vía `script/lib/db.js`
 * en lugar del pool del servidor.
 */
import {
  query,
  closePool,
  missingConfigMessage,
  assertBranchSupportSchema,
} from "./db.js";
import { readBranchCommits, getTDDCyclesGraph } from "./branchHistory.js";
import { buildAuditReport } from "./cycleAudit.js";

export const USAGE = `tdd:db:cycles (solo lectura)

  --audit                 Compara la clasificación actual de DB-B con la propuesta
  --orphans               Reporta ejecuciones/commits que el grafo no puede ver
  --project <id|owner/repo>
  --branch <nombre>       Por defecto: todas las ramas vivas del proyecto
  --json                  Salida legible por máquina
  --help
`;

export function parseArgs(argv) {
  const options = { audit: false, orphans: false, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--audit":
        options.audit = true;
        break;
      case "--orphans":
        options.orphans = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--project":
        options.project = argv[++i];
        break;
      case "--branch":
        options.branch = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.audit && !options.orphans) {
    options.audit = true;
  }

  return options;
}

async function resolveProjects(projectArg) {
  if (!projectArg) {
    const { rows } = await query(
      `SELECT id::text AS id, name, link, github_user FROM project ORDER BY id`
    );
    return rows;
  }

  if (/^\d+$/.test(projectArg)) {
    const { rows } = await query(
      `SELECT id::text AS id, name, link, github_user FROM project WHERE id = $1`,
      [projectArg]
    );
    return rows;
  }

  const match = /^([^/]+)\/([^/]+)$/.exec(projectArg);
  if (!match) {
    throw new Error(`Invalid --project value: ${projectArg}`);
  }
  const link = `https://github.com/${match[1]}/${match[2]}`;
  const { rows } = await query(
    `SELECT id::text AS id, name, link, github_user
       FROM project
      WHERE lower(regexp_replace(link, '\\.git/?$', '', 'i')) = lower($1)`,
    [link]
  );
  return rows;
}

async function resolveBranches(projectId, branchArg) {
  if (branchArg) {
    const { rows } = await query(
      `SELECT id::text AS id, project_id::text AS project_id, name
         FROM branch
        WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [projectId, branchArg]
    );
    return rows;
  }

  const { rows } = await query(
    `SELECT id::text AS id, project_id::text AS project_id, name
       FROM branch
      WHERE project_id = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [projectId]
  );
  return rows;
}

export async function auditBranch(projectId, branch) {
  const current = await getTDDCyclesGraph(query, projectId, branch.id);
  const rows = await readBranchCommits(query, projectId, branch.id);

  return buildAuditReport({
    projectId,
    branchId: branch.id,
    branchName: branch.name,
    current,
    rows,
  });
}

/**
 * Registros huérfanos: todo lo que el grafo NO puede mostrar.
 * Solo SELECT.
 */
export async function findOrphans(projectId) {
  const projects = await resolveProjects(projectId);
  const reports = [];

  for (const project of projects) {
    const scope = [project.id];

    const withoutCommit = await query(
      `SELECT id::text, project_id::text, branch_id::text, executed_at, conclusion
         FROM test_execution
        WHERE project_id = $1 AND commit_sha IS NULL
        ORDER BY id`,
      scope
    );
    const withoutBranch = await query(
      `SELECT id::text, project_id::text, commit_sha, executed_at, conclusion
         FROM test_execution
        WHERE project_id = $1 AND branch_id IS NULL
        ORDER BY id`,
      scope
    );
    const commitsWithoutBranch = await query(
      `SELECT c.sha, c.committed_at
         FROM git_commit c
         LEFT JOIN branch_commit bc
           ON bc.project_id = c.project_id AND bc.commit_sha = c.sha
        WHERE c.project_id = $1 AND bc.commit_sha IS NULL
        ORDER BY c.committed_at`,
      scope
    );
    const onDeletedBranch = await query(
      `SELECT te.id::text, b.name AS branch_name, b.deleted_at, te.commit_sha
         FROM test_execution te
         JOIN branch b ON b.id = te.branch_id AND b.project_id = te.project_id
        WHERE te.project_id = $1 AND b.deleted_at IS NOT NULL
        ORDER BY te.id`,
      scope
    );
    const outsideBranchCommit = await query(
      `SELECT te.id::text, te.branch_id::text, te.commit_sha
         FROM test_execution te
         LEFT JOIN branch_commit bc
           ON bc.branch_id = te.branch_id
          AND bc.project_id = te.project_id
          AND bc.commit_sha = te.commit_sha
        WHERE te.project_id = $1
          AND te.branch_id IS NOT NULL
          AND te.commit_sha IS NOT NULL
          AND bc.commit_sha IS NULL
        ORDER BY te.id`,
      scope
    );
    const headMarker = await query(
      `SELECT COUNT(*)::int AS n FROM test_execution
        WHERE project_id = $1 AND commit_sha = 'HEAD'`,
      scope
    );

    reports.push({
      project: project.id,
      generated_at: new Date().toISOString(),
      executions_without_commit: withoutCommit.rows,
      executions_without_branch: withoutBranch.rows,
      commits_without_branch: commitsWithoutBranch.rows,
      executions_on_deleted_branch: onDeletedBranch.rows,
      executions_outside_branch_commit: outsideBranchCommit.rows,
      head_marker_executions: Number(headMarker.rows[0]?.n ?? 0),
    });
  }

  return projectId ? reports[0] : reports;
}

export async function runCyclesCli(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  let options;

  try {
    options = parseArgs(argv);
  } catch (error) {
    log(String(error.message ?? error));
    log(USAGE);
    return 1;
  }

  if (options.help) {
    log(USAGE);
    return 0;
  }

  try {
    if (options.orphans) {
      const report = await findOrphans(options.project);
      if (options.json) {
        log(JSON.stringify(report, null, 2));
      } else {
        const list = Array.isArray(report) ? report : [report];
        for (const entry of list) {
          log(
            `orphans project=${entry.project} ` +
              `sin_commit=${entry.executions_without_commit.length} ` +
              `sin_rama=${entry.executions_without_branch.length} ` +
              `commits_sin_rama=${entry.commits_without_branch.length} ` +
              `rama_borrada=${entry.executions_on_deleted_branch.length} ` +
              `fuera_de_branch_commit=${entry.executions_outside_branch_commit.length} ` +
              `head_marker=${entry.head_marker_executions}`
          );
        }
      }
    }

    if (options.audit) {
      const projects = await resolveProjects(options.project);
      if (projects.length === 0) {
        log("No project matched the given selector.");
        return 1;
      }

      const reports = [];
      for (const project of projects) {
        const branches = await resolveBranches(project.id, options.branch);
        for (const branch of branches) {
          reports.push(await auditBranch(project.id, branch));
        }
      }

      if (options.json) {
        log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
      } else {
        for (const report of reports) {
          log(
            `audit project=${report.project_id} branch=${report.branch} ` +
              `commits=${report.commits_analyzed} ` +
              `divergencias=${report.summary.divergences} ` +
              `tasa=${(report.summary.divergence_rate * 100).toFixed(1)}%`
          );
          for (const item of report.divergences) {
            log(
              `  - ${item.sha.slice(0, 10)} actual=${item.current.phase}/${item.current.color}` +
                ` propuesto=${item.proposed.phase}/${item.proposed.color}` +
                ` motivo=${item.reason}`
            );
          }
        }
      }
    }

    return 0;
  } catch (error) {
    log(`Error: ${error.message ?? String(error)}`);
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    // Preflight de solo lectura: `cycles` necesita el esquema de DB-B.
    // Si la URL apunta a la base de la aplicación, avisamos antes de que
    // falle una consulta con un "relation does not exist" críptico.
    if (!argv.includes("--help") && !argv.includes("-h")) {
      await assertBranchSupportSchema();
    }
    return await runCyclesCli(argv);
  } catch (error) {
    console.error(`Error: ${error?.message ?? String(error)}`);
    return 1;
  } finally {
    await closePool().catch(() => {});
  }
}

export { missingConfigMessage };
