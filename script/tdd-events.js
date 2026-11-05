import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitOptions = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
export const git = (...args) => execFileSync('git', args, gitOptions);
export const eventsDirectory = 'script/tdd-events';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function currentBranch() {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], gitOptions);
  if (result.error) {
    throw result.error;
  }
  const ref = result.stdout.trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
}

export function executionContext() {
  const branch = currentBranch();
  const ref = branch ? `refs/heads/${branch}` : git('rev-parse', 'HEAD').trim();
  const key = createHash('sha256').update(ref).digest('hex');
  return {
    directory: join(git('rev-parse', '--absolute-git-dir').trim(), 'tddlab', 'pending', key),
    branch,
  };
}

export function parseCycle(text) {
  if (!text.endsWith('\n')) {
    throw new Error('El ciclo TDD termina con un registro incompleto.');
  }
  return text.trimEnd().split('\n').map((line) => JSON.parse(line));
}

export function recordExecution(execution, { directory, branch } = executionContext()) {
  if (!uuid.test(execution.eventId)) {
    throw new Error('La ejecución TDD no tiene un identificador válido.');
  }
  mkdirSync(directory, { recursive: true });
  const path = join(directory, execution.eventId);
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...execution, branch }), { flag: 'wx' });
  renameSync(`${path}.tmp`, `${path}.json`);
}

function readPending(directory) {
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const runs = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !uuid.test(id)) {
      continue;
    }
    const path = join(directory, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const run = JSON.parse(text);
    if (run.eventId !== id) {
      throw new Error(`La ejecución TDD no coincide con su archivo: ${name}`);
    }
    runs.push(run);
  }
  return runs.sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
}

function cyclePath(id) {
  return `${eventsDirectory}/${id}.jsonl`;
}

function committedPending(runs) {
  const committed = new Map();
  if (runs.length === 0) {
    return committed;
  }
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], gitOptions);
  if (head.error) {
    throw head.error;
  }
  const ref = head.stdout.trim();
  if (!ref) {
    return committed;
  }
  const paths = new Set(git('ls-tree', '-r', '--name-only', '-z', ref, '--', eventsDirectory).split('\0'));
  for (const { eventId } of runs) {
    const path = cyclePath(eventId);
    if (paths.has(path)) {
      const ids = parseCycle(git('show', `${ref}:${path}`)).map((run) => run.eventId);
      committed.set(path, ids);
    }
  }
  return committed;
}

function remainingRuns(directory, acknowledge = false) {
  const runs = readPending(directory);
  const confirmed = new Set();
  for (const [path, ids] of committedPending(runs)) {
    ids.forEach((id) => confirmed.add(id));
    if (!acknowledge) {
      continue;
    }
    if (git('diff', '--cached', '--diff-filter=D', '--name-only', '--', path).trim()) {
      // A path-limited commit adds the cycle to a temporary index.
      git('restore', '--staged', '--', path);
    }
    const anchor = path.slice(eventsDirectory.length + 1, -6);
    // Remove the anchor last so a retry can still find the cycle in HEAD.
    for (const id of [...ids.filter((eventId) => eventId !== anchor), anchor]) {
      if (uuid.test(id)) {
        rmSync(join(directory, `${id}.json`), { force: true });
      }
    }
  }
  return runs.filter((run) => !confirmed.has(run.eventId));
}

export function pendingRuns() {
  return remainingRuns(executionContext().directory);
}

function stageCycle() {
  if (['MERGE_HEAD', 'SQUASH_MSG'].some((name) => existsSync(resolve(root, git('rev-parse', '--git-path', name).trim())))) {
    return;
  }
  const runs = remainingRuns(executionContext().directory, true);
  const staged = git('diff', '--cached', '--name-only', '-z', '--', eventsDirectory).split('\0').filter(Boolean);
  if (staged.length > 1 || (staged.length === 1 && !runs.some(({ eventId }) => cyclePath(eventId) === staged[0]))) {
    throw new Error('Hay archivos de ciclos en el índice que no corresponden a esta rama. Sácalos del índice antes de confirmar.');
  }
  if (runs.length === 0) {
    return;
  }
  const path = staged[0] ?? cyclePath(runs[0].eventId);
  mkdirSync(join(root, eventsDirectory), { recursive: true });
  writeFileSync(join(root, path), runs.map((run) => JSON.stringify(run) + '\n').join(''));
  git('add', '--', path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'stage') {
    stageCycle();
  } else if (process.argv[2] === 'ack') {
    remainingRuns(executionContext().directory, true);
  }
}
