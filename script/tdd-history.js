import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { URL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { currentBranch, eventsDirectory, git, parseCycle, pendingRuns } from './tdd-events.js';
import { logsPath, metricsPath, readLegacy } from './tdd-legacy.js';

function readCycles(ref) {
  if (!ref) {
    return new Map();
  }
  const paths = git('ls-tree', '-r', '--name-only', ref, '--', eventsDirectory).trim().split('\n').filter(Boolean);
  const introductions = git('log', '--reverse', '--format=commit:%H', '--name-only',
    '--diff-filter=A', '--no-renames', ref, '--', eventsDirectory);
  const shaByPath = new Map();
  let sha;
  for (const line of introductions.split('\n')) {
    if (line.startsWith('commit:')) {
      sha = line.slice('commit:'.length);
    } else if (line.startsWith(`${eventsDirectory}/`)) {
      shaByPath.set(line, sha);
    }
  }

  const runsBySha = new Map();
  for (const file of paths) {
    const commit = shaByPath.get(file);
    if (!commit) {
      throw new Error(`No se encontró el commit que añadió ${file}. Usa un clon con historial completo.`);
    }
    const runs = runsBySha.get(commit) ?? [];
    runs.push(...parseCycle(git('show', `${ref}:${file}`)));
    runsBySha.set(commit, runs);
  }
  return runsBySha;
}

function readGitGraph(ref, cycles) {
  const branch = currentBranch();
  const historyBranch = branch && git('rev-parse', '--verify', `refs/heads/${branch}`).trim() === ref
    ? branch
    : undefined;
  const branchesBySha = new Map(cycles.map(({ sha, runs }) => {
    const branches = [...new Set(runs.map((run) => run.branch).filter(Boolean))].sort();
    return [sha, branches];
  }));
  // Preserve ancestry while showing independent commits by date.
  const fields = git('log', '-z', '--date-order', '--max-count=60', '--format=%H%x00%P%x00%ct%x00%s%x00%b', ref).split('\0');
  const commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [sha, parents, seconds, subject, body] = fields.slice(i, i + 5);
    const recordedBranches = branchesBySha.get(sha);
    commits.push({
      sha, parents: parents.split(' ').filter(Boolean), timestamp: Number(seconds) * 1000, subject,
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(recordedBranches?.length ? { recordedBranches } : { historyBranch }),
    });
  }
  return commits;
}

function describeCommit(sha, runs, repoUrl) {
  const format = '--format=%ct%x00%an%x00%B%x00';
  const withDiff = git('show', format, '--numstat', '--no-renames', '--diff-merges=first-parent', sha, '--',
    '.', `:!${eventsDirectory}`, `:!${logsPath}`, `:!${metricsPath}`);
  // A commit that only closes a cycle has no diff after filtering generated files.
  const [seconds, author, body, diff = ''] = (withDiff || git('show', '-s', format, sha)).split('\0');
  const timestamp = Number(seconds) * 1000;
  const date = new Date(timestamp).toISOString();
  const message = body.trim();
  const stats = { additions: 0, deletions: 0, total: 0, date: date.slice(0, 10) };
  for (const line of diff.trim().split('\n')) {
    const [added, deleted] = line.split('\t');
    stats.additions += Number(added) || 0;
    stats.deletions += Number(deleted) || 0;
  }
  stats.total = stats.additions + stats.deletions;
  runs.sort((a, b) => a.timestamp - b.timestamp);
  const last = runs.at(-1);

  return {
    sha, timestamp, runs,
    marker: { commitId: sha, commitName: message, commitTimestamp: timestamp },
    metrics: {
      sha, author, stats,
      commit: { date, message, url: `${repoUrl}/commit/${sha}` },
      coverage: last.coverage,
      test_count: last.numTotalTests,
      failed_tests: last.failedTests,
      conclusion: last.numTotalTests === 0 ? 'neutral' : last.success ? 'success' : 'failure',
    },
  };
}

function publicRun({ eventId, coverage, branch, ...run }, testId) {
  return { ...run, testId };
}

function buildLog(cycles) {
  return cycles.sort((a, b) => a.timestamp - b.timestamp || a.sha.localeCompare(b.sha))
    .flatMap(({ runs, marker }, testId) => [
      ...runs.map((run) => publicRun(run, testId)),
      { ...marker, testId },
    ]);
}

function json(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function publishExport(destination, log, metrics, review) {
  if (existsSync(destination)) {
    throw new Error('Elige una carpeta nueva para el export.');
  }
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, '.tddlab-export-'));
  try {
    mkdirSync(join(temporary, 'script'));
    writeFileSync(join(temporary, logsPath), json(log));
    writeFileSync(join(temporary, metricsPath), json(metrics));
    writeFileSync(join(temporary, 'tdd-review.json'), json(review));
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { legacy: { type: 'string' }, 'no-legacy': { type: 'boolean' } },
});
const [command, output, repoUrl] = positionals;
const preview = command === 'preview';
const root = git('rev-parse', '--show-toplevel').trim();
const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (head.error) {
  throw head.error;
}
const ref = head.stdout.trim();

if (Boolean(values.legacy) === Boolean(values['no-legacy'])) {
  throw new Error('Indica --legacy <SHA del histórico original> o --no-legacy para un proyecto sin histórico.');
}
if (values.legacy) {
  if (!/^[a-f0-9]{40,64}$/.test(values.legacy) || git('rev-parse', `${values.legacy}^{commit}`).trim() !== values.legacy) {
    throw new Error('Indica el SHA completo del commit original.');
  }
  git('merge-base', '--is-ancestor', values.legacy, ref);
  if (git('ls-tree', values.legacy, '--', eventsDirectory).trim()) {
    throw new Error('El histórico debe ser anterior a la captura por ciclos.');
  }
}

const destination = resolve(output ?? '.');
const fromRoot = relative(root, destination);
const outsideRepo = isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
let publicUrl;
if (!preview) {
  if (command !== 'export' || !ref || !output || !outsideRepo || !repoUrl) {
    throw new Error('Uso: export <directorio fuera del repo> <URL del repositorio> --legacy <SHA> (o --no-legacy)');
  }
  const url = new URL(repoUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Usa la URL HTTPS del repositorio, sin credenciales ni parámetros.');
  }
  publicUrl = url.href.replace(/\/$/, '');
}

if (ref && git('rev-parse', '--is-shallow-repository').trim() === 'true') {
  throw new Error('El historial de Git está incompleto. Descárgalo con git fetch --unshallow.');
}

const legacy = readLegacy(values.legacy);
const cycles = [...readCycles(ref)].map(([sha, runs]) => describeCommit(sha, runs, publicUrl));
const log = buildLog([...legacy.cycles, ...cycles]);
if (preview) {
  const testId = legacy.cycles.length + cycles.length;
  log.push(...pendingRuns().map((run) => publicRun(run, testId)));
  const path = join(root, 'script', 'tdd-preview.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, json(log));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
} else {
  const metrics = [...legacy.metrics, ...cycles.map((cycle) => cycle.metrics)]
    .sort((a, b) => Date.parse(a.commit.date) - Date.parse(b.commit.date) || a.sha.localeCompare(b.sha));
  const marker = log.find((row) => row.commitId);
  if (marker) {
    marker.gitGraph = readGitGraph(ref, cycles);
  }
  publishExport(destination, log, metrics, { ref, legacy: values.legacy, unresolved: legacy.review });
}
console.log(`Historial TDD: ${log.length} registros; ${legacy.review.length} casos históricos para revisar.`);
