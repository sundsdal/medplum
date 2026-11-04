// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { DelayedError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { ServerConfig } from '../config/utils';
import {
  closeQueueBackend,
  getQueueBackendOptions,
  initQueueBackend,
  Queue,
  testQueueBackend,
  Worker,
} from './backend';

// Run explicitly with an isolated database: MEDPLUM_TEST_QUEUE_DATABASE_URL=postgres://... bunx vitest run --config vite.postgres.config.ts
const connectionString = process.env.MEDPLUM_TEST_QUEUE_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration('PostgreSQL background jobs', () => {
  const config = {
    backgroundJobs: {
      backend: 'postgres',
      postgres: { connectionString: connectionString as string, maxConnections: 8 },
    },
  } as unknown as ServerConfig;
  let queue: InstanceType<typeof Queue>;
  let workers: { close(): Promise<void> }[];

  async function waitFor(condition: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
    const end = Date.now() + timeout;
    while (!(await condition())) {
      if (Date.now() >= end) {
        throw new Error('Timed out waiting for queue condition');
      }
      await delay(50);
    }
  }

  beforeEach(async () => {
    workers = [];
    await initQueueBackend(config, 2);
    queue = new Queue(`integration-${randomUUID()}`, { connection: getQueueBackendOptions(config) });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    try {
      for (const worker of workers) {
        await worker.close();
      }
      await queue.obliterate({ force: true });
    } finally {
      try {
        await queue.close();
      } finally {
        await closeQueueBackend();
      }
    }
  });

  test('migrates, reports health, processes a job and persists it across backend restart', async () => {
    expect(await testQueueBackend(config)).toBe(true);
    const job = await queue.add('persist', { value: 42 });
    await queue.close();
    await closeQueueBackend();
    expect(await testQueueBackend(config)).toBe(false);

    await initQueueBackend(config, 2);
    queue = new Queue(queue.name, { connection: getQueueBackendOptions(config) });
    const seen: unknown[] = [];
    workers.push(
      new Worker(
        queue.name,
        async (item) => {
          seen.push(item.data);
        },
        { connection: getQueueBackendOptions(config) }
      )
    );
    await waitFor(
      async () => (await queue.getJob(job.id as string))?.getState().then((state) => state === 'completed') ?? false
    );
    expect(seen).toEqual([{ value: 42 }]);
  });

  test('preserves URL options while forcing the queue schema', async () => {
    await queue.close();
    await closeQueueBackend();
    const url = new URL(connectionString as string);
    url.searchParams.set(
      'options',
      '-c search_path=public -c statement_timeout=12345 -c default_transaction_isolation=repeatable\\ read'
    );
    const optionsConfig = {
      backgroundJobs: { backend: 'postgres', postgres: { connectionString: url.toString(), maxConnections: 8 } },
    } as unknown as ServerConfig;
    await initQueueBackend(optionsConfig, 2);
    queue = new Queue(queue.name, { connection: getQueueBackendOptions(optionsConfig) });
    const pool = getQueueBackendOptions(optionsConfig) as Pool;
    const result = await pool.query(
      "SELECT current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation"
    );
    expect(result.rows[0]).toEqual({ path: 'bullmq', timeout: '12345ms', isolation: 'read committed' });
    const seen: number[] = [];
    for (let i = 0; i < 2; i++) {
      workers.push(
        new Worker(
          queue.name,
          async (job) => {
            seen.push(job.data.value);
          },
          { connection: pool }
        )
      );
    }
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, value) => queue.add('isolated', { value })));
    await waitFor(async () =>
      (await Promise.all(jobs.map((job) => job.getState()))).every((state) => state === 'completed')
    );
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, value) => value));
  });

  test('health stays available when ordinary pool connections are occupied', async () => {
    const pool = getQueueBackendOptions(config) as Pool;
    const clients = [];
    try {
      for (let i = 0; i < 7; i++) {
        clients.push(await pool.connect());
      }
      expect(await testQueueBackend(config)).toBe(true);
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
    expect(await queue.add('after-load', {})).toBeDefined();
  });

  test('retries a failed job after its backoff', async () => {
    const attempts: number[] = [];
    workers.push(
      new Worker(
        queue.name,
        async () => {
          attempts.push(Date.now());
          if (attempts.length === 1) {
            throw new Error('retry');
          }
        },
        { connection: getQueueBackendOptions(config) }
      )
    );
    const job = await queue.add('retry', {}, { attempts: 2, backoff: { type: 'fixed', delay: 300 } });
    await waitFor(
      async () => (await queue.getJob(job.id as string))?.getState().then((state) => state === 'completed') ?? false
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(250);
  });

  test('redelivers a job moved to delayed without failing it', async () => {
    const attempts: number[] = [];
    let failures = 0;
    const worker = new Worker(
      queue.name,
      async (job) => {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          expect(job.token).toBeDefined();
          await job.moveToDelayed(Date.now() + 300, job.token);
          throw new DelayedError('try later');
        }
      },
      { connection: getQueueBackendOptions(config) }
    );
    worker.on('failed', () => {
      failures++;
    });
    workers.push(worker);
    const job = await queue.add('delayed', {});
    await waitFor(
      async () => (await queue.getJob(job.id as string))?.getState().then((state) => state === 'completed') ?? false
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(250);
    expect(failures).toBe(0);
    expect((await queue.getJobCounts('failed')).failed).toBe(0);
  });

  test('deduplicates until the original job completes', async () => {
    const options = { deduplication: { id: 'same-key' } };
    const first = await queue.add('dedup', { value: 1 }, options);
    const duplicate = await queue.add('dedup', { value: 2 }, options);
    expect(duplicate.id).toBe(first.id);
    expect((await queue.getJob(first.id as string))?.data).toEqual({ value: 1 });
    const seen: number[] = [];
    workers.push(
      new Worker(
        queue.name,
        async (job) => {
          seen.push(job.data.value);
        },
        { connection: getQueueBackendOptions(config) }
      )
    );
    await waitFor(
      async () => (await queue.getJob(first.id as string))?.getState().then((state) => state === 'completed') ?? false
    );
    const next = await queue.add('dedup', { value: 3 }, options);
    expect(next.id).not.toBe(first.id);
    await waitFor(
      async () => (await queue.getJob(next.id as string))?.getState().then((state) => state === 'completed') ?? false
    );
    expect(seen).toEqual([1, 3]);
  });

  test('retains only one completed and one failed job', async () => {
    workers.push(
      new Worker(
        queue.name,
        async (job) => {
          if (job.name === 'fail') {
            throw new Error('expected failure');
          }
        },
        { connection: getQueueBackendOptions(config), concurrency: 1 }
      )
    );
    for (const name of ['complete', 'complete', 'fail', 'fail']) {
      const job = await queue.add(name, {}, { removeOnComplete: { count: 1 }, removeOnFail: { count: 1 } });
      const expected = name === 'fail' ? 'failed' : 'completed';
      await waitFor(
        async () => (await queue.getJob(job.id as string))?.getState().then((state) => state === expected) ?? false
      );
    }
    await waitFor(async () => {
      const counts = await queue.getJobCounts('completed', 'failed');
      return counts.completed === 1 && counts.failed === 1;
    });
    await workers[0].close();
    workers = [];
    await queue.close();
    await closeQueueBackend();
    await initQueueBackend(config, 2);
    queue = new Queue(queue.name, { connection: getQueueBackendOptions(config) });
    const counts = await queue.getJobCounts('completed', 'failed');
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
  });

  test('runs a recurring scheduler and removes it', async () => {
    let count = 0;
    workers.push(
      new Worker(
        queue.name,
        async () => {
          count++;
        },
        { connection: getQueueBackendOptions(config) }
      )
    );
    await queue.upsertJobScheduler('periodic', { pattern: '* * * * * *' }, { name: 'tick', data: {} });
    await waitFor(() => count >= 2);
    expect(await queue.removeJobScheduler('periodic')).toBe(true);
    expect(await queue.getJobScheduler('periodic')).toBeUndefined();
  });

  test('honors worker concurrency', async () => {
    let active = 0;
    let peak = 0;
    let finished = 0;
    workers.push(
      new Worker(
        queue.name,
        async () => {
          active++;
          peak = Math.max(peak, active);
          await delay(250);
          active--;
          finished++;
        },
        { connection: getQueueBackendOptions(config), concurrency: 2 }
      )
    );
    await Promise.all(Array.from({ length: 4 }, () => queue.add('parallel', {})));
    await waitFor(() => finished === 4);
    expect(peak).toBe(2);
  });

  test('enforces global concurrency across workers', async () => {
    let active = 0;
    let peak = 0;
    let finished = 0;
    await queue.setGlobalConcurrency(1);
    const processor = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await delay(150);
      active--;
      finished++;
    };
    workers.push(new Worker(queue.name, processor, { connection: getQueueBackendOptions(config), concurrency: 2 }));
    workers.push(new Worker(queue.name, processor, { connection: getQueueBackendOptions(config), concurrency: 2 }));
    await Promise.all(Array.from({ length: 4 }, () => queue.add('global', {})));
    await waitFor(() => finished === 4);
    expect(peak).toBe(1);
  });
});

