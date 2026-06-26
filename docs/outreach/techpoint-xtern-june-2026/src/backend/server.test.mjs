import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './server.mjs';

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves dashboard HTML', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Incident Signal Dashboard/);
  });
});

test('serves summary API', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/summary`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.totalEvents, 12);
    assert.equal(typeof body.openIncidents, 'number');
  });
});

test('serves raw event API', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.length, 12);
    assert.equal(body[0].vendor, 'CrowdStrike');
  });
});
