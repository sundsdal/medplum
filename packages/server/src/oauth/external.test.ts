// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { ProfileResource, WithId } from '@medplum/core';
import { encodeBase64Url, getReferenceString } from '@medplum/core';
import type { Practitioner, Project, ProjectMembership } from '@medplum/fhirtypes';
import { randomUUID } from 'crypto';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { vi } from 'vitest';
import { inviteUser } from '../admin/invite';
import { initApp, shutdownApp } from '../app';
import { getConfig, loadTestConfig } from '../config/loader';
import type { MedplumExternalAuthConfig } from '../config/types';
import type { SystemRepository } from '../fhir/repo';
import { getProjectSystemRepo } from '../fhir/repo';
import { addTestUser, createTestProject } from '../test.setup';
import { mockFetchJson } from '../test.setup.fetch';
import { verifyExternalToken } from './utils';

// RFC 7662 - External auth

const fetchMock = vi.spyOn(globalThis, 'fetch');
describe('External auth', () => {
  const app = express();
  const npi = randomUUID();
  const externalSub = randomUUID();
  let testProject: WithId<Project>;
  let practitioner: WithId<ProfileResource>;
  let systemRepo: SystemRepository;

  beforeAll(async () => {
    const config = await loadTestConfig();
    config.externalAuthProviders = [
      {
        issuer: 'https://external-auth.example.com',
        userInfoUrl: 'https://external-auth.example.com/oauth2/userinfo',
      },
    ];

    // Initialize the app with the test config
    await initApp(app, config);

    // Create a test project
    const { project } = await createTestProject();
    testProject = project;

    // Invite a normal Practitioner user to the project
    const inviteResult = await inviteUser({
      project,
      resourceType: 'Practitioner',
      firstName: 'Test',
      lastName: 'Person',
    });
    systemRepo = await getProjectSystemRepo(project);

    // Add NPI identifier to the practitioner
    practitioner = await systemRepo.updateResource<ProfileResource>({
      ...inviteResult.profile,
      identifier: [{ system: 'npi', value: npi }],
    });

    // Invite a Practitioner with externalId for sub claim tests
    await inviteUser({
      project,
      resourceType: 'Practitioner',
      firstName: 'External',
      lastName: 'User',
      externalId: externalSub,
    });
  });

  afterAll(async () => {
    await shutdownApp();
  });

  test('Not a JWT', async () => {
    const res = await request(app).get(`/oauth2/userinfo`).set('Authorization', 'Bearer opaque_string');
    expect(res).toHaveStatus(401);
  });

  test('Missing issuer', async () => {
    const jwt = createFakeJwt({ foo: 'bar' });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Unknown issuer', async () => {
    const jwt = createFakeJwt({ iss: 'https://unknown-issuer.example.com' });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Missing fhirUser and sub', async () => {
    const jwt = createFakeJwt({ iss: 'https://external-auth.example.com' });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Rejects provider without a verification URL', async () => {
    await withExternalAuthProviders(
      [
        {
          issuer: 'https://external-auth.example.com',
          identityProvider: { issuer: 'https://external-auth.example.com' },
        },
      ],
      async () => {
        const jwt = createFakeJwt({
          iss: 'https://external-auth.example.com',
          sub: externalSub,
          nonce: randomUUID(),
        });
        const res = await request(app)
          .get('/oauth2/userinfo')
          .set('Authorization', 'Bearer ' + jwt);
        expect(res).toHaveStatus(401);
      }
    );
  });

  test('Project-scoped request maps an identity-less token to the issuer client', async () => {
    const keyPair = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(keyPair.publicKey);
    const jwksUrl = 'https://external-auth.example.com/.well-known/project-jwks.json';
    const { client, project } = await createTestProject({
      withClient: true,
      client: {
        identityProvider: {
          issuer: 'https://external-auth.example.com',
          jwksUrl,
        },
      },
    });
    await withExternalAuthProviders(undefined, async () => {
      fetchMock.mockImplementationOnce(() => mockFetchJson({ keys: [publicJwk] }));

      const jwt = await new SignJWT({ nonce: randomUUID() })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('https://external-auth.example.com')
        .setSubject('external-client-subject')
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(keyPair.privateKey);
      const res = await request(app)
        .get(`/projects/${project.id}/oauth2/userinfo`)
        .set('Authorization', 'Bearer ' + jwt);

      expect(res).toHaveStatus(200);
      expect(res.body.sub).toBe(client.id);
    });
  });

  test('Project-scoped client token honors on-behalf-of and extended mode', async () => {
    const keyPair = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(keyPair.publicKey);
    const { client, project } = await createTestProject({
      withClient: true,
      membership: { admin: true },
      client: {
        identityProvider: {
          issuer: 'https://external-auth.example.com',
          jwksUrl: 'https://external-auth.example.com/.well-known/obo-jwks.json',
        },
      },
    });
    const { profile } = await addTestUser(project);
    await withExternalAuthProviders(undefined, async () => {
      fetchMock.mockImplementationOnce(() => mockFetchJson({ keys: [publicJwk] }));

      const jwt = await new SignJWT({ nonce: randomUUID() })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('https://external-auth.example.com')
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(keyPair.privateKey);
      const res = await request(app)
        .post(`/projects/${project.id}/fhir/R4/Patient`)
        .set('Authorization', 'Bearer ' + jwt)
        .set('X-Medplum', 'extended')
        .set('X-Medplum-On-Behalf-Of', getReferenceString(profile))
        .send({ resourceType: 'Patient' });

      expect(res).toHaveStatus(201);
      expect(res.body.meta.project).toBe(project.id);
      expect(res.body.meta.author.reference).toBe(getReferenceString(client));
      expect(res.body.meta.onBehalfOf.reference).toBe(getReferenceString(profile));
    });
  });

  test('Identity-less token cache is scoped by URL project', async () => {
    const first = await createTestProject({
      withClient: true,
      client: {
        identityProvider: {
          issuer: 'https://external-auth.example.com',
          userInfoUrl: 'https://external-auth.example.com/oauth2/userinfo',
        },
      },
    });
    const second = await createTestProject({
      withClient: true,
      client: {
        identityProvider: {
          issuer: 'https://external-auth.example.com',
          userInfoUrl: 'https://external-auth.example.com/oauth2/userinfo',
        },
      },
    });
    await withExternalAuthProviders(undefined, async () => {
      fetchMock
        .mockImplementationOnce(() => mockFetchJson({ ok: true }))
        .mockImplementationOnce(() => mockFetchJson({ ok: true }));

      const jwt = createFakeJwt({
        iss: 'https://external-auth.example.com',
        nonce: randomUUID(),
      });
      const firstResponse = await request(app)
        .get(`/projects/${first.project.id}/oauth2/userinfo`)
        .set('Authorization', 'Bearer ' + jwt);
      const secondResponse = await request(app)
        .get(`/projects/${second.project.id}/oauth2/userinfo`)
        .set('Authorization', 'Bearer ' + jwt);

      expect(firstResponse).toHaveStatus(200);
      expect(firstResponse.body.sub).toBe(first.client.id);
      expect(secondResponse).toHaveStatus(200);
      expect(secondResponse.body.sub).toBe(second.client.id);
    });
  });

  test('Global provider resolves an identity-less token to the project client', async () => {
    const { client, project } = await createTestProject({
      withClient: true,
      client: {
        identityProvider: {
          issuer: 'https://external-auth.example.com',
          userInfoUrl: 'https://external-auth.example.com/oauth2/userinfo',
        },
      },
    });
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({ iss: 'https://external-auth.example.com', nonce: randomUUID() });
    const res = await request(app)
      .get(`/projects/${project.id}/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);

    expect(res).toHaveStatus(200);
    expect(res.body.sub).toBe(client.id);
  });

  test('Rejects ambiguous project clients for an external issuer', async () => {
    const { project } = await createTestProject({
      withClient: true,
      client: {
        identityProvider: {
          issuer: 'https://ambiguous.example.com',
          userInfoUrl: 'https://ambiguous.example.com/oauth2/userinfo',
        },
      },
    });
    const projectRepo = await getProjectSystemRepo(project);
    await projectRepo.createResource({
      resourceType: 'ClientApplication',
      meta: { project: project.id },
      name: 'Duplicate external issuer',
      identityProvider: {
        issuer: 'https://ambiguous.example.com',
        userInfoUrl: 'https://ambiguous.example.com/oauth2/userinfo',
      },
    });

    await withExternalAuthProviders(undefined, async () => {
      const jwt = createFakeJwt({ iss: 'https://ambiguous.example.com', nonce: randomUUID() });
      const res = await request(app)
        .get(`/projects/${project.id}/oauth2/userinfo`)
        .set('Authorization', 'Bearer ' + jwt);
      expect(res).toHaveStatus(401);
    });
  });

  test('Remote call to userinfo fails', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: false }, { status: 401 }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: getReferenceString(practitioner),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Profile not found', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: 'Patient/123',
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Profile without membership', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    // Create a Practitioner profile that is not a member of the project
    const p2 = await systemRepo.createResource<Practitioner>({ resourceType: 'Practitioner' });
    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: getReferenceString(p2),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Success by reference', async () => {
    fetchMock.mockImplementation(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: getReferenceString(practitioner),
      scope: 'openid profile',
      nonce: randomUUID(),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);

    // Call it again to ensure caching works
    const res2 = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res2).toHaveStatus(200);
  });

  test('Login is listed as a session', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    // Use a fresh user, so that only this login is in the list
    const { profile } = await inviteUser({
      project: testProject,
      resourceType: 'Practitioner',
      firstName: 'Session',
      lastName: 'User',
    });

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: getReferenceString(profile),
    });
    const res = await request(app)
      .get(`/auth/me`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
    expect(res.body.security.sessions).toHaveLength(1);
    expect(res.body.security.sessions[0].authMethod).toStrictEqual('external');
  });

  test('Success by search string', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: `Practitioner?identifier=${npi}`,
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
  });

  test('Success by absolute URL', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: `https://external.idp/fhir/Practitioner?identifier=${npi}`,
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
  });

  test('Success by ext.fhirUser', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      ext: { fhirUser: getReferenceString(practitioner) },
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
  });

  test('Success by sub claim', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: externalSub,
      scope: 'openid profile',
      nonce: randomUUID(),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
  });

  test('Success by JWKS verification', async () => {
    const keyPair = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(keyPair.publicKey);
    const jwksUrl = 'https://external-auth.example.com/.well-known/jwks.json';

    await withExternalAuthProviders(
      [
        {
          issuer: 'https://external-auth.example.com',
          identityProvider: {
            issuer: 'https://external-auth.example.com',
            jwksUrl,
          },
        },
      ],
      async () => {
        fetchMock.mockImplementationOnce(() => mockFetchJson({ keys: [publicJwk] }));

        const jwt = await new SignJWT({
          nonce: randomUUID(),
        })
          .setProtectedHeader({ alg: 'ES256' })
          .setIssuer('https://external-auth.example.com')
          .setSubject(externalSub)
          .setIssuedAt()
          .setExpirationTime('2h')
          .sign(keyPair.privateKey);

        const res = await request(app)
          .get(`/oauth2/userinfo`)
          .set('Authorization', 'Bearer ' + jwt);
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledWith(jwksUrl, expect.anything());
      }
    );
  });

  test('JWKS verification enforces configured audience', async () => {
    const keyPair = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(keyPair.publicKey);
    const jwksUrl = 'https://external-auth.example.com/.well-known/audience-jwks.json';

    await withExternalAuthProviders(
      [
        {
          issuer: 'https://external-auth.example.com',
          identityProvider: {
            issuer: 'https://external-auth.example.com',
            audience: 'medplum-client',
            jwksUrl,
          },
        },
      ],
      async () => {
        fetchMock.mockImplementation(() => mockFetchJson({ keys: [publicJwk] }));

        const createJwt = (audience: string): Promise<string> =>
          new SignJWT({ nonce: randomUUID() })
            .setProtectedHeader({ alg: 'ES256' })
            .setIssuer('https://external-auth.example.com')
            .setAudience(audience)
            .setSubject(externalSub)
            .setIssuedAt()
            .setExpirationTime('2h')
            .sign(keyPair.privateKey);

        const rejected = await request(app)
          .get('/oauth2/userinfo')
          .set('Authorization', 'Bearer ' + (await createJwt('other-client')));
        expect(rejected).toHaveStatus(401);

        const accepted = await request(app)
          .get('/oauth2/userinfo')
          .set('Authorization', 'Bearer ' + (await createJwt('medplum-client')));
        expect(accepted).toHaveStatus(200);
      }
    );
  });

  test('Sub claim with caching', async () => {
    fetchMock.mockImplementation(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: externalSub,
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);

    // A cache hit still verifies the external token.
    const res2 = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res2).toHaveStatus(200);
  });

  test('JWKS verification reuses keys and refreshes on key rotation', async () => {
    const first = await generateKeyPair('ES256');
    const second = await generateKeyPair('ES256');
    const firstKey = { ...(await exportJWK(first.publicKey)), kid: 'first' };
    const secondKey = { ...(await exportJWK(second.publicKey)), kid: 'second' };
    const issuer = 'https://external-auth.example.com';
    const idp = { issuer, jwksUrl: `${issuer}/rotation-${randomUUID()}` };
    const token = (key: typeof first.privateKey, kid: string): Promise<string> =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuer(issuer)
        .setSubject(externalSub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
    fetchMock.mockClear();
    fetchMock.mockImplementation(() => mockFetchJson({ keys: [firstKey] }));
    const initial = await token(first.privateKey, 'first');
    await verifyExternalToken(idp, initial);
    await verifyExternalToken(idp, initial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(() => mockFetchJson({ keys: [secondKey] }));
    const rotated = await token(second.privateKey, 'second');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      await verifyExternalToken(idp, rotated);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('IAP assertions enforce required dates, ES256, and maximum lifetime with clock skew', async () => {
    const key = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(key.publicKey);
    const issuer = 'https://cloud.google.com/iap';
    const idp = { issuer, jwksUrl: `https://example.com/iap-${randomUUID()}`, audience: 'iap-audience' };
    fetchMock.mockImplementation(() => mockFetchJson({ keys: [publicJwk] }));
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, number>): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(issuer)
        .setAudience('iap-audience')
        .setSubject('synthetic')
        .sign(key.privateKey);
    await expect(verifyExternalToken(idp, await sign({ iat: now, exp: now + 600 }))).resolves.toBeDefined();
    await expect(
      verifyExternalToken({ ...idp, audience: undefined }, await sign({ iat: now, exp: now + 600 }))
    ).rejects.toThrow();
    await expect(verifyExternalToken(idp, await sign({ iat: now + 120, exp: now + 600 }))).rejects.toThrow();
    await expect(verifyExternalToken(idp, await sign({ iat: now, exp: now + 661 }))).rejects.toThrow();
    await expect(verifyExternalToken(idp, await sign({ iat: now }))).rejects.toThrow();
    await expect(verifyExternalToken(idp, await sign({ exp: now + 300 }))).rejects.toThrow();
    const rsa = await generateKeyPair('RS256');
    const rsaToken = await new SignJWT({ iat: now, exp: now + 300 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience('iap-audience')
      .setSubject('synthetic')
      .sign(rsa.privateKey);
    await expect(verifyExternalToken(idp, rsaToken)).rejects.toThrow();
  });

  test('Cached external bearer is reverified after expiry', async () => {
    const keyPair = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(keyPair.publicKey);
    const issuer = 'https://external-auth.example.com';
    await withExternalAuthProviders([{ issuer, identityProvider: { issuer, jwksUrl: issuer + '/jwks' } }], async () => {
      fetchMock.mockImplementation(() => mockFetchJson({ keys: [publicJwk] }));
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ nonce: randomUUID() })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(issuer)
        .setSubject(externalSub)
        .setIssuedAt(now)
        .setExpirationTime(now + 2)
        .sign(keyPair.privateKey);
      expect(
        await request(app)
          .get('/oauth2/userinfo')
          .set('Authorization', 'Bearer ' + token)
      ).toHaveStatus(200);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime((now + 3) * 1000);
        expect(
          await request(app)
            .get('/oauth2/userinfo')
            .set('Authorization', 'Bearer ' + token)
        ).toHaveStatus(401);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test('Cached external bearer stops when membership or login is revoked', async () => {
    const subject = randomUUID();
    const { membership } = await inviteUser({
      project: testProject,
      resourceType: 'Practitioner',
      firstName: 'Cache',
      lastName: 'Test',
      externalId: subject,
    });
    fetchMock.mockImplementation(() => mockFetchJson({ ok: true }));
    const token = createFakeJwt({ iss: 'https://external-auth.example.com', sub: subject, nonce: randomUUID() });
    const send = async (): Promise<request.Response> =>
      request(app)
        .get('/oauth2/userinfo')
        .set('Authorization', 'Bearer ' + token);
    expect(await send()).toHaveStatus(200);
    expect(
      await request(app)
        .post('/oauth2/logout')
        .set('Authorization', 'Bearer ' + token)
    ).toHaveStatus(200);
    expect(await send()).toHaveStatus(401);

    // A different authenticated session also stops immediately when its membership is disabled.
    const token2 = createFakeJwt({ iss: 'https://external-auth.example.com', sub: subject, nonce: randomUUID() });
    const send2 = async (): Promise<request.Response> =>
      request(app)
        .get('/oauth2/userinfo')
        .set('Authorization', 'Bearer ' + token2);
    expect(await send2()).toHaveStatus(200);
    await systemRepo.updateResource<ProjectMembership>({ ...membership, active: false });
    expect(await send2()).toHaveStatus(401);
  });

  test('Sub claim with unknown externalId', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: 'nonexistent-' + randomUUID(),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Sub claim with remote userinfo failure', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: false }, { status: 401 }));

    // Use a unique nonce to avoid cache hits from prior tests
    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: externalSub,
      nonce: randomUUID(),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('fhirUser takes precedence over sub', async () => {
    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    // JWT has both fhirUser and sub; fhirUser should be used
    // Use a unique nonce to avoid cache hits from prior tests
    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      fhirUser: getReferenceString(practitioner),
      sub: externalSub,
      nonce: randomUUID(),
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(200);
  });

  test('Sub claim with inactive membership', async () => {
    const inactiveSub = randomUUID();
    const { membership: inactiveMembership } = await inviteUser({
      project: testProject,
      resourceType: 'Practitioner',
      firstName: 'Inactive',
      lastName: 'User',
      externalId: inactiveSub,
    });
    await systemRepo.updateResource<ProjectMembership>({
      ...inactiveMembership,
      active: false,
    });

    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: inactiveSub,
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });

  test('Sub claim with duplicate externalId returns 401', async () => {
    const duplicateSub = randomUUID();

    // Create two memberships with the same externalId in different projects
    const { project: project2 } = await createTestProject();
    await inviteUser({
      project: testProject,
      resourceType: 'Practitioner',
      firstName: 'Dup',
      lastName: 'One',
      externalId: duplicateSub,
    });
    await inviteUser({
      project: project2,
      resourceType: 'Practitioner',
      firstName: 'Dup',
      lastName: 'Two',
      externalId: duplicateSub,
    });

    fetchMock.mockImplementationOnce(() => mockFetchJson({ ok: true }));

    const jwt = createFakeJwt({
      iss: 'https://external-auth.example.com',
      sub: duplicateSub,
    });
    const res = await request(app)
      .get(`/oauth2/userinfo`)
      .set('Authorization', 'Bearer ' + jwt);
    expect(res).toHaveStatus(401);
  });
});

function createFakeJwt(claims: Record<string, unknown>): string {
  return `header.${encodeBase64Url(JSON.stringify(claims))}.signature`;
}

async function withExternalAuthProviders(
  externalAuthProviders: MedplumExternalAuthConfig[] | undefined,
  fn: () => Promise<void>
): Promise<void> {
  const savedExternalAuthProviders = getConfig().externalAuthProviders;
  getConfig().externalAuthProviders = externalAuthProviders;

  try {
    await fn();
  } finally {
    getConfig().externalAuthProviders = savedExternalAuthProviders;
  }
}
