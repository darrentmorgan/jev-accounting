import assert from 'node:assert/strict';
import test from 'node:test';
import { categories, samples } from '../src/catalog.ts';
import { classifyTransactions, parseTransactions, ValidationError, type EvaluationRequest } from '../src/classifier.ts';

function answer(choice = 'software_subscriptions', probability = 0.93) {
  return {
    answers: { account: { type: 'choice', choice, probabilities: Object.fromEntries(categories.map(category => [category.id, category.id === choice ? probability : (1 - probability) / (categories.length - 1)])) } },
    usage: { inputTokens: 52 },
  };
}

test('normalizes descriptions and currency without coercing amount', () => {
  assert.deepEqual(parseTransactions({ transactions: [{ description: '  Cloud software  ', amount: -12, currency: ' aud ' }] }), [{ description: 'Cloud software', amount: -12, currency: 'AUD' }]);
  assert.equal(parseTransactions({ transactions: [{ description: 'x', amount: 1 }] })[0].currency, 'AUD');
});

test('rejects invalid batches and malformed transaction fields', () => {
  const invalid = [null, {}, { transactions: [] }, { transactions: new Array(26).fill(samples[0]) },
    ...[null, { ...samples[0], description: ' ' }, { ...samples[0], description: 'a'.repeat(1001) }, { ...samples[0], amount: 0 }, { ...samples[0], amount: Infinity }, { ...samples[0], amount: NaN }, { ...samples[0], amount: 1e13 }, { ...samples[0], amount: '-12' }, { ...samples[0], currency: 'AUDD' }, { ...samples[0], currency: null }].map(row => ({ transactions: [row] }))];
  for (const body of invalid) assert.throws(() => parseTransactions(body), ValidationError);
});

test('high probability assigns category and sends the bounded Jev evaluation contract', async () => {
  let request: EvaluationRequest | undefined;
  const result = await classifyTransactions([samples[0]], async value => { request = value; return answer(); });
  assert.equal(result.results[0].assignedCategory, 'software_subscriptions');
  assert.equal(result.results[0].confidence, 0.93);
  assert.equal(result.results[0].needsReview, false);
  assert.equal(result.inputTokens, 52);
  assert.equal(request!.model, 'typesafe-ai/jev');
  assert.equal(request!.maxRetries, 0);
  assert.ok(request!.abortSignal instanceof AbortSignal);
  assert.equal(request!.state.transaction.amount, -24);
  assert.match(request!.state.amountConvention, /Negative amounts/);
  assert.equal(Object.keys(request!.questions.account.criteria).length, categories.length);
});

test('low probability and explicit Unassigned remain unassigned', async () => {
  const low = await classifyTransactions([samples[0]], async () => answer('software_subscriptions', 0.70));
  assert.equal(low.results[0].suggestedCategory, 'software_subscriptions');
  assert.equal(low.results[0].assignedCategory, 'unassigned');
  assert.equal(low.results[0].needsReview, true);
  const unassigned = await classifyTransactions([samples[0]], async () => answer('unassigned', 0.99));
  assert.equal(unassigned.results[0].assignedCategory, 'unassigned');
  assert.equal(unassigned.results[0].needsReview, true);
});

test('missing probabilities preserve suggestion but require review', async () => {
  const result = await classifyTransactions([samples[0]], async () => ({ answers: { account: { type: 'choice', choice: 'software_subscriptions' } } }));
  assert.equal(result.results[0].suggestedCategory, 'software_subscriptions');
  assert.equal(result.results[0].assignedCategory, 'unassigned');
  assert.equal(result.results[0].confidence, null);
  assert.equal(result.results[0].error, null);
  assert.equal(result.inputTokens, null);
});

test('malformed answers and probability maps fail closed', async () => {
  const invalid: unknown[] = [null, {}, { answers: {} },
    { answers: { account: { type: 'choice', choice: 'invented_account' } } },
    { answers: { account: { type: 'score', choice: 'software_subscriptions' } } },
  ];
  for (const mutate of [
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities = { software_subscriptions: 0.99 }; },
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities.extra = 0; },
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities.rent = NaN; },
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities.rent = -0.1; },
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities.rent = 1.1; },
    (value: ReturnType<typeof answer>) => { value.answers.account.probabilities.rent = 0.5; },
    (value: ReturnType<typeof answer>) => { value.answers.account.choice = 'rent'; },
  ]) { const value = answer(); mutate(value); invalid.push(value); }
  for (const value of invalid) {
    const result = await classifyTransactions([samples[0]], async () => value);
    assert.equal(result.results[0].assignedCategory, 'unassigned');
    assert.equal(result.results[0].confidence, null);
    assert.match(result.results[0].error!, /invalid classification/);
  }
});

test('complete rounded distributions use declared precision without normalization', async () => {
  const response = answer('software_subscriptions', 0.88);
  response.answers.account.probabilities = Object.fromEntries(categories.map(category => [category.id, category.id === 'software_subscriptions' ? 0.88 : 0.01]));
  const result = await classifyTransactions([samples[0]], async () => ({ ...response, rounding: { probabilityDecimals: 2 } }));
  assert.equal(result.results[0].confidence, 0.88);
  assert.equal(result.results[0].error, null);
});

test('mixed success and gateway errors preserve order and hide SDK error details', async () => {
  const result = await classifyTransactions(samples.slice(0, 3), async request => {
    if (request.state.transaction === samples[1]) throw new Error('Bearer secret_key request: confidential');
    return answer();
  });
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].assignedCategory, 'software_subscriptions');
  assert.equal(result.results[1].assignedCategory, 'unassigned');
  assert.equal(result.results[2].transaction.description, samples[2].description);
  assert.doesNotMatch(JSON.stringify(result), /secret_key|confidential/);
  assert.equal(result.inputTokens, null);
});

test('limits active evaluations to three', async () => {
  let active = 0;
  let highest = 0;
  const result = await classifyTransactions(samples, async () => {
    highest = Math.max(highest, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return answer();
  });
  assert.equal(highest, 3);
  assert.equal(result.results.length, samples.length);
});
