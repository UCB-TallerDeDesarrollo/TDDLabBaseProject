import { execSync } from 'child_process';
import path from 'path';

const HISTORY_DIR = 'script';
const COMMIT_HISTORY_PREFIX = 'commit-history';
const TDD_LOG_PREFIX = 'tdd_log';
const JSON_EXT = '.json';

/**
 * Gets the current Git branch name.
 * @returns {string} The current branch name.
 */
function getCurrentBranchName() {
  try {
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    // Sanitize branch name to be filesystem-friendly
    return branchName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  } catch (error) {
    console.error('Error getting current branch name. Defaulting to "main".', error);
    // Fallback to main if not in a git repo or if the command fails
    return 'main';
  }
}

/**
 * Gets the file paths for the history files of a given branch.
 * @param {string} [branchName] - The name of the branch. Defaults to the current branch.
 * @returns {{commitHistory: string, tddLog: string}}
 */
function getHistoryFilePaths(branchName) {
  const currentBranch = branchName || getCurrentBranchName();
  const commitHistoryFile = `${COMMIT_HISTORY_PREFIX}.${currentBranch}${JSON_EXT}`;
  const tddLogFile = `${TDD_LOG_PREFIX}.${currentBranch}${JSON_EXT}`;

  return {
    commitHistory: path.join(HISTORY_DIR, commitHistoryFile),
    tddLog: path.join(HISTORY_DIR, tddLogFile),
  };
}

export { getCurrentBranchName, getHistoryFilePaths };
