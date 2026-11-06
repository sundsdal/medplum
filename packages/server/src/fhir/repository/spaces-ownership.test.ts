// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType, createReference } from '@medplum/core';
import type { Communication, Login } from '@medplum/fhirtypes';
import express from 'express';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { initApp, shutdownApp } from '../../app';
import { getConfig, loadTestConfig } from '../../config/loader';
import { addTestUser, createTestProject } from '../../test.setup';
import { getRepoForLogin } from '../accesspolicy';
import { getGlobalSystemRepo, getProjectSystemRepo } from '../repo';

const system = 'http://medplum.com/ai-message';
const identifier = (value: string): Communication['identifier'] => [{ system, value }];
const app = express();

describe('Spaces ownership', () => {
  beforeAll(async () => {
    const config = await loadTestConfig();
    config.spacesOwnedConversationsEnabled = true;
    await initApp(app, config);
  });
  afterAll(async () => shutdownApp());

  test('does not change ordinary Communications or apply when disabled', async () => {
    const { repo } = await createTestProject({ withRepo: true });
    const prompt: Communication = {
      resourceType: 'Communication',
      status: 'completed',
      identifier: [{ system: 'http://medplum.com/ai-spaces', value: 'ai-message' }],
    };
    await expect(repo.createResource(prompt)).resolves.toBeDefined();
    getConfig().spacesOwnedConversationsEnabled = false;
    try {
      await expect(repo.createResource({ ...prompt, identifier: identifier('ai-message') })).resolves.toBeDefined();
    } finally {
      getConfig().spacesOwnedConversationsEnabled = true;
    }
  });

  test('enforces topic ownership for repository and FHIR writes', async () => {
    const linked = await createTestProject({ project: { exportedResourceType: ['Communication'] } });
    const { project } = await createTestProject({
      project: { link: [{ project: createReference(linked.project) }] },
    });
    const { profile, membership, accessToken } = await addTestUser(project, {
      accessPolicy: {
        resourceType: 'AccessPolicy',
        resource: [
          { resourceType: 'Communication', interaction: ['read', 'search'] },
          ...['ai-message-topic', 'ai-message'].map((kind) => ({
            resourceType: 'Communication' as const,
            interaction: ['create', 'update'] as ('create' | 'update')[],
            criteria: `Communication?sender=%profile&identifier=${encodeURIComponent(`${system}|${kind}`)}`,
          })),
        ],
      },
    });
    const admin = await getProjectSystemRepo(project);
    const loginId = decodeJwt(accessToken).login_id;
    if (typeof loginId !== 'string') {
      throw new Error('Missing login ID');
    }
    const login = await getGlobalSystemRepo().readResource<Login>('Login', loginId);
    const repo = await getRepoForLogin(
      { login, project, membership, profile, userConfig: { resourceType: 'UserConfiguration' } },
      true
    );
    const sender = createReference(profile);
    const topic: Communication = {
      resourceType: 'Communication',
      status: 'completed',
      identifier: identifier('ai-message-topic'),
      sender,
    };
    const own = await repo.createResource(topic);
    const message: Communication = {
      resourceType: 'Communication',
      status: 'completed',
      identifier: identifier('ai-message'),
      sender,
      partOf: [createReference(own)],
    };
    await expect(repo.createResource(message)).resolves.toBeDefined();
    await expect(repo.updateResource({ ...own, topic: { text: 'Updated' } })).resolves.toBeDefined();

    const other = await admin.createResource({
      ...topic,
      meta: { project: project.id },
      sender: { reference: `Practitioner/${randomUUID()}` },
    });
    const clinical = await admin.createResource<Communication>({
      resourceType: 'Communication',
      status: 'completed',
      sender,
      meta: { project: project.id },
    });
    const linkedAdmin = await getProjectSystemRepo(linked.project);
    const linkedTopic = await linkedAdmin.createResource({ ...topic, meta: { project: linked.project.id } });
    await expect(repo.readResource('Communication', linkedTopic.id)).resolves.toBeDefined();
    const child = await repo.createResource(message);
    for (const parent of [other.id, clinical.id, child.id, linkedTopic.id, randomUUID()]) {
      await expect(
        repo.createResource({ ...message, partOf: [{ reference: `Communication/${parent}` }] })
      ).rejects.toThrow();
    }
    for (const partOf of [
      [],
      [{ reference: `https://example.com/Communication/${own.id}` }],
      [{ reference: 'Communication?status=completed' }],
      [createReference(own), createReference(own)],
    ]) {
      await expect(repo.createResource({ ...message, partOf })).rejects.toThrow();
    }
    await expect(repo.createResource({ ...topic, partOf: [createReference(own)] })).rejects.toThrow();
    await expect(repo.createResource({ ...message, sender: other.sender })).rejects.toThrow();
    await expect(repo.updateResource({ ...child, partOf: [createReference(other)] })).rejects.toThrow();
    await expect(repo.updateResource({ ...own, identifier: undefined })).rejects.toThrow();
    await expect(repo.updateResource({ ...clinical, identifier: identifier('ai-message-topic') })).rejects.toThrow();
    await expect(repo.readResource('Communication', clinical.id)).resolves.toBeDefined();

    const write = (body: Communication): request.Test =>
      request(app)
        .post('/fhir/R4/Communication')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Content-Type', ContentType.FHIR_JSON)
        .send(body);
    const ownWrite = await write(message);
    expect(ownWrite.body).toMatchObject({ resourceType: 'Communication' });
    expect(ownWrite.status).toBe(201);
    expect((await write({ ...message, partOf: [createReference(other)] })).status).toBeGreaterThanOrEqual(400);
    expect((await write({ ...message, sender: other.sender })).status).toBeGreaterThanOrEqual(400);
    const relabel = await request(app)
      .put(`/fhir/R4/Communication/${clinical.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({ ...clinical, identifier: identifier('ai-message-topic') });
    expect(relabel.status).toBeGreaterThanOrEqual(400);
  });
});