integration('Medplum worker registration', () => {
  test('initializes every queue on PostgreSQL even when processing is disabled', async () => {
    const { PostgresQueueBackend } = await import('bullmq');
    const { initWorkers, closeWorkers } = await import('./index');
    const { queueRegistry } = await import('./utils');
    const config = {
      backgroundJobs: {
        backend: 'postgres',
        postgres: { connectionString: connectionString as string, maxConnections: 8 },
      },
      workers: { enabled: [] },
    } as unknown as ServerConfig;
    const names = [
      'DispatchQueue',
      'SubscriptionQueue',
      'DownloadQueue',
      'CronQueue',
      'ReindexQueue',
      'BatchQueue',
      'BulkExportQueue',
      'PostDeployMigrationQueue',
      'SetAccountsQueue',
      'LambdaCleanerQueue',
      'DicomQueue',
    ];
    try {
      await initWorkers(config);
      for (const name of names) {
        const queue = queueRegistry.get(name);
        expect(queue, name).toBeDefined();
        expect(queue?.backend, name).toBeInstanceOf(PostgresQueueBackend);
        const job = await queue?.add('integration-test', { name });
        expect((await queue?.getJob(job?.id as string))?.data).toEqual({ name });
        await job?.remove();
      }
    } finally {
      await closeWorkers();
    }
    for (const name of names) {
      expect(queueRegistry.get(name)).toBeUndefined();
    }
    expect(await testQueueBackend(config)).toBe(false);
  }, 60_000);
});

