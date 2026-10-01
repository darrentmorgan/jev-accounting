# Jev accounting prototype

> **v0.1 prototype.** Rough edges expected; feedback welcome.

A small local workbench that classifies bank transactions into illustrative account categories using **TypeSafe Jev**, the **Vercel AI SDK**, and **Vercel AI Gateway**.

Paste CSV or load eight synthetic examples, run Jev, review the proposed categories and probabilities, and download the results. There is no database or accounting-system connection.

## Requirements and terms

- You need your own Vercel AI Gateway key (`AI_GATEWAY_API_KEY`).
- It calls the hosted `typesafe-ai/jev` model, so use is subject to TypeSafe's and Vercel's terms.
- Output is illustrative and is not accounting or tax advice.

## Run locally

Requires Node.js 24 or newer.

```sh
npm ci
cp .env.example .env
```

Set `AI_GATEWAY_API_KEY` in `.env` to your Vercel AI Gateway key, then:

```sh
npm run dev
```

Open <http://127.0.0.1:4387>. Restart the server after changing `.env`. The key stays on the server; `.env` is ignored by Git. Without a key you can inspect the interface and inputs, but classification requires a real model call. There are no simulated model results.

## CSV format

```csv
description,amount,currency
Business software monthly subscription,-49.00,AUD
Customer payment for consulting invoice INV-1042,1650.00,AUD
PAYMENT 839102,-87.20,AUD
```

Use signed amounts: negative for money out and positive for money in. `description` and `amount` are required; `currency` defaults to `AUD`. At most 25 transactions per run. The CSV parser supports quoted fields and commas inside quotes.

## How decisions work

- `src/catalog.ts` defines the sample transactions and account descriptions. The category catalog is illustrative and meant to be replaced with an approved chart of accounts before using business data.
- `BUSINESS_CONTEXT` in `src/catalog.ts` (default `an illustrative small business`) describes the business in the classifier prompt. Set it to describe yours, including jurisdiction if relevant.
- `DEFAULT_CURRENCY` in `src/catalog.ts` (default `AUD`) is the three-letter currency code used when a transaction or CSV row has none. The UI reads it from `/api/config`.
- Each transaction becomes a separate `experimental_evaluate` call to `typesafe-ai/jev`. The SDK is pinned at `ai@7.0.107` because the evaluation API is experimental.
- The displayed probability is Jev's probability for the selected category, not a measured accuracy rate or a written explanation.
- Missing or invalid probabilities, probabilities below the illustrative 85% threshold, and an `unassigned` choice keep the assigned account **Unassigned** for review. Model failures also remain unassigned.
- The threshold is a prototype setting, not a validated accounting control. Evaluate on labelled examples before deciding what to automate.

Amounts are passed as context, not used for model arithmetic. This prototype does not determine tax treatment, post journal entries, or write to an accounting system. Clicking the classification button sends the submitted descriptions and amounts to Vercel AI Gateway and its Jev provider. Start with the included synthetic examples.

The local server binds to loopback. This is a local prototype, not a publicly deployable multi-user application.

## Check and build

```sh
npm run check
npm test
npm run build
npm start
```

Tests use injected model responses to check validation and review behavior without network calls. Passing those tests does not establish real Jev accuracy; an authenticated smoke run and labelled evaluation are separate checks.

## Official documentation

- [Jev model](https://vercel.com/ai-gateway/models/jev)
- [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation)
- [AI Gateway authentication](https://vercel.com/docs/ai-gateway/sdks-and-apis/ai-sdk#authentication)
