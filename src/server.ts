import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { categories, DEFAULT_CURRENCY, MAX_TRANSACTIONS, MODEL, REVIEW_THRESHOLD, samples } from './catalog.ts';
import { classifyTransactions, parseTransactions, ValidationError, type Evaluator } from './classifier.ts';

const MAX_BODY_BYTES = 64 * 1024;
const page = new URL('../public/index.html', import.meta.url);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function verifyLocalRequest(request: IncomingMessage) {
  const port = request.socket.localPort;
  const host = request.headers.host;
  const permitted = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (port === 80) permitted.push('127.0.0.1', 'localhost');
  if (!host || !permitted.includes(host.toLowerCase())) throw new HttpError(403, 'Use this app through its localhost address.');
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send Content-Type: application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed request bodies are not supported.');
  const length = Number(request.headers['content-length']);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body must be no larger than 64 KiB.');
  const chunks: Buffer[] = [];
  let size = 0;
  // Event listeners allow a useful 413 response without destroying the socket.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, 'Request body must be no larger than 64 KiB.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolve(); } });
    request.on('error', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Unable to read request body.')); } });
    request.on('aborted', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Request was interrupted.')); } });
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must contain valid JSON.'); }
}

export function createApp(options: { evaluator?: Evaluator; configured?: () => boolean } = {}) {
  let busy = false;
  const configured = options.configured ?? (() => Boolean(process.env.AI_GATEWAY_API_KEY?.trim()));
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      verifyLocalRequest(request);
      const path = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
      if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(page);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
      } else if (request.method === 'GET' && path === '/api/config') {
        writeJson(response, 200, { model: MODEL, configured: configured(), threshold: REVIEW_THRESHOLD, maxTransactions: MAX_TRANSACTIONS, defaultCurrency: DEFAULT_CURRENCY, categories, samples });
      } else if (request.method === 'POST' && path === '/api/classify') {
        if (busy) throw new HttpError(429, 'A classification batch is already running. Wait for it to finish.');
        // Claim before reading the body so concurrent uploads cannot bypass the lock.
        busy = true;
        try {
          const transactions = parseTransactions(await readJson(request));
          if (!configured()) throw new HttpError(503, 'Add AI_GATEWAY_API_KEY to .env and restart the server to classify transactions.');
          writeJson(response, 200, await classifyTransactions(transactions, options.evaluator));
        } finally { busy = false; }
      } else {
        writeJson(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      request.resume();
      const status = error instanceof HttpError ? error.status : error instanceof ValidationError ? 400 : 500;
      const message = error instanceof HttpError || error instanceof ValidationError ? error.message : 'Unable to complete the request.';
      if (!response.headersSent) writeJson(response, status, { error: message });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT === undefined ? 4387 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createApp();
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on('error', () => { console.error('Unable to start the local server. Check whether the port is already in use.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Jev accounting is running at http://127.0.0.1:${port}`));
  }
}
