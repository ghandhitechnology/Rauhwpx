import assert from 'node:assert/strict';
import test from 'node:test';

import { createRailwayCloudProvisioner } from '../cloud-provisioner.mjs';

const PUBLIC_KEY = `ed25519:${'A'.repeat(43)}`;
const PAIRING_CODE = 'ABCD-EFGH-IJKL';

function graphqlPayload(query, variables) {
  if (query.includes('RaucloudServiceCreate')) {
    return { data: { serviceCreate: { id: 'svc-1', name: variables.input.name } } };
  }
  if (query.includes('RaucloudDomainCreate')) {
    return { data: { serviceDomainCreate: { id: 'dom-1', domain: 'worker.example.test' } } };
  }
  if (query.includes('RaucloudLatestDeployment')) {
    return { data: { deployments: { edges: [{ node: { id: 'dep-1', status: 'SUCCESS' } }] } } };
  }
  if (query.includes('RaucloudServiceDelete') || query.includes('RaucloudProjectServices')) {
    return { data: { serviceDelete: true, project: { services: { edges: [] } } } };
  }
  throw new Error(`unexpected query: ${query.slice(0, 80)}`);
}

test('Raucloud bootstrap pairing sends a response-proof nonce', async () => {
  const bootstrapHeaders = [];
  const provisioner = createRailwayCloudProvisioner({
    config: {
      token: 'railway-token',
      projectId: 'project',
      environmentId: 'environment',
      image: 'example/image:tag',
      apiUrl: 'https://railway.test/graphql',
    },
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/graphql')) {
        const { query, variables } = JSON.parse(options.body);
        return Response.json(graphqlPayload(query, variables));
      }
      if (String(url).endsWith('/v1/health')) {
        return Response.json({ ok: true, serverPublicKey: PUBLIC_KEY });
      }
      if (String(url).endsWith('/v1/pairing/bootstrap')) {
        bootstrapHeaders.push(new Headers(options.headers));
        return Response.json({
          code: PAIRING_CODE,
          serverPublicKey: PUBLIC_KEY,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const spawned = await provisioner.provision({
    runId: 'run_1',
    accountId: 'account_1',
    deviceId: 'device_1',
    workerToken: 'mcw_test',
  });

  assert.equal(spawned.receipt.pairingCode, PAIRING_CODE);
  assert.equal(bootstrapHeaders.length, 1);
  const nonce = bootstrapHeaders[0].get('x-rauhwpx-request-nonce');
  assert.match(nonce, /^[A-Za-z0-9_-]{22,128}$/);
  assert.ok(Buffer.from(nonce, 'base64url').length >= 16);
});
