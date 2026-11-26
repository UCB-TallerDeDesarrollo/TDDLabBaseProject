#!/usr/bin/env node
/**
 * `tdd:db:reach` — reconciliación de alcanzabilidad de commits por rama (Script A).
 *
 * Garantiza que `branch_commit` contenga TODOS los commits alcanzables desde el
 * HEAD de la rama (no solo los registrados por evento), corrige
 * `branch.head_commit_sha` desfasado y completa `commit_parent` en merges.
 *
 * Uso:
 *   npm run tdd:db:reach                    # dry-run (NO escribe nada)
 *   npm run tdd:db:reach -- --apply         # escribe en DB-B
 *   npm run tdd:db:reach -- --json          # salida legible por máquina
 *   npm run tdd:db:reach -- --project owner/repo [--branch nombre] [--max-commits N]
 *
 * Reglas:
 *   - Dry-run POR DEFECTO: sin `--apply` no hay ninguna escritura.
 *   - Idempotente: re-ejecutar con `--apply` no inserta nada duplicado
 *     (ON CONFLICT DO NOTHING en todas las tablas).
 *   - NUNCA borra: los commits que dejan de ser alcanzables se reportan como
 *     `stale`, nunca se eliminan.
 *   - `branch_commit` significa "alcanzable desde", no "creado en": un commit
 *     creado en otra rama aparece aquí tras el merge (eso es lo correcto).
 *   - Orden por FK: project → git_commit → commit_parent → branch →
 *     branch_commit → branch.head_commit_sha.
 *   - Proyecto/rama se CREAN si faltan (adaptación a TddLabBaseProject, donde
 *     no existen los scripts de registro del otro equipo).
 *
 * Port a JavaScript de `VSCodeExtension/resources/tddBridge/reach.mjs`
 * (repo TDDLab), cambiando el transporte HTTP por escritura directa en DB-B.
 */
import { query, getPool, closePool, missingConfigMessage } from "./db.js";
import {
  resolveRepoRoot,
  currentBranch,
  readReachable,
  readRemoteUrl,
  parseRemoteUrl,
  readCommitMeta,
  readCommitStats,
} from "./gitTopology.js";

export const EXIT = { OK: 0, CONFIG: 1, RUNTIME: 2 };

export const USAGE = `tdd:db:reach (dry-run por defecto)

  --apply                 Escribe en DB-B (sin él, solo reporta)
  --json                  Salida legible por máquina
  --project <owner/repo>  Override del proyecto (default: remote origin)
  --branch <nombre>       Etiqueta de la rama (default: rama actual de HEAD)
  --max-commits <n>       Limita los commits leídos de git (default 1000)
  --help
`;

export function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    help: false,
    project: undefined,
    branch: undefined,
    maxCommits: 1000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.apply = true;
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
      case "--max-commits":
        options.maxCommits = Number(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    options.maxCommits !== undefined &&
    (!Number.isInteger(options.maxCommits) || options.maxCommits < 0)
  ) {
    throw new Error("--max-commits must be a non-negative integer");
  }

  return options;
}

