import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { createApp } from '../src/server.ts';
import { categories, MODEL, samples } from '../src/catalog.ts';

// Minimal DOM surface used by the actual page script; no production UI changes.
class Node {
  textContent = '';
  value = '';
  disabled = true;
  hidden = false;
  href = '';
  download = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Node[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(event: string, listener: () => unknown) { this.listeners.set(event, listener); }
  click() { return this.listeners.get('click')?.(); }
  remove() {}
}

type BrowserResponse = Pick<Response, 'ok' | 'status' | 'json'>;

async function page(options: Parameters<typeof createApp>[0], browser: {
  classifyFetch?: (init: RequestInit | undefined, send: () => Promise<Response>) => Promise<BrowserResponse>;
} = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const nodes = new Map<string, Node>();
  let download: Blob | undefined;
  let downloads = 0;
  let filename = '';
  let classified: any;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const scheduledDelays: number[] = [];
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id)!;
  };
  try {
    const html = await (await fetch(url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'page script exists');
    const context = createContext({
      document: {
        getElementById: get,
        createElement: () => new Node(),
        body: { append: (node: Node) => { filename = node.download; } },
      },
      fetch: async (path: string, init?: RequestInit) => {
        const send = async () => {
          const response = await fetch(url + path, init);
          if (path === '/api/classify') classified = await response.clone().json();
          return response;
        };
        return path === '/api/classify' && browser.classifyFetch ? browser.classifyFetch(init, send) : send();
      },
      Blob,
      AbortController,
      URL: {
        createObjectURL: (blob: Blob) => { downloads++; download = blob; return 'blob:smoke'; },
        revokeObjectURL: () => {},
      },
      setTimeout: (callback: () => void, ms: number) => {
        scheduledDelays.push(ms);
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
    });
    await runInContext(script, context);
    assert.equal(get('sample-button').disabled, false, 'configuration loaded');
    return {
      get,
      downloads: () => downloads,
      scheduledDelays: () => scheduledDelays,
      classify: (deadlineMs: number) => runInContext(`classify(${deadlineMs})`, context) as Promise<void>,
      classified: () => classified,
      csv: async () => {
        assert.equal(get('download-button').disabled, false);
        await get('download-button').click();
        assert.ok(download, 'download handler created a Blob');
        assert.match(filename, /^jev-classifications-\d{4}-\d{2}-\d{2}\.csv$/);
        const text = await download.text();
        // Parse using the page's CSV parser, including its BOM/quote handling.
        const rows: string[][] = runInContext(`parseCsv(${JSON.stringify(text)})`, context);
        return { text, rows };
      },
      close: async () => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
    };
  } catch (error) {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}

function answer(choice = 'software_subscriptions', probability = 0.93) {
  return { answers: { account: { type: 'choice', choice, probabilities: Object.fromEntries(categories.map(category => [category.id, category.id === choice ? probability : (1 - probability) / (categories.length - 1)])) } } };
}

function checkExport(rows: string[][]) {
  assert.equal(rows[0].join(','), 'description,amount,currency,suggested_category,assigned_category,probability,needs_review,review_reason,error,model');
  assert.equal(rows.length, samples.length + 1);
  samples.forEach((sample, index) => {
    const row = rows[index + 1];
    assert.equal(row.length, 10);
    assert.equal(row[0], sample.description);
    assert.equal(Number(row[1]), sample.amount);
    assert.equal(row[2], sample.currency);
    assert.equal(row[9], MODEL);
  });
}

test('synthetic demo: classify, review failures, export and repeat', async () => {
  let calls = 0;
  const app = await page({ configured: () => true, evaluator: async request => {
    calls++;
    assert.equal(request.model, MODEL);
    assert.equal(Object.keys(request.questions.account.criteria).length, categories.length);
    const index = samples.findIndex(sample => sample.description === request.state.transaction.description);
    assert.ok(index >= 0, 'only synthetic samples reach the evaluator');
    if (index === 1) return answer('sales_income', 0.7);
    if (index === 2) return answer('unassigned', 0.99);
    if (index === 3) return { answers: { account: { type: 'choice', choice: 'transfers' } } };
    if (index === 4) return { answers: { account: { choice: 'invalid' } } };
    if (index === 5) throw new Error('synthetic-secret-marker raw-request-marker');
    return answer();
  } });
  try {
    await app.get('classify-button').click();
    assert.equal(calls, 8);
    assert.equal(app.get('result-rows').children.length, 8);
    const { text, rows } = await app.csv();
    checkExport(rows);
    assert.equal(rows[1][4], 'Software & subscriptions');
    assert.equal(rows[1][5], '0.93');
    assert.equal(rows[1][6], 'false');
    for (const index of [1, 2, 3, 4, 5]) {
      assert.equal(rows[index + 1][4], 'Unassigned');
      assert.equal(rows[index + 1][6], 'true');
      assert.ok(rows[index + 1][7], 'review reason exported');
      const assignment = app.get('result-rows').children[index].children[4];
      assert.equal(assignment.children[0].textContent, 'Unassigned · Review');
      assert.ok(assignment.children[1].textContent, 'review reason visible');
    }
    assert.equal(rows[2][3], 'Sales income');
    assert.equal(rows[2][5], '0.7');
    for (const index of [3, 4, 5]) assert.equal(rows[index + 1][5], '');
    for (const index of [4, 5]) assert.ok(rows[index + 1][8], 'failure exported');
    assert.doesNotMatch(text + JSON.stringify(app.get('result-rows').children), /synthetic-secret-marker|raw-request-marker/);

    await app.get('sample-button').click();
    await app.get('classify-button').click();
    assert.equal(calls, 16);
    checkExport((await app.csv()).rows);
  } finally { await app.close(); }
});

test('rejected synthetic batch clears exports, preserves input, and can retry', async () => {
  let configured = true;
  const app = await page({ configured: () => configured, evaluator: async () => answer() });
  try {
    await app.get('classify-button').click();
    checkExport((await app.csv()).rows);
    const input = app.get('csv-input').value;
    configured = false;
    await app.get('classify-button').click();
    assert.equal(app.get('download-button').disabled, true);
    assert.equal(app.get('results-body').hidden, true);
    assert.equal(app.get('csv-input').value, input);
    assert.equal(app.get('empty-title').textContent, 'Classification could not finish');
    assert.match(app.get('notice').textContent, /AI_GATEWAY_API_KEY/);
    configured = true;
    await app.get('classify-button').click();
    checkExport((await app.csv()).rows);
  } finally { await app.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const stalledAt of ['fetch', 'body'] as const) {
  test(`stalled ${stalledAt} expires, ignores late results, and permits a fresh batch`, async () => {
    let calls = 0;
    let expiredSignal: AbortSignal | undefined;
    const lateResponse = deferred<BrowserResponse>();
    const lateBody = deferred<any>();
    const freshResponse = deferred<BrowserResponse>();
    const app = await page({ configured: () => true, evaluator: async () => answer() }, {
      classifyFetch: async (init, send) => {
        calls++;
        if (calls === 2) {
          expiredSignal = init?.signal ?? undefined;
          // Deliberately ignore abort to prove late transport completions are harmless.
          return stalledAt === 'fetch' ? lateResponse.promise : { ok: true, status: 200, json: () => lateBody.promise };
        }
        if (calls === 3) return freshResponse.promise;
        return send();
      },
    });
    try {
      await app.get('classify-button').click();
      assert.ok(app.scheduledDelays().includes(300_000), 'normal clicks use the 300-second total budget');
      checkExport((await app.csv()).rows);
      const originalData = app.classified();
      const input = app.get('csv-input').value;
      const pending = app.classify(20);
      assert.equal(app.get('csv-input').disabled, true);
      assert.equal(app.get('classify-spinner').hidden, false);
      assert.equal(app.get('download-button').disabled, true);
      assert.equal(await Promise.race([pending.then(() => 'finished'), delay(200).then(() => 'stalled')]), 'finished', 'deadline must release a never-settling request');
      assert.equal(app.get('csv-input').value, input);
      assert.equal(app.get('csv-input').disabled, false);
      assert.equal(app.get('sample-button').disabled, false);
      assert.equal(app.get('classify-button').disabled, false);
      assert.equal(app.get('classify-spinner').hidden, true);
      assert.equal(app.get('classify-arrow').hidden, false);
      assert.equal(app.get('classify-label').textContent, 'Classify with Jev');
      assert.equal(app.get('results-section').attributes.get('aria-busy'), 'false');
      assert.equal(app.get('download-button').disabled, true);
      assert.equal(app.get('results-body').hidden, true);
      assert.match(app.get('notice').textContent, /uncertain/i);
      assert.match(app.get('notice').textContent, /no results/i);
      assert.match(app.get('notice').textContent, /provider.*charges/i);
      assert.equal(calls, 2, 'no automatic retry');
      assert.equal(expiredSignal?.aborted, true, 'browser transport is aborted');
      await app.get('download-button').click();
      assert.equal(app.downloads(), 1, 'stale results cannot create another download');

      const recovery = app.get('classify-button').click();
      const oldResponse = { ok: true, status: 200, json: async () => originalData };
      if (stalledAt === 'fetch') lateResponse.resolve(oldResponse);
      await delay(0);
      assert.equal(app.get('csv-input').disabled, true, 'expired request cannot clear a newer busy state');
      assert.equal(app.get('results-section').attributes.get('aria-busy'), 'true');
      assert.equal(app.get('results-body').hidden, true, 'expired result cannot render');
      assert.equal(app.get('download-button').disabled, true);

      const freshData = { ...originalData, results: originalData.results.map((result: any) => ({ ...result, confidence: 0.99 })) };
      freshResponse.resolve({ ok: true, status: 200, json: async () => freshData });
      await recovery;
      if (stalledAt === 'body') lateBody.resolve(originalData);
      await delay(0);
      const { rows } = await app.csv();
      checkExport(rows);
      assert.equal(rows[1][5], '0.99', 'only the fresh response populates results');
      assert.equal(app.get('csv-input').disabled, false);
      assert.equal(app.get('classify-spinner').hidden, true);
      assert.equal(calls, 3);
    } finally { await app.close(); }
  });
}

test('optional live Jev synthetic classify-and-export', { skip: process.env.JEV_SMOKE_LIVE !== '1' }, async () => {
  assert.ok(process.env.AI_GATEWAY_API_KEY?.trim(), 'live mode requires AI_GATEWAY_API_KEY');
  const app = await page({});
  try {
    await app.get('classify-button').click();
    const { rows } = await app.csv();
    checkExport(rows);
    // Counts only: never model output, probabilities, or transaction text.
    const data = app.classified();
    const summary = {
      mode: 'live', model: data.model, generatedAt: new Date().toISOString(),
      transactions: data.results.length,
      assigned: data.results.filter((result: any) => !result.needsReview && !result.error).length,
      needsReview: data.results.filter((result: any) => result.needsReview && !result.error).length,
      errors: data.results.filter((result: any) => result.error).length,
      totalLatencyMs: data.latencyMs,
      inputTokens: data.inputTokens,
    };
    console.log(`live smoke aggregate: ${JSON.stringify(summary)}`);
    await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
    await writeFile(new URL('../evidence/jev-smoke-live.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
    for (const row of rows.slice(1)) {
      // Avoid including model data or SDK diagnostics in assertion output.
      assert.ok(row[8] === '', 'live classification must be valid and error-free');
      assert.ok(categories.some(category => category.label === row[3]), 'valid live suggestion');
      assert.ok(row[6] === 'true' || row[6] === 'false', 'review flag exported');
      if (row[6] === 'true') assert.ok(row[4] === 'Unassigned' && Boolean(row[7]), 'review retained');
    }
  } finally { await app.close(); }
});
