// Topología git para el Script A (reconciliación de alcanzabilidad).
// Solo comandos git de LECTURA: nunca commit/merge/checkout.
//
// Port a JavaScript de `VSCodeExtension/resources/tddBridge/gitTopology.mjs`
// (repo TDDLab), sin dependencias del bridge HTTP.
import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 4000;

export function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

export function resolveRepoRoot(cwd) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }
}

export function currentBranch(cwd) {
  try {
    return runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd) || null;
  } catch {
    return null; // detached HEAD
  }
}

export function currentHead(cwd) {
  try {
    return runGit(["rev-parse", "HEAD"], cwd);
  } catch {
    return null;
  }
}

export function isShallowRepository(cwd) {
  try {
    return runGit(["rev-parse", "--is-shallow-repository"], cwd) === "true";
  } catch {
    return false;
  }
}

export function readRemoteUrl(cwd) {
  try {
    return runGit(["config", "--get", "remote.origin.url"], cwd) || null;
  } catch {
    return null;
  }
}

/**
 * Normaliza las variantes habituales de URL remota a
 * `{ provider, owner, name, link }`. Devuelve null si no se puede interpretar.
 */
export function parseRemoteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let value = rawUrl.trim();
  if (!value) return null;

  // Sintaxis scp-like: git@github.com:owner/repo.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) {
    value = `https://${scp[1]}/${scp[2]}`;
  } else if (value.startsWith("ssh://")) {
    value = value.replace(/^ssh:\/\/(?:[^@/]+@)?/, "https://");
  } else if (value.startsWith("git://")) {
    value = value.replace(/^git:\/\//, "https://");
  } else if (value.startsWith("http://")) {
    value = value.replace(/^http:\/\//, "https://");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const parts = url.pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts.slice(1).join("/");
  if (!owner || !name) return null;

  const host = url.hostname.toLowerCase();
  return {
    provider: host === "github.com" ? "github" : host,
    owner,
    name,
    link: `https://${url.hostname}/${owner}/${name}`,
  };
}

/**
 * Lee el conjunto alcanzable desde HEAD en una sola llamada a git.
 *
 * @returns {{head: string|null,
 *            commits: Array<{sha: string, parent_shas: string[]}>,
 *            truncated: boolean, shallow: boolean}}
 */
export function readReachable(cwd, options = {}) {
  const maxCommits =
    Number.isInteger(options.maxCommits) && options.maxCommits > 0
      ? options.maxCommits
      : 0;

  const args = ["rev-list", "--parents"];
  if (maxCommits > 0) args.push(`--max-count=${maxCommits}`);
  args.push("HEAD");

  let output = "";
  try {
    output = runGit(args, cwd, options.timeoutMs ?? GIT_TIMEOUT_MS);
  } catch {
    output = "";
  }

  const commits = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.split(/\s+/);
      return { sha, parent_shas: parents };
    });

  let truncated = false;
  if (maxCommits > 0 && commits.length === maxCommits) {
    try {
      const total = Number(runGit(["rev-list", "--count", "HEAD"], cwd));
      truncated = Number.isFinite(total) && total > maxCommits;
    } catch {
      truncated = true;
    }
  }

  return {
    head: currentHead(cwd),
    commits,
    truncated,
    shallow: isShallowRepository(cwd),
  };
}

/**
 * Metadatos de un commit para insertar en `git_commit`.
 * Formato separado por NUL para no romper con mensajes multilínea.
 */
export function readCommitMeta(cwd, ref) {
  const format = "%H%x00%P%x00%an%x00%ae%x00%cI%x00%B";
  const raw = runGit(
    ["show", "--no-patch", `--format=${format}`, "--end-of-options", ref],
    cwd
  );
  const [sha, parents, author, authorEmail, date, message] = raw.split("\0");
  return {
    sha,
    parent_shas: parents ? parents.split(" ") : [],
    author: author || "(sin autor)",
    author_email: authorEmail || null,
    message: message || "(sin mensaje)",
    committed_at: date,
  };
}

// Archivos generados que no afectan a las métricas del proyecto.
const EXCLUDED_PATHS = [
  ".",
  ":!script/tdd_log.json",
  ":!script/commit-history.json",
  ":!report.json",
];

/**
 * Estadísticas (additions/deletions/changed_files) de un commit,
 * excluyendo los archivos generados por los hooks.
 */
export function readCommitStats(cwd, sha, firstParent) {
  const args = firstParent
    ? ["diff", "--no-ext-diff", "--numstat", "-z", "--find-renames", firstParent, sha]
    : ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-z", "--find-renames", sha];

  let records = [""];
  try {
    records = runGit([...args, "--", ...EXCLUDED_PATHS], cwd).split("\0");
  } catch {
    // Sin diff calculable (p. ej. commit raíz con problemas): stats en 0.
  }

  const stats = { additions: 0, deletions: 0, changed_files: 0 };
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (record) {
      const [, added, deleted] = record;
      stats.additions += Number(added) || 0;
      stats.deletions += Number(deleted) || 0;
      stats.changed_files += 1;
      // Un rename tiene la ruta vacía en el registro, seguida de dos rutas.
      if (!record[3]) i += 2;
    }
  }
  return stats;
}
