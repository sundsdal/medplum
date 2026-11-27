// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { sleep } from '@medplum/core';
import type { Meter } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { vi } from 'vitest';
import { loadTestConfig } from '../config/loader';
import * as databaseModule from '../database';
import { DatabaseMode } from '../database';
import { GLOBAL_SHARD_ID } from '../fhir/sharding';
import { heartbeat } from '../heartbeat';
import { globalLogger } from '../logger';
import { TEST_SHARD_ID } from '../test.setup';
import * as batchModule from '../workers/batch';
import * as cronModule from '../workers/cron';
import * as downloadModule from '../workers/download';
import * as setAccountsModule from '../workers/set-accounts';
import * as subscriptionModule from '../workers/subscription';
import {
  addToUpDownCounter,
  cleanupOtelHeartbeat,
  getGauge,
  getQueueMetricName,
  getUpDownCounter,
  incrementCounter,
  initOtelHeartbeat,
  recordHistogramValue,
  setGauge,
} from './otel';

const createMockQueue = (): {
  getJobCounts: ReturnType<typeof vi.fn>;
} => ({
  getJobCounts: vi.fn().mockResolvedValue({ waiting: 5, delayed: 3, active: 2 }),
});

let mockSharedQueue: ReturnType<typeof createMockQueue> | undefined = createMockQueue();

// Without a registered SDK, `metrics.getMeter()` returns a no-op meter whose instruments are shared
// singletons across every metric name, so spying on one cannot distinguish metrics. Mocking the meter
// gives each name its own mock. otel.ts memoizes instruments by name, so the mock must be installed
// before the first instrument is created.
const gaugeRecorders = new Map<string, ReturnType<typeof vi.fn>>();

function gaugeRecorder(name: string): ReturnType<typeof vi.fn> {
  let record = gaugeRecorders.get(name);
  if (!record) {
    record = vi.fn();
    gaugeRecorders.set(name, record);
  }
  return record;
}

function mockQueueGetters(queue: ReturnType<typeof createMockQueue> | undefined): void {
  vi.spyOn(subscriptionModule, 'getSubscriptionQueue').mockReturnValue(queue as never);
  vi.spyOn(cronModule, 'getCronQueue').mockReturnValue(queue as never);
  vi.spyOn(downloadModule, 'getDownloadQueue').mockReturnValue(queue as never);
  vi.spyOn(batchModule, 'getBatchQueue').mockReturnValue(queue as never);
  vi.spyOn(setAccountsModule, 'getSetAccountsQueue').mockReturnValue(queue as never);
}

