import fs from 'fs';
import { getHistoryFilePaths } from './branch-utils.js';
import { execSync } from 'child_process';

function readJsonFileFromFilesystem(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading or parsing JSON file from filesystem: ${filePath}`, error);
    return [];
  }
}

function readJsonFileFromBranch(branchName, filePath) {
  try {
    // Use git show to get the content of the file from the specified branch
    const fileContent = execSync(`git show ${branchName}:${filePath}`, { encoding: 'utf8', stdio: 'pipe' });
    return JSON.parse(fileContent);
  } catch (error) {
    // This error is expected if the file doesn't exist on the branch
    console.log(`Info: File '${filePath}' not found on branch '${branchName}'. Assuming empty history.`);
    return [];
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing to JSON file: ${filePath}`, error);
  }
}

function mergeHistories(sourceBranch, targetBranch) {
  console.log(`Merging history from '${sourceBranch}' into '${targetBranch}'...`);

  const sourcePaths = getHistoryFilePaths(sourceBranch);
  const targetPaths = getHistoryFilePaths(targetBranch);

  // --- COMMIT HISTORY MERGE ---
  console.log('\n--- PROCESSING COMMIT HISTORY ---');
  // Read source files directly from the git branch, not the filesystem
  const sourceCommits = readJsonFileFromBranch(sourceBranch, sourcePaths.commitHistory);
  // Read target files from the current filesystem
  const targetCommits = readJsonFileFromFilesystem(targetPaths.commitHistory);
  console.log(`Found ${sourceCommits.length} commits in source branch ('${sourceBranch}').`);
  console.log(`Found ${targetCommits.length} commits in target branch ('${targetBranch}').`);

  const headIndex = sourceCommits.findIndex(c => c.sha === 'HEAD');
  if (headIndex > -1) {
    try {
      const realSha = execSync(`git rev-parse ${sourceBranch}`, { encoding: 'utf8' }).trim();
      const headCommit = sourceCommits[headIndex];
      headCommit.sha = realSha;
      if (headCommit.commit.url) {
        const baseUrl = headCommit.commit.url.split('/commit/')[0];
        headCommit.commit.url = `${baseUrl}/commit/${realSha}`;
      }
    } catch (error) {
      console.error(`Could not resolve SHA for branch '${sourceBranch}'. Skipping HEAD commit.`, error);
      sourceCommits.splice(headIndex, 1);
    }
  }

  const targetCommitShas = new Set(targetCommits.map(c => c.sha));
  let newCommits = 0;
  sourceCommits.forEach(sourceCommit => {
    if (sourceCommit.sha && !targetCommitShas.has(sourceCommit.sha)) {
      targetCommits.push(sourceCommit);
      newCommits++;
    }
  });

  targetCommits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));
  writeJsonFile(targetPaths.commitHistory, targetCommits);
  console.log(`Merged ${newCommits} new commits into '${targetPaths.commitHistory}'.`);

  // --- TDD LOG MERGE ---
  console.log('\n--- PROCESSING TDD LOG ---');
  const sourceTddLog = readJsonFileFromBranch(sourceBranch, sourcePaths.tddLog);
  const targetTddLog = readJsonFileFromFilesystem(targetPaths.tddLog);
  console.log(`Found ${sourceTddLog.length} TDD log entries in source branch ('${sourceBranch}').`);
  console.log(`Found ${targetTddLog.length} TDD log entries in target branch ('${targetBranch}').`);

  const tddHeadIndex = sourceTddLog.findIndex(c => c.commitId === 'HEAD');
  if (tddHeadIndex > -1) {
    try {
      const realSha = execSync(`git rev-parse ${sourceBranch}`, { encoding: 'utf8' }).trim();
      sourceTddLog[tddHeadIndex].commitId = realSha;
    } catch (error) {
      console.error(`Could not resolve SHA for branch '${sourceBranch}' in TDD log. Skipping HEAD entry.`);
      sourceTddLog.splice(tddHeadIndex, 1);
    }
  }

  const targetTddEntries = new Set(targetTddLog.map(e => e.commitId ? e.commitId : `${e.timestamp}-${e.testId}`));
  let newTddEntries = 0;
  sourceTddLog.forEach(sourceEntry => {
    const uniqueId = sourceEntry.commitId ? sourceEntry.commitId : `${sourceEntry.timestamp}-${sourceEntry.testId}`;
    if (!targetTddEntries.has(uniqueId)) {
      targetTddLog.push(sourceEntry);
      newTddEntries++;
    }
  });

  targetTddLog.sort((a, b) => (a.commitTimestamp || a.timestamp) - (b.commitTimestamp || b.timestamp));
  writeJsonFile(targetPaths.tddLog, targetTddLog);
  console.log(`Merged ${newTddEntries} new TDD log entries into '${targetPaths.tddLog}'.`);

  // --- CLEANUP ---
  // This part is tricky, as we can't delete a file from a branch that isn't checked out.
  // For now, we will notify the user to delete the branch. A more advanced solution could
  // involve creating a new commit on the target branch that removes the files.
  console.log(`\nCleanup complete. You can now safely delete the '${sourceBranch}' branch.`);
  console.log(`Note: The history files from '${sourceBranch}' are not deleted from the branch itself.`);

}

// --- Main execution ---
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node script/merge-histories.js <source-branch> <target-branch>');
  process.exit(1);
}

const [sourceBranch, targetBranch] = args;
mergeHistories(sourceBranch, targetBranch);
