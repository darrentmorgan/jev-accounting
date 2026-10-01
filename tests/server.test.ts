import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { categories, samples } from '../src/catalog.ts';

async function start(options: Parameters<typeof createApp>[0] = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const body = JSON.stringify({ transactions: [samples[0]] });
const headers = { 'Content-Type': 'application/json' };
const validAnswer = { answers: { account: { type: 'choice', choice: 'software_subscriptions', probabilities: Object.fromEntries(categories.map(category => [category.id, category.id === 'software_subscriptions' ? 1 : 0])) } } };

test('config reports key presence only and missing key blocks all inference', async () => {
  let calls = 0;
  const { server, url } = await start({ configured: () => false, evaluator: async () => { calls++; return validAnswer; } });
  try {
    const config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.configured, false);
    assert.equal(config.model, 'typesafe-ai/jev');
    assert.equal(config.maxTransactions, 25);
    assert.equal(config.samples.length, 8);
    const response = await fetch(url + '/api/classify', { method: 'POST', headers, body });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /AI_GATEWAY_API_KEY/);
    assert.equal(calls, 0);
  } finally { await stop(server); }
});

test('local JSON requests return classification while malformed requests make no calls', async () => {
  let calls = 0;
  const { server, url } = await start({ configured: () => true, evaluator: async () => { calls++; return validAnswer; } });
  try {
    for (const [request, status] of [
      [{ headers: { 'Content-Type': 'text/plain' }, body }, 415],
      [{ headers: { ...headers, Origin: 'https://evil.example' }, body }, 403],
      [{ headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body }, 403],
      [{ headers, body: '{' }, 400],
      [{ headers, body: JSON.stringify({ transactions: [] }) }, 400],
      [{ headers, body: JSON.stringify({ transactions: [{ ...samples[0], amount: 'NaN' }] }) }, 400],
      [{ headers, body: ' '.repeat(65_537) }, 413],
    ] as const) {
      const response = await fetch(url + '/api/classify', { method: 'POST', ...request });
      assert.equal(response.status, status, JSON.stringify(request));
      await response.text();
    }
    // Native fetch rewrites Host; use HTTP directly to test the actual guard.
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url + '/api/classify', { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      });
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(badHostStatus, 403);
    assert.equal(calls, 0);
    const response = await fetch(url + '/api/classify', { method: 'POST', headers: { ...headers, Origin: url }, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].assignedCategory, 'software_subscriptions');
    assert.equal(calls, 1);
  } finally { await stop(server); }
});

test('oversized chunked request is rejected without inference', async () => {
  let calls = 0;
  const { server, url } = await start({ configured: () => true, evaluator: async () => { calls++; return validAnswer; } });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url + '/api/classify', { method: 'POST', headers }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      });
      request.on('error', reject);
      request.write(' '.repeat(40_000));
      request.end(' '.repeat(40_000));
    });
    assert.equal(status, 413);
    assert.equal(calls, 0);
  } finally { await stop(server); }
});

test('only one batch runs at a time and the lock releases after completion', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { server, url } = await start({ configured: () => true, evaluator: async () => { entered(); await blocked; return validAnswer; } });
  try {
    const first = fetch(url + '/api/classify', { method: 'POST', headers, body });
    await enteredPromise;
    const second = await fetch(url + '/api/classify', { method: 'POST', headers, body });
    assert.equal(second.status, 429);
    await second.text();
    release();
    assert.equal((await first).status, 200);
    const third = await fetch(url + '/api/classify', { method: 'POST', headers, body });
    assert.equal(third.status, 200);
    await third.text();
  } finally { release(); await stop(server); }
});

test('env and source files are never served', async () => {
  const { server, url } = await start({ configured: () => false });
  try {
    for (const path of ['/.env', '/src/server.ts', '/package.json']) assert.equal((await fetch(url + path)).status, 404);
  } finally { await stop(server); }
});
