import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  listeners = new Map<string, () => unknown>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener(event: string, listener: () => unknown) { this.listeners.set(event, listener); }
  click() { return this.listeners.get('click')?.(); }
  remove() {}
}

async function page(options: Parameters<typeof createApp>[0]) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const nodes = new Map<string, Node>();
  let download: Blob | undefined;
  let filename = '';
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
      fetch: (path: string, init?: RequestInit) => fetch(url + path, init),
      Blob,
      URL: {
        createObjectURL: (blob: Blob) => { download = blob; return 'blob:smoke'; },
        revokeObjectURL: () => {},
      },
      setTimeout: (callback: () => void) => { callback(); },
    });
    await runInContext(script, context);
    assert.equal(get('sample-button').disabled, false, 'configuration loaded');
    return {
      get,
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
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
    };
  } catch (error) {
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

test('optional live Jev synthetic classify-and-export', { skip: process.env.JEV_SMOKE_LIVE !== '1' }, async () => {
  assert.ok(process.env.AI_GATEWAY_API_KEY?.trim(), 'live mode requires AI_GATEWAY_API_KEY');
  const app = await page({});
  try {
    await app.get('classify-button').click();
    const { rows } = await app.csv();
    checkExport(rows);
    for (const row of rows.slice(1)) {
      // Avoid including model data or SDK diagnostics in assertion output.
      assert.ok(row[8] === '', 'live classification must be valid and error-free');
      assert.ok(categories.some(category => category.label === row[3]), 'valid live suggestion');
      assert.ok(row[6] === 'true' || row[6] === 'false', 'review flag exported');
      if (row[6] === 'true') assert.ok(row[4] === 'Unassigned' && Boolean(row[7]), 'review retained');
    }
  } finally { await app.close(); }
});
