// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType, createReference, parseJWTPayload } from '@medplum/core';
import type { AccessPolicy, Binary, Bot, Login, ProjectMembership } from '@medplum/fhirtypes';
import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';
import { initApp, shutdownApp } from '../app';
import { getConfig, loadTestConfig } from '../config/loader';
import { getProjectSystemRepo } from '../fhir/repo';
import { getBinaryStorage } from '../storage/loader';
import { addTestUser, createTestProject } from '../test.setup';
import { getDispatchQueue, initDispatchWorker, queuedBotJobName } from '../workers/dispatch';
import type { WorkerInitializer } from '../workers/utils';

// The normal server test setup mocks BullMQ. This test must exercise the real PostgreSQL backend.
vi.unmock('bullmq');

const connectionString = process.env.MEDPLUM_TEST_QUEUE_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration('queued bot execution with PostgreSQL', () => {
  let app: express.Express;
  let token: string;
  let loginId: string;
  let membershipId: string;
  let projectId: string;
  let botId: string;
  let profileReference: string;
  let dispatch: ReturnType<WorkerInitializer>;

  beforeAll(async () => {
    const config = await loadTestConfig();
    config.backgroundJobs = {
      backend: 'postgres',
      postgres: { connectionString: connectionString as string, maxConnections: 4 },
    };
    config.vmContextBotsEnabled = true;
    config.dispatchEnabled = false;
    config.storeBotInput = false;
    app = express();
    await initApp(app, config);
    const { project } = await createTestProject();
    projectId = project.id;
    const user = await addTestUser(project);
    token = user.accessToken;
    profileReference = user.profile.resourceType + '/' + user.profile.id;
    loginId = parseJWTPayload(token).login_id as string;
    const repo = await getProjectSystemRepo(project);
    const login = await repo.readResource<Login>('Login', loginId);
    membershipId = login.membership?.reference?.split('/')[1] as string;
    const binary = await repo.createResource<Binary>({
      resourceType: 'Binary',
      meta: { project: projectId },
      contentType: 'application/javascript',
    });
    await getBinaryStorage().writeBinary(
      binary,
      undefined,
      binary.contentType,
      'exports.handler = async function (_medplum, event) { return { queued: true, requester: event.requester }; };'
    );
    const bot = await repo.createResource<Bot>({
      resourceType: 'Bot',
      meta: { project: projectId },
      name: 'Queue integration',
      runtimeVersion: 'vmcontext',
      runAsUser: true,
      executableCode: { url: 'Binary/' + binary.id },
    });
    botId = bot.id;
    config.queuedBotIds = [botId];
    dispatch = initDispatchWorker(config, { workerEnabled: true });
    await dispatch.worker?.waitUntilReady();
  });

  afterAll(async () => {
    await dispatch?.worker?.close();
    await dispatch?.queue?.close();
    await shutdownApp();
  });

  test('uses the PostgreSQL queue for HTTP execution and removes the completed job', async () => {
    const queue = getDispatchQueue();
    const add = vi.spyOn(queue, 'add');
    try {
      const response = await request(app)
        .post(`/fhir/R4/Bot/${botId}/$execute`)
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'hello' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        queued: true,
        requester: expect.objectContaining({ reference: profileReference }),
      });
      const call = add.mock.calls.find(([name]) => name === queuedBotJobName);
      expect(call).toBeDefined();
      expect(JSON.stringify(call)).not.toContain(token);
      expect(JSON.stringify(call)).not.toMatch(/refreshSecret|systemSecret|authorization|cookie/i);
      const job = await add.mock.results.find((_, i) => add.mock.calls[i][0] === queuedBotJobName)?.value;
      expect(await queue.getJob(job.id)).toBeUndefined();
    } finally {
      add.mockRestore();
    }
  });

  test('preserves HL7 wire input through the queue', async () => {
    const repo = await getProjectSystemRepo(projectId);
    const original = await repo.readResource<Bot>('Bot', botId);
    const binary = await repo.createResource<Binary>({
      resourceType: 'Binary',
      meta: { project: projectId },
      contentType: 'application/javascript',
    });
    await getBinaryStorage().writeBinary(
      binary,
      undefined,
      binary.contentType,
      'exports.handler = async function (_medplum, event) { return event.input; };'
    );
    await repo.updateResource({ ...original, executableCode: { url: 'Binary/' + binary.id } });
    const queue = getDispatchQueue();
    const add = vi.spyOn(queue, 'add');
    try {
      const text =
        'MSH|^~\\&|Main_HIS|XYZ_HOSPITAL|iFW|ABC_Lab|20160915003015||ACK|9B38584D|P|2.6.1|\r' +
        'MSA|AA|9B38584D|Everything was okay dokay!|';
      const response = await request(app)
        .post(`/fhir/R4/Bot/${botId}/$execute`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', ContentType.HL7_V2)
        .send(text);
      expect(response.status).toBe(200);
      expect(response.text).toBe(text);
      const call = add.mock.calls.find(([name]) => name === queuedBotJobName);
      expect(call?.[1]).toEqual(expect.objectContaining({ input: text }));
    } finally {
      add.mockRestore();
      await repo.updateResource(original);
    }
  });

  async function createStreamingBot(code: string): Promise<string> {
    const repo = await getProjectSystemRepo(projectId);
    const binary = await repo.createResource<Binary>({
      resourceType: 'Binary',
      meta: { project: projectId },
      contentType: 'application/javascript',
    });
    await getBinaryStorage().writeBinary(binary, undefined, binary.contentType, code);
    const bot = await repo.createResource<Bot>({
      resourceType: 'Bot',
      meta: { project: projectId },
      name: 'Queued stream',
      runtimeVersion: 'vmcontext',
      runAsUser: true,
      streamingEnabled: true,
      executableCode: { url: 'Binary/' + binary.id },
    });
    getConfig().queuedBotIds = [...(getConfig().queuedBotIds ?? []), bot.id];
    return bot.id;
  }

  test('forwards ordered streaming bytes and removes the job', async () => {
    const streamBot = await createStreamingBot(`exports.handler = async function (_, event) {
      const stream = event.responseStream;
      stream.startStreaming(201, { 'Content-Type': 'text/event-stream', 'X-Requester': event.requester.reference });
      const data = new TextEncoder().encode('data: blå\\n\\ndata: [DONE]\\n\\n');
      stream.write(data.slice(0, 10));
      stream.write(data.slice(10, 11));
      stream.write(data.slice(11));
      stream.end();
    };`);
    const queue = getDispatchQueue();
    const add = vi.spyOn(queue, 'add');
    try {
      const response = await request(app)
        .post(`/fhir/R4/Bot/${streamBot}/$execute`)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'text/event-stream')
        .send({});
      expect(response.status).toBe(201);
      expect(response.headers['x-requester']).toBe(profileReference);
      expect(response.text).toBe('data: blå\n\ndata: [DONE]\n\n');
      const index = add.mock.calls.findIndex(([name]) => name === queuedBotJobName);
      const job = await add.mock.results[index].value;
      expect(await queue.getJob(job.id)).toBeUndefined();
    } finally {
      add.mockRestore();
    }
  });

  test('forwards progress before the bot completes', async () => {
    const streamBot = await createStreamingBot(`exports.handler = async function (_, event) {
      event.responseStream.startStreaming(200, { 'Content-Type': 'text/event-stream' });
      event.responseStream.write('data: first\\n\\n');
      await require('node:timers/promises').setTimeout(1200);
      event.responseStream.end('data: last\\n\\n');
    };`);
    let firstAt = 0;
    let lastAt = 0;
    let body = '';
    await request(app)
      .post(`/fhir/R4/Bot/${streamBot}/$execute`)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({})
      .buffer(false)
      .parse((response, done) => {
        response.on('data', (chunk: Buffer) => {
          const now = Date.now();
          firstAt ||= now;
          lastAt = now;
          body += chunk.toString();
        });
        response.on('end', () => done(null, body));
      });
    expect(body).toBe('data: first\n\ndata: last\n\n');
    expect(lastAt - firstAt).toBeGreaterThan(400);
  });

  test('sends a generic terminal event if a streaming bot fails', async () => {
    const streamBot = await createStreamingBot(`exports.handler = async function (_, event) {
      event.responseStream.startStreaming(200, { 'Content-Type': 'text/event-stream' });
      event.responseStream.write('data: partial\\n\\n');
      throw new Error('private error');
    };`);
    const response = await request(app)
      .post(`/fhir/R4/Bot/${streamBot}/$execute`)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({});
    expect(response.status).toBe(200);
    expect(response.text).toBe('data: partial\n\ndata: {"error":"Bot execution failed"}\n\ndata: [DONE]\n\n');
    expect(response.text).not.toContain('private error');
  });

  test('rechecks bot access after enqueue', async () => {
    const worker = dispatch.worker as NonNullable<typeof dispatch.worker>;
    await worker.pause();
    const queue = getDispatchQueue();
    const job = await queue.add(
      queuedBotJobName,
      {
        botId,
        projectId,
        membershipId,
        loginId,
        input: {},
        contentType: 'application/json',
        deadline: Date.now() + 30_000,
      },
      { attempts: 1 }
    );
    const repo = await getProjectSystemRepo(projectId);
    const membership = await repo.readResource<ProjectMembership>('ProjectMembership', membershipId);
    try {
      const policy = await repo.createResource<AccessPolicy>({
        resourceType: 'AccessPolicy',
        meta: { project: projectId },
        resource: [{ resourceType: 'Patient', readonly: true }],
      });
      await repo.updateResource({ ...membership, accessPolicy: createReference(policy) });
      await worker.resume();
      const end = Date.now() + 15_000;
      while ((await job.getState()) !== 'failed' && Date.now() < end) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      expect(await job.getState()).toBe('failed');
      expect((await queue.getJob(job.id as string))?.failedReason).toBe('Queued bot execution failed');
    } finally {
      await repo.updateResource(membership);
      await worker.resume();
      await job.remove();
    }
  });

  test('rejects a login revoked after enqueue', async () => {
    const worker = dispatch.worker as NonNullable<typeof dispatch.worker>;
    await worker.pause();
    const queue = getDispatchQueue();
    const job = await queue.add(
      queuedBotJobName,
      {
        botId,
        projectId,
        membershipId,
        loginId,
        input: {},
        contentType: 'application/json',
        deadline: Date.now() + 30_000,
      },
      { attempts: 1 }
    );
    try {
      const repo = await getProjectSystemRepo(projectId);
      const login = await repo.readResource<Login>('Login', loginId);
      await repo.updateResource({ ...login, revoked: true });
      await worker.resume();
      const end = Date.now() + 15_000;
      while ((await job.getState()) !== 'failed' && Date.now() < end) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      expect(await job.getState()).toBe('failed');
      const stored = await queue.getJob(job.id as string);
      expect(stored?.failedReason).toBe('Queued bot execution failed');
    } finally {
      await worker.resume();
      await job.remove();
    }
  });
});
