// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotResponseStream } from '@medplum/core';
import { badRequest, Hl7Message, OperationOutcomeError, resolveId } from '@medplum/core';
import type { Bot, Login, Project, ProjectMembership } from '@medplum/fhirtypes';
import type { Job } from 'bullmq';
import bytes from 'bytes';
import type { Response } from 'express';
import { getUserConfiguration } from '../auth/me';
import { getConfig } from '../config/loader';
import { getAuthenticatedContext, runInAuthenticatedContext } from '../context';
import { getInactiveReason } from '../fhir/projectmembership';
import { getGlobalSystemRepo, getProjectSystemRepo } from '../fhir/repo';
import { getDispatchQueue, queuedBotJobName } from '../workers/dispatch';
import { executeBot } from './execute';
import type { QueuedStreamProgress } from './queued-stream';
import { QueuedBotStream } from './queued-stream';
import type { BotExecutionResult } from './types';
import { getBotProjectMembership } from './utils';

const DEADLINE_MS = 120_000;

export interface QueuedBotJobData {
  readonly botId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly loginId: string;
  readonly input: unknown;
  readonly contentType: string;
  readonly deadline: number;
  readonly streaming?: boolean;
  readonly requestId?: string;
  readonly traceId?: string;
}

function checkSize(value: unknown): void {
  const json = JSON.stringify(value);
  const limit = bytes(getConfig().maxJsonSize);
  if (json === undefined || limit === null || Buffer.byteLength(json) > limit) {
    throw new OperationOutcomeError(badRequest('Queued bot data exceeds the configured JSON size limit'));
  }
}

export async function queueBotExecution(
  bot: Bot,
  input: unknown,
  contentType: string,
  res: Response,
  responseStream?: BotResponseStream
): Promise<BotExecutionResult> {
  const ctx = getAuthenticatedContext();
  if (!bot.id || !ctx.login.id || ctx.authState.onBehalfOfMembership || ctx.authState.onBehalfOf) {
    throw new OperationOutcomeError(badRequest('Queued bot execution requires a native login without delegation'));
  }
  const queuedInput = input instanceof Hl7Message ? input.toString() : input;
  checkSize(queuedInput);
  const data: QueuedBotJobData = {
    botId: bot.id,
    projectId: ctx.project.id,
    membershipId: ctx.membership.id,
    loginId: ctx.login.id,
    input: queuedInput,
    contentType,
    deadline: Date.now() + DEADLINE_MS,
    streaming: !!responseStream,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
  };
  const queue = getDispatchQueue();
  const job = await queue.add(queuedBotJobName, data, {
    attempts: 1,
    removeOnComplete: { age: 120 },
    removeOnFail: { age: 120 },
  });
  const deadline = data.deadline;
  let seenChunks = 0;
  let streamStarted = false;
  const forward = (progress: unknown): void => {
    if (
      !responseStream ||
      !progress ||
      typeof progress !== 'object' ||
      (progress as QueuedStreamProgress).kind !== 'bot-stream'
    ) {
      return;
    }
    const snapshot = progress as QueuedStreamProgress;
    if (!streamStarted) {
      responseStream.startStreaming(snapshot.status, snapshot.headers);
      streamStarted = true;
    }
    for (const chunk of snapshot.chunks.slice(seenChunks)) {
      responseStream.write(Buffer.from(chunk, 'base64'));
    }
    seenChunks = snapshot.chunks.length;
    (responseStream as BotResponseStream & { flush?: () => void }).flush?.();
  };
  try {
    while (Date.now() < deadline && !res.destroyed) {
      let current = await queue.getJob(job.id as string);
      if (!current) {
        throw new Error('Queued bot job unavailable');
      }
      const state = await current.getState();
      // getState reads current storage but the job itself may predate completion.
      if (state === 'completed' || state === 'failed') {
        current = await queue.getJob(job.id as string);
        if (!current) {
          throw new Error('Queued bot job unavailable');
        }
      }
      forward(current.progress);
      if (state === 'completed') {
        const result = current.returnvalue as BotExecutionResult;
        if (streamStarted && !result.success) {
          throw new Error('Queued bot execution failed');
        }
        return result;
      }
      if (state === 'failed') {
        throw new Error('Queued bot execution failed');
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    throw new Error('Queued bot execution timed out or client disconnected');
  } catch (error) {
    if (responseStream && res.headersSent) {
      if (!res.destroyed && !res.writableEnded) {
        responseStream.write('data: {"error":"Bot execution failed"}\n\ndata: [DONE]\n\n');
        responseStream.end();
      }
      return { success: false, logResult: 'Queued bot execution failed' };
    }
    throw error;
  } finally {
    // Active jobs cannot be removed; retention handles them once they finish.
    await job.remove().catch(() => undefined);
  }
}

export async function execQueuedBotJob(
  data: QueuedBotJobData,
  job?: Job<QueuedBotJobData>
): Promise<BotExecutionResult> {
  try {
    if (Date.now() >= data.deadline || !getConfig().queuedBotIds?.includes(data.botId)) {
      throw new Error('Bot no longer queued');
    }
    const global = getGlobalSystemRepo();
    const login = await global.readResource<Login>('Login', data.loginId);
    if (login.revoked || resolveId(login.membership) !== data.membershipId) {
      throw new Error('Login revoked or changed');
    }
    const membership = await global.readResource<ProjectMembership>('ProjectMembership', data.membershipId);
    const project = await global.readResource<Project>('Project', data.projectId);
    if (resolveId(membership.project) !== project.id || getInactiveReason(project, membership)) {
      throw new Error('Membership revoked or changed');
    }
    const systemRepo = await getProjectSystemRepo(project);
    const userConfig = await getUserConfiguration(systemRepo, project, membership);
    const smartAppLaunch = login.launch ? await systemRepo.readReference(login.launch) : undefined;
    return await runInAuthenticatedContext(
      { login, membership, project, userConfig, smartAppLaunch },
      data.requestId,
      data.traceId,
      undefined,
      async () => {
        const ctx = getAuthenticatedContext();
        await ctx.repo.readResource<Bot>('Bot', data.botId);
        const bot = await ctx.systemRepo.readResource<Bot>('Bot', data.botId);
        if (data.streaming && (!bot.streamingEnabled || !job)) {
          throw new Error('Streaming configuration changed');
        }
        const stream = data.streaming && job ? new QueuedBotStream(job) : undefined;
        let result: BotExecutionResult;
        try {
          result = await executeBot({
            bot,
            runAs: await getBotProjectMembership(ctx, bot),
            runAsProject: ctx.project,
            requester: ctx.membership.profile,
            input: data.input,
            contentType: data.contentType,
            traceId: data.traceId,
            responseStream: stream,
          });
        } finally {
          await stream?.flushProgress();
        }
        checkSize(result);
        return result;
      }
    );
  } catch {
    // Do not persist exception messages, which may contain input or clinical data.
    throw new Error('Queued bot execution failed');
  }
}
