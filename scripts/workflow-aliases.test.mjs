import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('self-hosted catalog retains disabled exact alias entries but selects only enabled defaults', () => {
  const source = readFileSync(new URL('../self-hosted/pocketbase/pb_hooks/gateway.pb.js', import.meta.url), 'utf8');
  let handler;
  vm.runInNewContext(source, {
    routerAdd: (method, path, callback) => { if (path === '/api/gateway/workflows') handler = callback; },
    $security: { sha256: value => value },
  });
  for (const enabled of [true, false]) {
    const entries = [
      { name: 'engineering', definition: { meta: { enabled: false } }, active: true },
      { name: 'agentic-engineering', definition: { meta: { enabled } }, active: false },
    ];
    let response;
    handler({
      request: { header: { get: () => 'Bearer fixture' } },
      app: {
        findFirstRecordByFilter: () => ({ set() {} }), save() {},
        findRecordsByFilter: () => entries.map(entry => ({ get: key => entry[key], getString: key => JSON.stringify(entry[key]) })),
      },
      json: (status, body) => { assert.equal(status, 200); response = body; },
    });
    assert.equal(response.workflows.engineering.meta.enabled, false);
    assert.equal(response.default, enabled ? 'agentic-engineering' : '');
    assert.equal(Object.keys(response.workflows).length, 2);
  }
});

test('self-hosted engineering default wins over a more recently edited active workflow', () => {
  let handler;
  vm.runInNewContext(readFileSync(new URL('../self-hosted/pocketbase/pb_hooks/gateway.pb.js', import.meta.url), 'utf8'), {
    routerAdd: (method, path, callback) => { if (path === '/api/gateway/workflows') handler = callback; },
    $security: { sha256: value => value },
  });
  for (const enabled of [true, false]) {
    const entries = [
      { name: 'bugfix', active: true, definition: { id: 'bugfix' } },
      { name: 'agentic-engineering', active: true, definition: { id: 'agentic-engineering', meta: { enabled } } },
    ];
    handler({
      request: { header: { get: () => 'Bearer fixture' } },
      app: {
        findFirstRecordByFilter: () => ({ set() {} }), save() {},
        findRecordsByFilter: () => entries.map(entry => ({ get: key => entry[key], getString: key => JSON.stringify(entry[key]) })),
      },
      json: (status, body) => { assert.equal(status, 200); assert.equal(body.default, enabled ? 'agentic-engineering' : 'bugfix'); },
    });
  }
});