export function parseProjectArg(value) {
  const match = /^([^/]+)\/([^/]+)$/.exec(value || "");
  if (!match) throw new Error("--project must be owner/repo");
  return {
    owner: match[1],
    name: match[2].replace(/\.git$/, ""),
    link: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`,
  };
}

/** Busca el proyecto por link (case-insensitive, acepta sufijo .git). */
async function findProject(link) {
  const { rows } = await query(
    `SELECT id::text AS id, name, link, github_user
       FROM project
      WHERE lower(regexp_replace(link, '\\.git/?$', '', 'i')) = lower($1)`,
    [link]
  );
  return rows[0] ?? null;
}

async function findBranch(projectId, name) {
  const { rows } = await query(
    `SELECT id::text AS id, name, head_commit_sha, deleted_at
       FROM branch
      WHERE project_id = $1 AND name = $2`,
    [projectId, name]
  );
  return rows[0] ?? null;
}

/**
 * Calcula el plan de reconciliación con SOLO SELECTs.
 * No escribe nada: sirve tanto para dry-run como para --apply.
 *
 * @returns {Promise<object>} plan
 */
export async function computePlan({ repository, branchName, reach }) {
  const shas = reach.commits.map((c) => c.sha);
  const reachableSet = new Set(shas);

  const project = await findProject(repository.link);

  const plan = {
    project_exists: Boolean(project),
    project_id: project?.id ?? null,
    branch_exists: false,
    branch_id: null,
    branch_deleted: false,
    branch_head: null,
    existing_commits: [],
    existing_branch_commits: [],
    existing_edges: [],
    reachable: shas,
    head: reach.head,
    truncated: reach.truncated,
    shallow: reach.shallow,
  };

  if (project) {
    const branch = await findBranch(project.id, branchName);
    if (branch) {
      plan.branch_exists = true;
      plan.branch_id = branch.id;
      plan.branch_deleted = branch.deleted_at !== null;
      plan.branch_head = branch.head_commit_sha;

      const [commitsRes, branchCommitsRes, edgesRes] = await Promise.all([
        query(
          `SELECT sha FROM git_commit WHERE project_id = $1 AND sha = ANY($2)`,
          [project.id, shas]
        ),
        query(
          `SELECT commit_sha FROM branch_commit WHERE project_id = $1 AND branch_id = $2`,
          [project.id, branch.id]
        ),
        query(
          `SELECT commit_sha, parent_sha FROM commit_parent
            WHERE project_id = $1 AND commit_sha = ANY($2)`,
          [project.id, shas]
        ),
      ]);
      plan.existing_commits = commitsRes.rows.map((r) => r.sha);
      plan.existing_branch_commits = branchCommitsRes.rows.map((r) => r.commit_sha);
      plan.existing_edges = edgesRes.rows;
    } else {
      // Sin rama registrada: TODOS los alcanzables faltan en git_commit/
      // branch_commit (proyecto sin historial de este repo).
      const commitsRes = await query(
        `SELECT sha FROM git_commit WHERE project_id = $1 AND sha = ANY($2)`,
        [project.id, shas]
      );
      plan.existing_commits = commitsRes.rows.map((r) => r.sha);
    }
  }

  const existingCommitsSet = new Set(plan.existing_commits);
  const existingBranchCommitsSet = new Set(plan.existing_branch_commits);
  const existingEdgeSet = new Set(
    plan.existing_edges.map((e) => `${e.commit_sha} ${e.parent_sha}`)
  );

  // Commits alcanzables ausentes de git_commit.
  plan.missing_git_commits = shas.filter((s) => !existingCommitsSet.has(s));

  // Commits alcanzables ausentes de branch_commit (para la rama evaluada).
  plan.missing_branch_commits = plan.branch_exists
    ? shas.filter((s) => !existingBranchCommitsSet.has(s))
    : [...shas];

  // Aristas de parentesco ausentes. Solo aristas cuyo padre sea alcanzable o
  // ya esté en git_commit: evita bordes colgantes con --max-commits/shallow.
  plan.missing_edges = [];
  plan.skipped_edges = 0;
  for (const commit of reach.commits) {
    for (let order = 0; order < commit.parent_shas.length; order += 1) {
      const parentSha = commit.parent_shas[order];
      if (parentSha === commit.sha) continue;
      if (existingEdgeSet.has(`${commit.sha} ${parentSha}`)) continue;
      const parentKnown =
        reachableSet.has(parentSha) || existingCommitsSet.has(parentSha);
      if (!parentKnown) {
        plan.skipped_edges += 1;
        continue;
      }
      plan.missing_edges.push({
        commit_sha: commit.sha,
        parent_sha: parentSha,
        parent_order: order + 1,
      });
    }
  }

  // Rama: commits alcanzables que ya están asociados.
  plan.already_in_branch = plan.branch_exists
    ? shas.length - plan.missing_branch_commits.length
    : 0;

  // Stale: registrados en la rama pero ya NO alcanzables (p. ej. rebase).
  plan.stale = plan.branch_exists
    ? plan.existing_branch_commits.filter((s) => !reachableSet.has(s))
    : [];

  plan.head_changed = Boolean(
    plan.branch_exists && plan.branch_head !== reach.head
  );

  plan.partial = reach.truncated || reach.shallow;
  plan.would_create_project = !plan.project_exists;
  plan.would_create_branch = plan.project_exists && !plan.branch_exists;

  return plan;
}

/**
 * Aplica el plan en UNA transacción. Solo se llama con `--apply`.
 * Idempotente: todas las inserciones usan ON CONFLICT DO NOTHING.
 * Nunca DELETE/UPDATE salvo el head de la rama (si está desfasado).
 * Si no hay nada que hacer NO abre transacción.
 */
export async function applyPlan(plan, repository, branchName, reach, deps) {
  const counts = {
    git_commits: 0,
    parent_edges: 0,
    branch_commits: 0,
    project_created: false,
    branch_created: false,
    head_updated: false,
  };

  // Guard 1: rama marcada como borrada -> ni transacción.
  if (plan.branch_deleted) {
    throw new Error(`La rama ${branchName} está marcada como borrada en DB-B`);
  }

  // Guard 2: ya reconciliado -> no se abre transacción (noop barato).
  const needsWork =
    plan.missing_git_commits.length > 0 ||
    plan.missing_edges.length > 0 ||
    plan.missing_branch_commits.length > 0 ||
    plan.head_changed ||
    !plan.project_exists ||
    !plan.branch_exists;
  if (!needsWork) return counts;

  const connect = deps.connect ?? (() => getPool().connect());
  const git = deps.git ?? {};
  const client = await connect();

  try {
    await client.query("BEGIN");

    // 1. Proyecto (find-or-create).
    let projectId = plan.project_id;
    if (!projectId) {
      const { rows } = await client.query(
        `INSERT INTO project (name, link, github_user)
         VALUES ($1, $2, $3)
         ON CONFLICT (github_user, link) DO NOTHING
         RETURNING id::text AS id`,
        [repository.name, repository.link, repository.owner]
      );
      if (rows[0]) {
        projectId = rows[0].id;
        counts.project_created = true;
      } else {
        // Rerun concurrente: relee con el MISMO cliente de la transacción.
        const again = await client.query(
          `SELECT id::text AS id FROM project
            WHERE lower(regexp_replace(link, '\\.git/?$', '', 'i')) = lower($1)`,
          [repository.link]
        );
        if (!again.rows[0]) throw new Error(`No se pudo crear/ubicar el proyecto ${repository.link}`);
        projectId = again.rows[0].id;
      }
    }

    // 2. git_commit: solo los que faltan (los existentes NO se tocan).
    for (const sha of plan.missing_git_commits) {
      const meta = readCommitMeta(git.repoRoot, sha);
      const stats = readCommitStats(
        git.repoRoot,
        sha,
        meta.parent_shas[0] ?? null
      );
      const res = await client.query(
        `INSERT INTO git_commit
           (project_id, sha, author, author_email, message, committed_at,
            additions, deletions, changed_files)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (project_id, sha) DO NOTHING`,
        [
          projectId,
          meta.sha,
          meta.author,
          meta.author_email,
          meta.message,
          meta.committed_at,
          stats.additions,
          stats.deletions,
          stats.changed_files,
        ]
      );
      counts.git_commits += res.rowCount ?? 0;
    }

    // 3. commit_parent (parent_order 1..n; soporta merges multi-padre).
    for (const edge of plan.missing_edges) {
      const res = await client.query(
        `INSERT INTO commit_parent (project_id, commit_sha, parent_sha, parent_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, commit_sha, parent_sha) DO NOTHING`,
        [projectId, edge.commit_sha, edge.parent_sha, edge.parent_order]
      );
      counts.parent_edges += res.rowCount ?? 0;
    }

    // 4. branch (find-or-create; head al final por la FK a git_commit).
    let branchId = plan.branch_id;
    if (!branchId) {
      const { rows } = await client.query(
        `INSERT INTO branch (project_id, name)
         VALUES ($1, $2)
         ON CONFLICT (project_id, name) DO NOTHING
         RETURNING id::text AS id`,
        [projectId, branchName]
      );
      if (rows[0]) {
        branchId = rows[0].id;
        counts.branch_created = true;
      } else {
        const again = await client.query(
          `SELECT id::text AS id, deleted_at
             FROM branch WHERE project_id = $1 AND name = $2`,
          [projectId, branchName]
        );
        if (!again.rows[0] || again.rows[0].deleted_at !== null) {
          throw new Error(`No se pudo crear/ubicar la rama ${branchName}`);
        }
        branchId = again.rows[0].id;
      }
    }

    // 5. branch_commit: alcanzable → asociado a la rama.
    for (const sha of plan.missing_branch_commits) {
      const res = await client.query(
        `INSERT INTO branch_commit (branch_id, project_id, commit_sha)
         VALUES ($1, $2, $3)
         ON CONFLICT (branch_id, commit_sha) DO NOTHING`,
        [branchId, projectId, sha]
      );
      counts.branch_commits += res.rowCount ?? 0;
    }

    // 6. head de la rama solo si está desfasado (único UPDATE del script).
    if (plan.head_changed || !plan.branch_exists) {
      const res = await client.query(
        `UPDATE branch
            SET head_commit_sha = $1
          WHERE id = $2
            AND project_id = $3
            AND (head_commit_sha IS DISTINCT FROM $1)`,
        [reach.head, branchId, projectId]
      );
      counts.head_updated = (res.rowCount ?? 0) > 0;
    }

    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

/**
 * Flujo principal. Exportado para poder probarlo sin invocar la CLI.
 *
 * @returns {Promise<{exitCode: number, result: object}>}
 */
export async function runReachCli(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const now = deps.now ?? (() => new Date());

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(`TDDLab reach: ${error.message}`);
    log(USAGE);
    return { exitCode: EXIT.CONFIG, result: { action: "error", reason: error.message } };
  }

  if (args.help) {
    log(USAGE);
    return { exitCode: EXIT.OK, result: { action: "help" } };
  }

  const finish = (result, exitCode = EXIT.OK) => {
    if (args.json) log(JSON.stringify(result, null, 2));
    else log(formatHuman(result));
    return { exitCode, result };
  };

  const git = deps.git ?? {};
  const repoRoot = git.repoRoot ?? resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    return finish({ action: "skipped", reason: "not-a-git-repository" });
  }
  git.repoRoot = repoRoot;
  deps.git = git;

  const branchName = args.branch || currentBranch(repoRoot);
  if (!branchName) {
    return finish({ action: "skipped", reason: "detached-head" });
  }

  let repository;
  try {
    repository = args.project
      ? parseProjectArg(args.project)
      : parseRemoteUrl(readRemoteUrl(repoRoot));
  } catch (error) {
    return finish(
      { action: "skipped", reason: "invalid-project", detail: error.message },
      EXIT.CONFIG
    );
  }
  if (!repository) {
    return finish({ action: "skipped", reason: "no-remote" });
  }

  const reach = readReachable(repoRoot, { maxCommits: args.maxCommits });
  if (reach.commits.length === 0) {
    return finish({
      action: "skipped",
      reason: "no-commits",
      project: repository.link,
      branch: branchName,
    });
  }

  let plan;
  try {
    plan = await computePlan({ repository, branchName, reach });
  } catch (error) {
    if (String(error.message).includes("Falta la URL")) {
      log(error.message);
      return {
        exitCode: EXIT.CONFIG,
        result: { action: "error", reason: "missing-database-url" },
      };
    }
    return finish(
      { action: "error", reason: error.message },
      EXIT.RUNTIME
    );
  }

  const base = {
    project: repository.link,
    branch: branchName,
    head: reach.head,
    reachable: reach.commits.length,
    already_in_branch: plan.already_in_branch,
    missing_from_branch: plan.missing_branch_commits.length,
    stale: plan.stale.length,
    missing_git_commits: plan.missing_git_commits.length,
    missing_parent_edges: plan.missing_edges.length,
    skipped_parent_edges: plan.skipped_edges,
    head_changed: plan.head_changed,
    would_create_project: plan.would_create_project,
    would_create_branch: plan.would_create_branch,
    truncated: reach.truncated,
    shallow: reach.shallow,
    partial: plan.partial,
    mode: args.apply ? "apply" : "dry-run",
    observed_at: now().toISOString(),
  };

  if (plan.branch_deleted) {
    return finish({ ...base, action: "skipped", reason: "branch-deleted" });
  }

  if (!args.apply) {
    return finish({ ...base, action: "would-apply", reason: "dry-run" });
  }

  try {
    const counts = await applyPlan(plan, repository, branchName, reach, deps);
    const nothingToDo =
      counts.git_commits === 0 &&
      counts.parent_edges === 0 &&
      counts.branch_commits === 0 &&
      !counts.head_updated &&
      !counts.project_created &&
      !counts.branch_created;

    return finish({
      ...base,
      action: nothingToDo ? "noop" : "applied",
      reason: nothingToDo ? "already-reconciled" : undefined,
      inserted: counts,
      observed_at: now().toISOString(),
    });
  } catch (error) {
    if (String(error.message).includes("Falta la URL")) {
      log(error.message);
      return {
        exitCode: EXIT.CONFIG,
        result: { action: "error", reason: "missing-database-url" },
      };
    }
    return finish(
      { ...base, action: "error", reason: error.message },
      EXIT.RUNTIME
    );
  }
}

function formatHuman(result) {
  if (result.action === "skipped") {
    return `TDDLab reach: skipped (${result.reason})`;
  }
  if (result.action === "error") {
    return `TDDLab reach: error (${result.reason})`;
  }
  const line =
    `TDDLab reach: ${result.action} project=${result.project} branch=${result.branch} ` +
    `head=${(result.head || "").slice(0, 10)} alcanzables=${result.reachable} ` +
    `en_rama=${result.already_in_branch} faltan=${result.missing_from_branch} ` +
    `stale=${result.stale} padre_faltante=${result.missing_parent_edges} ` +
    `head_desfasado=${result.head_changed} mode=${result.mode}`;
  const extras = [];
  if (result.would_create_project) extras.push("crearía proyecto");
  if (result.would_create_branch) extras.push("crearía rama");
  if (result.partial) extras.push("parcial");
  if (result.inserted) {
    extras.push(
      `insertados: git_commit=${result.inserted.git_commits} ` +
        `commit_parent=${result.inserted.parent_edges} ` +
        `branch_commit=${result.inserted.branch_commits} ` +
        `head=${result.inserted.head_updated ? "actualizado" : "sin cambio"}`
    );
  }
  return line + (extras.length ? ` [${extras.join("; ")}]` : "");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { exitCode } = await runReachCli(argv);
    return exitCode;
  } finally {
    await closePool().catch(() => {});
  }
}

export { missingConfigMessage };