describe('OpenTelemetry', () => {
  const OLD_ENV = process.env;

  beforeAll(async () => {
    await loadTestConfig({ sharded: true });
    vi.spyOn(metrics, 'getMeter').mockReturnValue({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
      createUpDownCounter: () => ({ add: vi.fn() }),
      createGauge: (name: string) => ({ record: gaugeRecorder(name) }),
    } as unknown as Meter);
  });

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.OTLP_METRICS_ENDPOINT;
    // Reset mockSharedQueue to a fresh queue for each test
    mockSharedQueue = createMockQueue();
    mockQueueGetters(mockSharedQueue);
    cleanupOtelHeartbeat();
    for (const record of gaugeRecorders.values()) {
      record.mockClear();
    }
  });

  afterAll(async () => {
    process.env = OLD_ENV;
    cleanupOtelHeartbeat();
    vi.restoreAllMocks();
  });

  test('Increment counter, disabled', async () => {
    expect(incrementCounter('test')).toBe(false);
  });

  test('Increment counter, enabled', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(incrementCounter('test')).toBe(true);
  });

  test('Increment counter, enabled, attributes specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(incrementCounter('test', { attributes: { hostname: 'https://example.com' } })).toBe(true);
  });

  test('Increment counter, enabled, options specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(incrementCounter('test', { options: { unit: 's' } })).toBe(true);
  });

  test('Record histogram value, disabled', async () => {
    expect(recordHistogramValue('test', 1)).toBe(false);
  });

  test('Record histogram value, enabled', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(recordHistogramValue('test', 1)).toBe(true);
  });

  test('Record histogram value, enabled, attributes specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(recordHistogramValue('test', 1, { attributes: { hostname: 'https://example.com' } })).toBe(true);
  });

  test('Record histogram value, enabled, options specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(recordHistogramValue('test', 1, { options: { unit: 's' } })).toBe(true);
  });

  test('Set gauge, disabled', async () => {
    expect(setGauge('test', 1)).toBe(false);
  });

  test('Set gauge, enabled', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(setGauge('test', 1)).toBe(true);
  });

  test('Set gauge, enabled, attributes specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(setGauge('test', 1, { attributes: { hostname: 'https://example.com' } })).toBe(true);
  });

  test('Set gauge, enabled, options specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(setGauge('test', 1, { options: { unit: 's' } })).toBe(true);
    getGauge('test');
  });

  test('Get queue metric name', () => {
    expect(getQueueMetricName('batch', 'activeCount')).toBe('medplum.batch.activeCount');
    expect(getQueueMetricName('set-accounts', 'waitingCount')).toBe('medplum.set-accounts.waitingCount');
    expect(getQueueMetricName('subscription', 'inFlightJobs')).toBe('medplum.subscription.inFlightJobs');
    expect(getQueueMetricName('cron', 'jobsCompleted')).toBe('medplum.cron.jobsCompleted');
  });

  test('Add to up down counter, disabled', async () => {
    expect(addToUpDownCounter('test', 1)).toBe(false);
  });

  test('Add to up down counter, enabled', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(addToUpDownCounter('test', 1)).toBe(true);
    expect(addToUpDownCounter('test', -1)).toBe(true);
  });

  test('Add to up down counter, enabled, attributes and options specified', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    expect(addToUpDownCounter('test', 1, { attributes: { queue: 'batch' }, options: { unit: '{job}' } })).toBe(true);
    getUpDownCounter('test');
  });

  test('initOtelHeartbeat', () => {
    const heartbeatAddListenerSpy = vi.spyOn(heartbeat, 'addEventListener');
    const heartbeatRemoveListenerSpy = vi.spyOn(heartbeat, 'removeEventListener');

    // Init otel heartbeat
    initOtelHeartbeat();
    expect(heartbeatAddListenerSpy).toHaveBeenCalled();

    heartbeatAddListenerSpy.mockClear();

    // Call init again, no-op
    initOtelHeartbeat();
    expect(heartbeatAddListenerSpy).not.toHaveBeenCalled();

    // Cleanup heartbeat
    cleanupOtelHeartbeat();
    expect(heartbeatRemoveListenerSpy).toHaveBeenCalled();

    heartbeatRemoveListenerSpy.mockClear();

    // Cleanup heartbeat again, no-op
    cleanupOtelHeartbeat();
    expect(heartbeatRemoveListenerSpy).not.toHaveBeenCalled();
  });

  test('initOtelHeartbeat throws without registering a listener when a queue is missing', () => {
    const heartbeatAddListenerSpy = vi.spyOn(heartbeat, 'addEventListener');
    vi.spyOn(batchModule, 'getBatchQueue').mockReturnValue(undefined);
    vi.spyOn(setAccountsModule, 'getSetAccountsQueue').mockReturnValue(undefined);

    expect(() => initOtelHeartbeat()).toThrow('Queues not initialized: batch, set-accounts');
    expect(heartbeatAddListenerSpy).not.toHaveBeenCalled();

    // A failed init must not block a later one once the queues exist
    mockQueueGetters(mockSharedQueue);
    initOtelHeartbeat();
    expect(heartbeatAddListenerSpy).toHaveBeenCalledTimes(1);
  });

  test('does not read queue counts without a metrics exporter', async () => {
    const getDatabasePoolSpy = vi.spyOn(databaseModule, 'getDatabasePool').mockReturnValue({} as Pool);
    initOtelHeartbeat();
    heartbeat.dispatchEvent({ type: 'heartbeat' });
    await sleep(0);
    expect(mockSharedQueue?.getJobCounts).not.toHaveBeenCalled();
    getDatabasePoolSpy.mockRestore();
  });

  test('collects queue metrics on the configured cadence independently of heartbeat', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    vi.useFakeTimers();
    const getDatabasePoolSpy = vi.spyOn(databaseModule, 'getDatabasePool').mockReturnValue({} as Pool);
    try {
      initOtelHeartbeat({ queueMetricsIntervalMilliseconds: 1000 });
      heartbeat.dispatchEvent({ type: 'heartbeat' });
      await vi.advanceTimersByTimeAsync(999);
      expect(mockSharedQueue?.getJobCounts).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSharedQueue?.getJobCounts).toHaveBeenCalledTimes(5);
      expect(gaugeRecorder('medplum.batch.waitingCount')).toHaveBeenCalledWith(5, undefined);
      cleanupOtelHeartbeat();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSharedQueue?.getJobCounts).toHaveBeenCalledTimes(5);
    } finally {
      cleanupOtelHeartbeat();
      getDatabasePoolSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('does not overlap samples and discards results after cleanup', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    vi.useFakeTimers();
    let resolveCounts: ((counts: { waiting: number; delayed: number; active: number }) => void) | undefined;
    mockSharedQueue?.getJobCounts.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCounts = resolve;
        })
    );
    try {
      initOtelHeartbeat({ queueMetricsIntervalMilliseconds: 1000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockSharedQueue?.getJobCounts).toHaveBeenCalledTimes(1);
      cleanupOtelHeartbeat();
      resolveCounts?.({ waiting: 5, delayed: 3, active: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(gaugeRecorder('medplum.subscription.waitingCount')).not.toHaveBeenCalled();
    } finally {
      cleanupOtelHeartbeat();
      vi.useRealTimers();
    }
  });

  test('retries queue sampling after an error', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(globalLogger, 'error').mockImplementation(() => undefined);
    mockSharedQueue?.getJobCounts.mockRejectedValueOnce(new Error('unavailable'));
    try {
      initOtelHeartbeat({ queueMetricsIntervalMilliseconds: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(errorSpy).toHaveBeenCalled();
      expect(mockSharedQueue?.getJobCounts).toHaveBeenCalledTimes(5);
      expect(gaugeRecorder('medplum.subscription.waitingCount')).not.toHaveBeenCalled();
      expect(gaugeRecorder('medplum.batch.activeCount')).toHaveBeenCalledWith(2, undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSharedQueue?.getJobCounts).toHaveBeenCalledTimes(10);
      expect(gaugeRecorder('medplum.subscription.waitingCount')).toHaveBeenCalledWith(5, undefined);
    } finally {
      cleanupOtelHeartbeat();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('heartbeat disabled prevents scheduled queue sampling', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    vi.useFakeTimers();
    try {
      initOtelHeartbeat({ heartbeatEnabled: false, queueMetricsIntervalMilliseconds: 1000 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockSharedQueue?.getJobCounts).not.toHaveBeenCalled();
    } finally {
      cleanupOtelHeartbeat();
      vi.useRealTimers();
    }
  });

  test('Heartbeat listener records queue metrics for all queues', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    if (!mockSharedQueue) {
      throw new Error('Expected mock queue');
    }

    const getDatabasePoolSpy = vi.spyOn(databaseModule, 'getDatabasePool').mockImplementation(
      () =>
        ({
          query: async () => undefined,
        }) as unknown as Pool
    );

    initOtelHeartbeat();

    heartbeat.dispatchEvent({ type: 'heartbeat' });

    // Wait for heartbeat listener callback next tick
    await sleep(0);

    // We call getDatabasePool at the beginning of the listener callback
    expect(getDatabasePoolSpy).toHaveBeenCalled();

    // Every queue is read: subscription, cron, download, batch, set-accounts
    expect(mockSharedQueue.getJobCounts).toHaveBeenCalledTimes(5);
    expect(mockSharedQueue.getJobCounts).toHaveBeenCalledWith('waiting', 'delayed', 'active');

    // Each count is published under its per-queue metric name, carrying the mocked value
    expect(gaugeRecorder('medplum.batch.waitingCount')).toHaveBeenCalledWith(5, undefined);
    expect(gaugeRecorder('medplum.batch.delayedCount')).toHaveBeenCalledWith(3, undefined);
    expect(gaugeRecorder('medplum.batch.activeCount')).toHaveBeenCalledWith(2, undefined);
    expect(gaugeRecorder('medplum.set-accounts.activeCount')).toHaveBeenCalledWith(2, undefined);

    cleanupOtelHeartbeat();
    getDatabasePoolSpy.mockRestore();
  });

  test('Heartbeat listener records other metrics when a queue disappears after startup', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';
    if (!mockSharedQueue) {
      throw new Error('Expected mock queue');
    }

    const getDatabasePoolSpy = vi.spyOn(databaseModule, 'getDatabasePool').mockImplementation(
      () =>
        ({
          query: async () => undefined,
        }) as unknown as Pool
    );

    initOtelHeartbeat();
    vi.spyOn(batchModule, 'getBatchQueue').mockReturnValue(undefined);
    heartbeat.dispatchEvent({ type: 'heartbeat' });
    await sleep(0);

    // writer + reader for each shard
    expect(getDatabasePoolSpy).toHaveBeenCalledTimes(4);
    expect(getDatabasePoolSpy).toHaveBeenCalledWith(DatabaseMode.WRITER, GLOBAL_SHARD_ID);
    expect(getDatabasePoolSpy).toHaveBeenCalledWith(DatabaseMode.READER, GLOBAL_SHARD_ID);
    expect(getDatabasePoolSpy).toHaveBeenCalledWith(DatabaseMode.WRITER, TEST_SHARD_ID);
    expect(getDatabasePoolSpy).toHaveBeenCalledWith(DatabaseMode.READER, TEST_SHARD_ID);

    // The four remaining queues are still read and published
    expect(mockSharedQueue.getJobCounts).toHaveBeenCalledTimes(4);
    expect(gaugeRecorder('medplum.cron.waitingCount')).toHaveBeenCalledWith(5, undefined);
    expect(gaugeRecorder('medplum.set-accounts.activeCount')).toHaveBeenCalledWith(2, undefined);

    // The missing queue is skipped
    expect(gaugeRecorder('medplum.batch.waitingCount')).not.toHaveBeenCalled();
    expect(gaugeRecorder('medplum.batch.delayedCount')).not.toHaveBeenCalled();
    expect(gaugeRecorder('medplum.batch.activeCount')).not.toHaveBeenCalled();

    cleanupOtelHeartbeat();
    getDatabasePoolSpy.mockRestore();
  });
});
