// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  BackendFactory,
  ConnectionOptions,
  IQueueBackend,
  PostgresConnectionOptions,
  Queue as BullQueue,
  Worker as BullWorker,
} from 'bullmq';
import { createPostgresBackend, createRedisBackend, isPgPool, runMigrations, withBackend } from 'bullmq';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { DEFAULT_POSTGRES_QUEUE_CONNECTIONS, validatePostgresPoolSize } from '../config/background-jobs';
import type { ServerConfig } from '../config/utils';
import { globalLogger } from '../logger';
import { reconnectOnError } from '../redis';

export type QueueConnection = ConnectionOptions | PostgresConnectionOptions;
export type Queue<T = any> = BullQueue<T, any, string, T, any, string, IQueueBackend, QueueConnection>;
export type Worker<T = any> = BullWorker<T, any, string, IQueueBackend, any, QueueConnection>;

// Select a factory per instance; never alter BullMQ's process-wide default.
const backendFactory: BackendFactory<IQueueBackend, QueueConnection> = (name, opts, factoryOptions) => {
  if (isPgPool(opts.connection)) {
    return createPostgresBackend(name, { ...opts, connection: opts.connection }, factoryOptions);
  }
  return createRedisBackend(name, { ...opts, connection: opts.connection as ConnectionOptions }, factoryOptions);
};
export const { Queue, Worker } = withBackend(backendFactory);

let pool: Pool | undefined;
let healthClient: Promise<PoolClient> | undefined;
let healthCheck: Promise<boolean> | undefined;

export async function initQueueBackend(config: ServerConfig, workerCount: number): Promise<void> {
  if (config.backgroundJobs?.backend !== 'postgres') {
    return;
  }
  if (pool) {
    throw new Error('Background job PostgreSQL pool is already initialized');
  }
  const { connectionString, maxConnections = DEFAULT_POSTGRES_QUEUE_CONNECTIONS } = config.backgroundJobs.postgres;
  validatePostgresPoolSize(maxConnections, workerCount);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('backgroundJobs.postgres.connectionString must be a PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('backgroundJobs.postgres.connectionString must be a PostgreSQL URL');
  }
  // pg-connection-string uses the last occurrence when a parameter is repeated.
  const options = url.searchParams.getAll('options').at(-1);
  url.searchParams.set('options', `${options ? `${options} ` : ''}-c search_path=bullmq`);
  const newPool = new Pool({ connectionString: url.toString(), max: maxConnections, connectionTimeoutMillis: 5_000 });
  // BullMQ attaches a pool error listener for every queue and worker backend.
  newPool.setMaxListeners(64);
  newPool.on('error', (err) => globalLogger.error('Background job PostgreSQL pool error', { err }));
  try {
    const client = await newPool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
    healthClient = reserveHealthClient(newPool);
    await healthClient;
    pool = newPool;
  } catch (err) {
    releaseHealthClient();
    try {
      await newPool.end();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], 'Failed to initialize and close background job PostgreSQL pool');
    }
    throw err;
  }
}

export async function closeQueueBackend(): Promise<void> {
  const current = pool;
  pool = undefined;
  healthCheck = undefined;
  releaseHealthClient();
  if (current) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.end(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out closing background job PostgreSQL pool')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function getQueueBackendOptions(config: ServerConfig): QueueConnection {
  if (config.backgroundJobs?.backend === 'postgres') {
    if (!pool) {
      throw new Error('Background job PostgreSQL pool is not initialized');
    }
    return pool;
  }
  return { ...(config.backgroundJobsRedis ?? config.redis), reconnectOnError };
}

function reserveHealthClient(current: Pool): Promise<PoolClient> {
  const connection = current.connect();
  connection.then(
    (client) => client.on('error', () => releaseHealthClient(connection)),
    () => releaseHealthClient(connection)
  );
  return connection;
}

function releaseHealthClient(expected = healthClient): void {
  if (!expected || healthClient !== expected) {
    return;
  }
  healthClient = undefined;
  expected.then((client) => client.release(true), () => undefined);
}

export async function testQueueBackend(config: ServerConfig): Promise<boolean | undefined> {
  if (config.backgroundJobs?.backend !== 'postgres') {
    return undefined;
  }
  const current = pool;
  if (!current) {
    return false;
  }
  if (healthCheck) {
    return healthCheck;
  }
  const check = checkQueueConnection(current);
  healthCheck = check;
  try {
    return await check;
  } finally {
    if (healthCheck === check) {
      healthCheck = undefined;
    }
  }
}

async function checkQueueConnection(current: Pool): Promise<boolean> {
  const connection = healthClient ?? (healthClient = reserveHealthClient(current));
  try {
    const client = await connection;
    const query = { text: 'SELECT 1 FROM bullmq.job LIMIT 0', query_timeout: 5_000 };
    await client.query(query);
    return true;
  } catch {
    releaseHealthClient(connection);
    return false;
  }
}
