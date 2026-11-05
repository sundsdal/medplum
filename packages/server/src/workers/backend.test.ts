// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type * as BullMQ from 'bullmq';
import { vi } from 'vitest';
import type { ServerConfig } from '../config/utils';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  poolQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  migrate: vi.fn(),
  poolOptions: vi.fn(),
  connectionClose: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      mocks.poolOptions(options);
    }
    query = mocks.poolQuery;
    connect = mocks.connect;
    end = mocks.end;
    setMaxListeners = vi.fn();
    on = vi.fn();
  },
}));
vi.mock('bullmq', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof BullMQ>()),
    runMigrations: mocks.migrate,
    PostgresConnection: class extends EventEmitter {
      waitUntilReady = vi.fn().mockResolvedValue(undefined);
      setListenClientName = vi.fn().mockResolvedValue(undefined);
      getListenClient = vi.fn().mockResolvedValue({});
      close = mocks.connectionClose;
    },
  };
});

import { closeQueueBackend, getQueueBackendOptions, initQueueBackend, testQueueBackend } from './backend';

const postgres = {
  backgroundJobs: {
    backend: 'postgres',
    postgres: { connectionString: 'postgres://localhost/jobs', maxConnections: 6 },
  },
} as ServerConfig;

describe('queue backend lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ release: mocks.release, query: mocks.query, on: vi.fn() });
    mocks.migrate.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    mocks.connectionClose.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [{ status: 1 }] });
  });

  afterEach(async () => closeQueueBackend());

  test('uses Redis by default, including its dedicated background-jobs connection', async () => {
    const config = { redis: { host: 'general' }, backgroundJobsRedis: { host: 'jobs' } } as ServerConfig;
    await initQueueBackend(config);
    expect(getQueueBackendOptions(config)).toMatchObject({ host: 'jobs' });
    expect(await testQueueBackend(config)).toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test('migrates before exposing the pool, reports health and closes it', async () => {
    expect(() => getQueueBackendOptions(postgres)).toThrow('not initialized');
    await initQueueBackend(postgres);
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(await testQueueBackend(postgres)).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith({ text: 'SELECT 1 FROM bullmq.job LIMIT 0', query_timeout: 5_000 });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    mocks.query.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await testQueueBackend(postgres)).toBe(false);
    await closeQueueBackend();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(await testQueueBackend(postgres)).toBe(false);
  });

  test('closes the pool and releases the client when migration fails', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('migration failed'));
    await expect(initQueueBackend(postgres)).rejects.toThrow('migration failed');
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(() => getQueueBackendOptions(postgres)).toThrow('not initialized');
  });

  test('shares an in-flight reserved health query', async () => {
    await initQueueBackend(postgres);
    let resolveQuery: (() => void) | undefined;
    mocks.query.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const checks = [testQueueBackend(postgres), testQueueBackend(postgres)];
    await Promise.resolve();
    expect(mocks.query).toHaveBeenCalledOnce();
    resolveQuery?.();
    expect(await Promise.all(checks)).toEqual([true, true]);
  });

  test('preserves connection options and appends queue-specific overrides', async () => {
    const config = {
      backgroundJobs: {
        backend: 'postgres',
        postgres: {
          connectionString:
            'postgres://localhost/jobs?options=-c%20statement_timeout%3D1000%20-c%20search_path%3Dpublic',
        },
      },
    } as ServerConfig;
    await initQueueBackend(config);
    const { connectionString } = mocks.poolOptions.mock.calls[0][0] as { connectionString: string };
    expect(new URL(connectionString).searchParams.get('options')).toBe(
      '-c statement_timeout=1000 -c search_path=public -c search_path=bullmq -c default_transaction_isolation=read\\ committed'
    );
  });

  test('releases the health client and pool when the shared listener fails to close', async () => {
    await initQueueBackend(postgres);
    mocks.connectionClose.mockRejectedValueOnce(new Error('listener close failed'));
    await expect(closeQueueBackend()).rejects.toThrow('listener close failed');
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  test('preserves startup and cleanup failures', async () => {
    const startup = new Error('migration failed');
    const cleanup = new Error('close failed');
    mocks.migrate.mockRejectedValueOnce(startup);
    mocks.end.mockRejectedValueOnce(cleanup);
    await expect(initQueueBackend(postgres)).rejects.toMatchObject({ errors: [startup, cleanup] });
  });

  test('rejects a pool too small for the enabled workers', async () => {
    const tooSmall = {
      backgroundJobs: {
        backend: 'postgres',
        postgres: { connectionString: 'postgres://localhost/jobs', maxConnections: 3 },
      },
    } as ServerConfig;
    await expect(initQueueBackend(tooSmall)).rejects.toThrow('maxConnections');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test('does not include credentials in malformed connection errors', async () => {
    const config = {
      backgroundJobs: { backend: 'postgres', postgres: { connectionString: 'postgres://user:secret@[' } },
    } as ServerConfig;
    const error = await initQueueBackend(config).then(
      () => undefined,
      (err: Error) => err
    );
    if (!(error instanceof Error)) {
      throw new Error('Expected an invalid URL error');
    }
    expect(error.message).toBe('backgroundJobs.postgres.connectionString must be a PostgreSQL URL');
    expect(error.message).not.toContain('secret');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test.each([['https://localhost/jobs', 'PostgreSQL URL']])(
    'rejects unsupported PostgreSQL connection URL %s',
    async (connectionString, message) => {
      const config = { backgroundJobs: { backend: 'postgres', postgres: { connectionString } } } as ServerConfig;
      await expect(initQueueBackend(config)).rejects.toThrow(message);
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );
});
