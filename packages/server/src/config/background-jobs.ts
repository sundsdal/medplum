// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumServerConfig, WorkerName } from './types';
import { WORKER_NAMES } from './types';

export const DEFAULT_POSTGRES_QUEUE_CONNECTIONS = 32;

/**
 * Returns the workers enabled on this server instance.
 * @param config - Server configuration.
 * @returns Enabled worker names.
 */
export function getEnabledWorkerNames(config: MedplumServerConfig): WorkerName[] {
  const enabled = config.workers?.enabled;
  return enabled === undefined || enabled.includes('*')
    ? [...WORKER_NAMES]
    : WORKER_NAMES.filter((name) => enabled.includes(name));
}

/**
 * Validates the minimum pool size for listeners, queries, and health checks.
 * @param maxConnections - Maximum pool connections.
 * @param workerCount - Number of enabled workers.
 */
export function validatePostgresPoolSize(maxConnections: number, workerCount: number): void {
  const minimum = 2 * workerCount + 2;
  if (!Number.isInteger(maxConnections) || maxConnections < minimum) {
    throw new Error(
      `backgroundJobs.postgres.maxConnections must be an integer of at least ${minimum} for ${workerCount} enabled workers`
    );
  }
}
