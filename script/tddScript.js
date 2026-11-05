import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawn } from 'cross-spawn';
import { executionContext, recordExecution } from './tdd-events.js';

const context = executionContext();
const folder = mkdtempSync(join(tmpdir(), 'tddlab-jest-'));
const reportFile = join(folder, 'report.json');

try {
  const status = await new Promise((resolve, reject) => {
    const child = spawn('jest', ['--runInBand', '--coverage', '--json', `--outputFile=${reportFile}`], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const statements = Object.values(report.coverageMap ?? {}).flatMap((file) => Object.values(file.s));
  const coverage = statements.length
    ? Math.round(10000 * statements.filter((count) => count > 0).length / statements.length) / 100
    : null;
  recordExecution({
    eventId: randomUUID(),
    numPassedTests: report.numPassedTests,
    failedTests: report.numFailedTests,
    numTotalTests: report.numTotalTests,
    timestamp: report.startTime,
    success: report.success,
    coverage,
  }, context);
  process.exitCode = status;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
