// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getConfig } from '../config/loader';
import { getAuthenticatedContext } from '../context';
import { getGlobalSystemRepo } from '../fhir/repo';
import { getDispatchQueue } from '../workers/dispatch';
import { execQueuedBotJob, queueBotExecution } from './queued';

vi.mock('../config/loader', () => ({ getConfig: vi.fn() }));
vi.mock('../fhir/repo', () => ({ getGlobalSystemRepo: vi.fn(), getProjectSystemRepo: vi.fn() }));
vi.mock('../context', () => ({ getAuthenticatedContext: vi.fn(), runInAuthenticatedContext: vi.fn() }));
vi.mock('../workers/dispatch', () => ({ getDispatchQueue: vi.fn(), queuedBotJobName: 'QueuedBotJob' }));

describe('queued bot execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getConfig).mockReturnValue({ maxJsonSize: '12mb' } as any);
  });

  test('queues only IDs and input, polls the result, and removes the job', async () => {
    vi.mocked(getAuthenticatedContext).mockReturnValue({
      login: { id: 'login', refreshSecret: 'secret' },
      membership: { id: 'membership' },
      project: { id: 'project', secret: 'project-secret' },
      authState: { accessToken: 'bearer-secret' },
      requestId: 'request',
      traceId: 'trace',
    } as any);
    const remove = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn().mockResolvedValue({ id: 'job', remove });
    const getJob = vi.fn().mockResolvedValue({ getState: async () => 'completed', returnvalue: { success: true } });
    vi.mocked(getDispatchQueue).mockReturnValue({ add, getJob } as any);

    await expect(
      queueBotExecution({ resourceType: 'Bot', id: 'bot' }, { question: 'hello' }, 'application/json', {} as any)
    ).resolves.toEqual({ success: true });
    expect(add).toHaveBeenCalledWith(
      'QueuedBotJob',
      expect.objectContaining({ botId: 'bot', loginId: 'login', input: { question: 'hello' } }),
      expect.objectContaining({ attempts: 1 })
    );
    expect(JSON.stringify(add.mock.calls)).not.toMatch(/bearer-secret|project-secret|refreshSecret/);
    expect(getJob).toHaveBeenCalledWith('job');
    expect(remove).toHaveBeenCalledOnce();
  });

  test('removes a failed job and returns a generic error', async () => {
    vi.mocked(getAuthenticatedContext).mockReturnValue({
      login: { id: 'login' },
      membership: { id: 'membership' },
      project: { id: 'project' },
      authState: {},
    } as any);
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getDispatchQueue).mockReturnValue({
      add: vi.fn().mockResolvedValue({ id: 'job', remove }),
      getJob: vi.fn().mockResolvedValue({ getState: async () => 'failed', failedReason: 'sensitive' }),
    } as any);
    await expect(
      queueBotExecution({ resourceType: 'Bot', id: 'bot' }, {}, 'application/json', {} as any)
    ).rejects.toThrow('Queued bot execution failed');
    expect(remove).toHaveBeenCalledOnce();
  });
  test('rejects a revoked login before reading the bot', async () => {
    vi.mocked(getConfig).mockReturnValue({ queuedBotIds: ['bot'], maxJsonSize: '12mb' } as any);
    const readResource = vi.fn().mockResolvedValue({ id: 'login', revoked: true });
    vi.mocked(getGlobalSystemRepo).mockReturnValue({ readResource } as any);
    await expect(
      execQueuedBotJob({
        botId: 'bot',
        loginId: 'login',
        membershipId: 'membership',
        projectId: 'project',
        input: {},
        contentType: 'application/json',
        deadline: Date.now() + 1000,
      })
    ).rejects.toThrow('Queued bot execution failed');
    expect(readResource).toHaveBeenCalledTimes(1);
  });
});
