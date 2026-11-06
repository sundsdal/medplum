// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { GoogleAuth } from 'google-auth-library';
import type { MedplumServerConfig } from '../config/types';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
type VertexConfig = NonNullable<MedplumServerConfig['vertexAi']>;

/**
 * Builds a trusted Vertex endpoint and obtains a current ADC access token.
 * @param config - The operator-configured Google project and location.
 * @returns Refreshed credentials for the OpenAI-compatible Vertex endpoint.
 */
export async function getVertexCredentials(config: VertexConfig): Promise<{ apiKey: string; baseUrl: string }> {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Vertex AI credentials did not provide an access token');
  }
  return {
    apiKey: token,
    baseUrl: `https://${config.location}-aiplatform.googleapis.com/v1beta1/projects/${config.projectId}/locations/${config.location}/endpoints/openapi`,
  };
}
