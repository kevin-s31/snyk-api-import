import pMap = require('p-map');
import * as debugLib from 'debug';
import * as path from 'path';
import { requestsManager } from 'snyk-request-manager';
import {
  FAILED_UPDATE_PROJECTS_LOG_NAME,
  UPDATED_PROJECTS_LOG_NAME,
} from '../../common';
import type { TargetFilters } from '../../lib';
import { isGithubConfigured } from '../../lib';
import { getLoggingPath, listTargets } from '../../lib';
import { getFeatureFlag } from '../../lib/api/feature-flags';
import type { SnykTarget } from '../../lib/types';
import { SupportedIntegrationTypesUpdateProject } from '../../lib/types';
import { logUpdatedProjects } from '../../loggers/log-updated-project';
import type { ProjectUpdateFailure } from './sync-projects-per-target';
import { syncProjectsForTarget } from './sync-projects-per-target';
import type { ProjectUpdate } from './sync-projects-per-target';
import { logFailedSync } from '../../loggers/log-failed-sync';
import { logFailedToUpdateProjects } from '../../loggers/log-failed-to-update-projects';

const debug = debugLib('snyk:sync-org-projects');

export function isSourceConfigured(
  origin: SupportedIntegrationTypesUpdateProject,
): () => void {
  const getDefaultBranchGenerators = {
    [SupportedIntegrationTypesUpdateProject.GITHUB]: isGithubConfigured,
  };
  return getDefaultBranchGenerators[origin];
}

export async function updateOrgTargets(
  publicOrgId: string,
  sources: SupportedIntegrationTypesUpdateProject[],
  dryRun = false,
  host?: string,
): Promise<{
  fileName: string;
  failedFileName: string;
  processedTargets: number;
  meta: {
    projects: {
      updated: ProjectUpdate[];
      failed: ProjectUpdateFailure[];
    };
  };
}> {
  const res: {
    processedTargets: number;
    meta: {
      projects: {
        updated: ProjectUpdate[];
        failed: ProjectUpdateFailure[];
      };
    };
  } = {
    processedTargets: 0,
    meta: {
      projects: {
        updated: [],
        failed: [],
      },
    },
  };

  // ensure source is enabled for sync
  const allowedSources = sources.filter((source) =>
    Object.values(SupportedIntegrationTypesUpdateProject).includes(source),
  );
  if (!allowedSources.length) {
    throw new Error(
      `Nothing to sync, stopping. Sync command currently only supports the following sources: ${Object.values(
        SupportedIntegrationTypesUpdateProject,
      ).join(',')}`,
    );
  }

  const requestManager = new requestsManager({
    userAgentPrefix: 'snyk-api-import',
    period: 1000,
    maxRetryCount: 3,
  });

  let hasCustomBranchFlag = true;

  try {
    hasCustomBranchFlag = await getFeatureFlag(
      requestManager,
      'customBranch',
      publicOrgId,
    );
  } catch (e) {
    throw new Error(
      `Org ${publicOrgId} was not found or you may not have the correct permissions to access the org`,
    );
  }

  // TODO: move this into sync project per target and skip only whats needed
  if (hasCustomBranchFlag) {
    throw new Error(
      `Detected custom branches feature. Skipping syncing organization ${publicOrgId} because it is not possible to determine which should be the default branch.`,
    );
  }

  await pMap(
    allowedSources,
    async (source: SupportedIntegrationTypesUpdateProject) => {
      isSourceConfigured(source)();
      const filters: TargetFilters = {
        limit: 100,
        origin: source,
        excludeEmpty: true,
      };
      debug(`Listing all targets for source ${source}`);
      const { targets } = await listTargets(
        requestManager,
        publicOrgId,
        filters,
      );
      debug(`Syncing targets for source ${source}`);
      const response = await updateTargets(
        requestManager,
        publicOrgId,
        targets,
        dryRun,
        host,
      );
      res.processedTargets += response.processedTargets;
      res.meta.projects.updated.push(...response.meta.projects.updated);
      res.meta.projects.failed.push(...response.meta.projects.failed);
    },
    { concurrency: 3 },
  );

  let logFile = UPDATED_PROJECTS_LOG_NAME;
  try {
    logFile = path.resolve(getLoggingPath(), UPDATED_PROJECTS_LOG_NAME);
  } catch (e) {
    console.warn(e.message);
  }
  let failedLogFile = FAILED_UPDATE_PROJECTS_LOG_NAME;
  try {
    failedLogFile = path.resolve(
      getLoggingPath(),
      FAILED_UPDATE_PROJECTS_LOG_NAME,
    );
  } catch (e) {
    console.warn(e.message);
  }
  return { ...res, fileName: logFile, failedFileName: failedLogFile };
}

export async function updateTargets(
  requestManager: requestsManager,
  orgId: string,
  targets: SnykTarget[],
  dryRun = false,
  host?: string,
): Promise<{
  processedTargets: number;
  meta: {
    projects: {
      updated: ProjectUpdate[];
      failed: ProjectUpdateFailure[];
    };
  };
}> {
  let processedTargets = 0;
  const updatedProjects: ProjectUpdate[] = [];
  const failedProjects: ProjectUpdateFailure[] = [];

  const loggingPath = getLoggingPath();

  await pMap(
    targets,
    async (target: SnykTarget) => {
      try {
        const { updated, failed } = await syncProjectsForTarget(
          requestManager,
          orgId,
          target,
          dryRun,
          host,
        );
        updatedProjects.push(...updated);
        failedProjects.push(...failed);
        processedTargets += 1;

        if (updated.length) {
          await logUpdatedProjects(orgId, updated);
        }
        if (failed.length) {
          await logFailedToUpdateProjects(orgId, failed);
        }
      } catch (e) {
        debug(e);
        const errorMessage: string = e.message;
        console.warn(
          `Failed to sync target ${target.attributes.displayName}. ERROR: ${errorMessage}`,
        );
        await logFailedSync(orgId, target, errorMessage, loggingPath);
      }
    },
    { concurrency: 20 },
  );
  return {
    processedTargets,
    // TODO: collect failed targets & log them with reason?
    meta: {
      projects: {
        updated: updatedProjects,
        failed: failedProjects,
      },
    },
  };
}