const redisUrl = process.env.MEDPLUM_TEST_QUEUE_REDIS_URL;
const redisIntegration = redisUrl ? describe : describe.skip;
redisIntegration('default Redis background jobs', () => {
  test('processes a job through the Medplum factory without a backend setting', async () => {
    const { RedisQueueBackend } = await import('bullmq');
    const url = new URL(redisUrl as string);
    const config = {
      redis: {
        host: url.hostname,
        port: Number(url.port),
        password: decodeURIComponent(url.password),
        db: Number(url.pathname.slice(1)),
      },
    } as ServerConfig;
    const name = `integration-${randomUUID()}`;
    await initQueueBackend(config, 1);
    const queue = new Queue(name, { connection: getQueueBackendOptions(config) });
    const seen: unknown[] = [];
    const worker = new Worker(
      name,
      async (job) => {
        seen.push(job.data);
      },
      { connection: getQueueBackendOptions(config) }
    );
    try {
      expect(queue.backend).toBeInstanceOf(RedisQueueBackend);
      const job = await queue.add('smoke', { value: 42 });
      const deadline = Date.now() + 15_000;
      while ((await job.getState()) !== 'completed') {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for Redis job');
        }
        await delay(50);
      }
      expect(seen).toEqual([{ value: 42 }]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await closeQueueBackend();
    }
  });
});
