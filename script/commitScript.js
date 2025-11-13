import { execSync } from 'child_process';
import fs from 'fs';
import { getLastTestId } from './id_execution_tests_commit.js';
import { getHistoryFilePaths } from './branch-utils.js';

const getLatestCommitName = () => {
    const commitName = execSync('git log -1 --pretty=%B').toString().trim();
    return commitName;
};

const updateJsonFile = () => {
    const { tddLog: filePath } = getHistoryFilePaths();
    const commitTimestamp = Date.now();
    const commitName = getLatestCommitName();
    let testId = getLastTestId();

    let existingData = [];
    try {
        const fileData = fs.readFileSync(filePath, 'utf8');
        existingData = JSON.parse(fileData);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('Error reading JSON file:', err);
            return;
        }
    }

    const headIndex = existingData.findIndex(entry => entry.commitId === 'HEAD');
    if (headIndex > -1) {
        try {
            const realSha = execSync('git rev-parse HEAD~1').toString().trim();
            existingData[headIndex].commitId = realSha;
        } catch (error) {
            console.error('Could not get previous commit SHA:', error);
        }
    }

    const data = { commitId: 'HEAD', commitName, commitTimestamp, testId };
    existingData.push(data);

    fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2));
};

updateJsonFile();