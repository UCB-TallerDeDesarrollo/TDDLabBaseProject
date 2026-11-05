import { git } from './tdd-events.js';

export const logsPath = 'script/tdd_log.json';
export const metricsPath = 'script/commit-history.json';

function readArray(ref, path, files) {
  if (!files.includes(path)) {
    return [];
  }
  const rows = JSON.parse(git('show', `${ref}:${path}`));
  if (!Array.isArray(rows)) {
    throw new Error(`${path} debe contener un arreglo JSON.`);
  }
  return rows;
}

function isExecution(row) {
  return [row.numPassedTests, row.failedTests, row.numTotalTests].every(
    (count) => Number.isInteger(count) && count >= 0
  ) && Number.isFinite(row.timestamp) && typeof row.success === 'boolean';
}

function readCycles(logs, matches, review) {
  const groups = new Map();
  for (const [index, row] of logs.entries()) {
    if (!row || !Number.isSafeInteger(row.testId)) {
      review.push({ path: logsPath, reason: 'invalid-test-id', index, row });
      continue;
    }
    const group = groups.get(row.testId) ?? { rows: [], markers: [], runs: [] };
    group.rows.push(row);
    if (Object.hasOwn(row, 'commitId')) {
      group.markers.push(row);
    } else if (isExecution(row)) {
      group.runs.push(row);
    } else {
      review.push({ path: logsPath, reason: 'invalid-execution', index, row });
    }
    groups.set(row.testId, group);
  }

  const cycles = [];
  for (const [testId, { rows, markers, runs }] of groups) {
    const [marker] = markers;
    if (markers.length === 1 && matches(marker.commitId, marker.commitName) && Number.isFinite(marker.commitTimestamp)) {
      cycles.push({ sha: marker.commitId, timestamp: marker.commitTimestamp, runs, marker });
    } else {
      review.push({ path: logsPath, reason: 'unverified-cycle', testId, rows });
    }
  }
  return cycles;
}

function readMetrics(rows, matches, review) {
  const metrics = new Map();
  const repeated = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || !matches(row.sha, row.commit?.message) || !Number.isFinite(Date.parse(row.commit.date)) || !row.stats) {
      review.push({ path: metricsPath, reason: 'unverified-metrics', index, row });
      continue;
    }
    if (metrics.has(row.sha)) {
      review.push({ path: metricsPath, reason: 'repeated-commit', row: metrics.get(row.sha) });
      metrics.delete(row.sha);
      repeated.add(row.sha);
    }
    if (repeated.has(row.sha)) {
      review.push({ path: metricsPath, reason: 'repeated-commit', index, row });
    } else {
      metrics.set(row.sha, row);
    }
  }
  return [...metrics.values()];
}

export function readLegacy(ref) {
  const review = [];
  if (!ref) {
    return { cycles: [], metrics: [], review };
  }
  const files = git('ls-tree', '-r', '--name-only', ref, '--', logsPath, metricsPath).trim().split('\n');
  const history = git('log', '--format=%H%x00%B', '-z', ref).split('\0');
  const messages = new Map();
  for (let i = 0; i + 1 < history.length; i += 2) {
    messages.set(history[i], history[i + 1].trim());
  }
  // The old hook could assign a real but unrelated SHA to the previous marker.
  const matches = (sha, message) => typeof message === 'string' && messages.get(sha) === message.trim();
  const cycles = readCycles(readArray(ref, logsPath, files), matches, review);
  const metrics = readMetrics(readArray(ref, metricsPath, files), matches, review);
  return { cycles, metrics, review };
}
