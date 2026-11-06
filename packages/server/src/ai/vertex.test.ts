// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { vi } from 'vitest';
import { getVertexCredentials } from './vertex';

const getAccessToken = vi.hoisted(() => vi.fn());
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient(): unknown {
      return { getAccessToken };
    }
  },
}));

test('obtains a current token for each request and builds the regional endpoint', async () => {
  getAccessToken.mockResolvedValueOnce({ token: 'first' }).mockResolvedValueOnce({ token: 'second' });
  const config = { projectId: 'example-project', location: 'eu', allowedModels: ['google/gemini-3.8-flash'] };
  expect(await getVertexCredentials(config)).toEqual({
    apiKey: 'first',
    baseUrl: 'https://eu-aiplatform.googleapis.com/v1beta1/projects/example-project/locations/eu/endpoints/openapi',
  });
  expect((await getVertexCredentials(config)).apiKey).toBe('second');
});

test('fails closed when ADC has no access token', async () => {
  getAccessToken.mockResolvedValueOnce({ token: null });
  await expect(
    getVertexCredentials({ projectId: 'example-project', location: 'eu', allowedModels: ['model'] })
  ).rejects.toThrow();
});
