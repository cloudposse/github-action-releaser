const fs = require('fs');
const semver = require('semver');
const github = require('@actions/github');
const log4js = require('log4js');
const gitUtils = require('../src/git_utils.js');

const logLevel = process.env.LOG_LEVEL || 'info';

log4js.configure({
  appenders: { console: { type: 'console' } },
  categories: { default: { appenders: ['console'], level: logLevel } },
});

const logger = log4js.getLogger();

const RELEASE_BRANCH_PREFIX = 'release/v';
const RESPONSE_REASON = {
  NO_CHANGES: 'NO_CHANGES',
  CREATED_BRANCHES: 'CREATED_BRANCHES',
};

class Response {
  constructor(succeeded, reason, message, data) {
    this.succeeded = succeeded;
    this.reason = reason;
    this.message = message;
    this.data = data;
  }
}

function getDefaultBranch(context) {
  return context.payload.repository.default_branch;
}

function readFile(contextFile) {
  return new Promise((resolve, reject) => {
    fs.readFile(contextFile, 'utf8', (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(JSON.parse(data));
      }
    });
  });
}

async function loadContext(contextFile) {
  let context;

  if (contextFile != null) {
    const github = await readFile(contextFile);
    context = github.context;
  } else {
    context = github.context;
  }

  return context;
}

function isSemver(version) {
  return semver.valid(version) != null;
}

function getLatestSemVerTagsForPerMajor(tags) {
  const latestTagsPerMajorVersion = new Map();

  for (const tag of tags) {
    if (isSemver(tag)) {
      const major = semver.major(tag);
      const key = `${major}`;

      if (!latestTagsPerMajorVersion.has(key)) {
        latestTagsPerMajorVersion.set(key, tag);
      }
    }
  }

  return latestTagsPerMajorVersion;
}

async function main(repoPath, contextFile = null, doPush = true) {
  try {
    const context = await loadContext(contextFile);
    const defaultBranch = getDefaultBranch(context);

    const allTags = gitUtils.getAllTags(repoPath);
    logger.debug(`All available tags:\n${allTags.join('\n')}`);

    const latestSemVerTagsPerMajor = getLatestSemVerTagsForPerMajor(allTags);
    logger.info(`Latest SemVer tags:\n${Array.from(latestSemVerTagsPerMajor.values()).join('\n')}`);

    if (latestSemVerTagsPerMajor.size === 0) {
      return new Response(true, RESPONSE_REASON.NO_CHANGES, 'No SemVer tags found', {});
    }

    let highestMajor = -1;
    for (const major of latestSemVerTagsPerMajor.keys()) {
      const majorInt = parseInt(major);
      if (majorInt > highestMajor) {
        highestMajor = majorInt;
      }
    }

    const responseData = {};

    for (const [major, tag] of latestSemVerTagsPerMajor) {
      const releaseBranch = `${RELEASE_BRANCH_PREFIX}${major}`;
      const releaseBranchExists = gitUtils.doesBranchExist(repoPath, releaseBranch);

      if (releaseBranchExists) {
        logger.info(`Release branch '${releaseBranch}' for major tag ${major} already exists. Skipping.`);
        continue;
      }

      if (major === `${highestMajor}`) {
        logger.info(`Skipping creation of release branch '${releaseBranch}' for tag (${tag}) as it is the highest major version.`);
        continue;
      }

      gitUtils.gitCheckoutAtTag(repoPath, tag);
      gitUtils.createBranch(repoPath, releaseBranch);

      if (doPush) {
        gitUtils.pushBranchToRemote(repoPath, releaseBranch);
      }

      gitUtils.checkoutBranch(repoPath, defaultBranch);

      responseData[releaseBranch] = tag;

      logger.info(`Created release branch '${releaseBranch}' for tag (${tag}).`);
    }

    if (Object.keys(responseData).length === 0) {
      return new Response(true, RESPONSE_REASON.NO_CHANGES, 'No changes were made', {});
    } else {
      return new Response(true, RESPONSE_REASON.CREATED_BRANCHES, `Successfully created release branches`, responseData);
    }
  } catch (error) {
    logger.error(error);
    return new Response(false, null, error.message, {});
  }
}

module.exports = { main, Response, RESPONSE_REASON };