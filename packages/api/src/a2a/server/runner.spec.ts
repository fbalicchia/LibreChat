import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createInMemoryContextHistory } from './history';
import { createChatCompletionsRunner } from './runner';

describe('createChatCompletionsRunner', () => {
  let server: Server;
  let baseURL: string;
  let reply: { status: number; body: unknown };
  let received: { authorization?: string; body?: unknown };

  beforeAll(async () => {
    const app = express();
    app.post('/api/agents/v1/chat/completions', express.json(), (req, res) => {
      received = { authorization: req.headers.authorization, body: req.body };
      res.status(reply.status).json(reply.body);
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = () =>
    createChatCompletionsRunner()({
      baseURL,
      agentId: 'agent_x',
      bearerToken: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      signal: AbortSignal.timeout(5_000),
    });

  it('sends a blocking request with the caller key and returns the answer', async () => {
    reply = { status: 200, body: { choices: [{ message: { content: ' hello ' } }] } };

    await expect(run()).resolves.toEqual({ ok: true, text: 'hello' });
    expect(received.authorization).toBe('Bearer sk-test');
    expect(received.body).toEqual({
      model: 'agent_x',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('joins text parts of array content', async () => {
    reply = {
      status: 200,
      body: { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] },
    };
    await expect(run()).resolves.toEqual({ ok: true, text: 'ab' });
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'agent_error'],
  ])('maps HTTP %d to %s without upstream text', async (status, code) => {
    reply = { status, body: { error: { message: 'provider said something private' } } };
    await expect(run()).resolves.toEqual({ ok: false, error: { code, status } });
  });

  it('reports an empty answer', async () => {
    reply = { status: 200, body: { choices: [{ message: { content: '' } }] } };
    await expect(run()).resolves.toEqual({ ok: false, error: { code: 'empty_response' } });
  });
});

describe('createInMemoryContextHistory', () => {
  it('keeps the latest turns per scope', async () => {
    const history = createInMemoryContextHistory();
    await history.append('a', [{ role: 'user', content: '1' }], 2);
    await history.append(
      'a',
      [
        { role: 'assistant', content: '2' },
        { role: 'user', content: '3' },
      ],
      2,
    );

    expect(await history.load('a')).toEqual([
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
    ]);
    expect(await history.load('b')).toEqual([]);
  });

  it('stores nothing when history is off', async () => {
    const history = createInMemoryContextHistory();
    await history.append('a', [{ role: 'user', content: '1' }], 0);
    expect(await history.load('a')).toEqual([]);
  });

  it('forgets idle contexts and evicts the least recently used', async () => {
    let now = 0;
    const history = createInMemoryContextHistory({ maxContexts: 2, ttlMs: 100, now: () => now });
    await history.append('a', [{ role: 'user', content: 'a' }], 5);
    await history.append('b', [{ role: 'user', content: 'b' }], 5);
    await history.load('a');
    await history.append('c', [{ role: 'user', content: 'c' }], 5);

    expect(await history.load('b')).toEqual([]);
    expect(await history.load('a')).toHaveLength(1);

    now = 500;
    expect(await history.load('c')).toEqual([]);
  });
});
