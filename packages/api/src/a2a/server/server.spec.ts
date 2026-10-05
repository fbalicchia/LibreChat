import express from 'express';
import { randomUUID } from 'crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import { A2A_SERVER_PATH, A2AAgentConfigSchema, getA2AAgentCardUrl } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import type { A2AAgentConfig } from 'librechat-data-provider';
import type { SendMessageRequest, Task } from '@a2a-js/sdk';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { A2AAgentRunRequest, A2AAgentRunResult } from './runner';
import { createA2AServerRouter } from './router';
import { connectA2AAgent } from '../client';
import { createA2ATool } from '../tool';

const AGENTS: Record<
  string,
  { id: string; name: string; description: string; conversation_starters: string[] }
> = {
  agent_weather: {
    id: 'agent_weather',
    name: 'Weather',
    description: 'Forecasts for Mars cities',
    conversation_starters: ['Weather in Olympus City?'],
  },
};

/** Answers by keyword; records every run so tests can check what the agent saw. */
class ScriptedRunner {
  runs: A2AAgentRunRequest[] = [];

  run = async (request: A2AAgentRunRequest): Promise<A2AAgentRunResult> => {
    this.runs.push(request);
    const input = request.messages[request.messages.length - 1].content;
    if (input.includes('forbidden')) {
      return { ok: false, error: { code: 'forbidden', status: 403 } };
    }
    if (input.includes('explode')) {
      throw new Error('mongodb://admin:hunter2@db leaked');
    }
    if (input.includes('hang')) {
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return { ok: true, text: `answer to: ${input}` };
  };
}

interface Harness {
  base: string;
  runner: ScriptedRunner;
  server: { enabled: boolean; maxHistoryMessages?: number; runTimeoutMs?: number };
  close: () => Promise<void>;
}

/** Stands in for tenant + Agent API key auth + config: `Bearer key-<userId>`. */
function fakeAuthenticate(harness: () => Harness) {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? '');
    if (!match) {
      res.status(401).json({ error: { code: 'invalid_api_key' } });
      return;
    }
    Object.assign(req, {
      user: { id: match[1] },
      config: { a2aSettings: { server: harness().server } },
    });
    next();
  };
}

function fakeAgentAccess(req: Request, res: Response, next: NextFunction) {
  const agent = AGENTS[req.params.agentId];
  if (!agent) {
    res.status(404).json({ error: { code: 'model_not_found' } });
    return;
  }
  Object.assign(req, { agent });
  next();
}

async function start(): Promise<Harness> {
  const app = express();
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runner = new ScriptedRunner();
  const harness: Harness = {
    base,
    runner,
    server: { enabled: true },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  app.use(
    A2A_SERVER_PATH,
    createA2AServerRouter({
      authenticate: [fakeAuthenticate(() => harness)],
      checkAgentAccess: fakeAgentAccess,
      serverDomain: base,
      defaultInternalBaseURL: 'http://127.0.0.1:3080',
      runner: runner.run,
    }),
  );
  return harness;
}

const userText = (value: string): SendMessageRequest => ({
  tenant: '',
  message: {
    messageId: randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: true,
  },
  metadata: undefined,
});

describe('A2A server', () => {
  let harness: Harness;
  let config: (overrides?: Partial<A2AAgentConfig>) => A2AAgentConfig;
  const settings = () => ({ allowedAddresses: [new URL(harness.base).host] });
  const connect = (userId = 'user-1') =>
    connectA2AAgent({
      config: config(),
      settings: settings(),
      headers: { Authorization: `Bearer key-${userId}` },
    });

  beforeEach(async () => {
    harness = await start();
    config = (overrides = {}) =>
      A2AAgentConfigSchema.parse({
        agentCardUrl: getA2AAgentCardUrl(harness.base, 'agent_weather'),
        ...overrides,
      });
  });

  afterEach(async () => {
    await harness.close();
  });

  const makeTool = (overrides: Partial<A2AAgentConfig> = {}, conversationId = 'convo-1') =>
    createA2ATool({
      agentKey: 'weather',
      config: config(overrides),
      settings: settings(),
      userId: 'user-1',
      conversationId,
      resolveHeaders: () => ({ Authorization: 'Bearer key-user-1' }),
    });

  it('serves a card that describes the agent on its own URL', async () => {
    const { card } = await connect();

    expect(card.name).toBe('Weather');
    expect(card.description).toBe('Forecasts for Mars cities');
    expect(card.skills[0].examples).toEqual(['Weather in Olympus City?']);
    expect(card.supportedInterfaces.map((i) => i.url)).toContain(
      `${harness.base}${A2A_SERVER_PATH}/agent_weather`,
    );
  });

  it('requires an API key for the card', async () => {
    const res = await fetch(getA2AAgentCardUrl(harness.base, 'agent_weather'));
    expect(res.status).toBe(401);
  });

  it('answers 404 while serving is disabled', async () => {
    harness.server = { enabled: false };
    const res = await fetch(getA2AAgentCardUrl(harness.base, 'agent_weather'), {
      headers: { Authorization: 'Bearer key-user-1' },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('a2a_server_disabled');
  });

  it.each([true, false])('runs the agent for the caller (streaming %s)', async (streaming) => {
    const output = await makeTool({ streaming }).invoke({ message: 'weather in Olympus City?' });

    expect(output).toBe('answer to: weather in Olympus City?');
    expect(harness.runner.runs).toHaveLength(1);
    expect(harness.runner.runs[0]).toMatchObject({
      agentId: 'agent_weather',
      bearerToken: 'key-user-1',
      baseURL: 'http://127.0.0.1:3080',
    });
  });

  it('replays earlier turns of the same context, and only of it', async () => {
    harness.server = { enabled: true, maxHistoryMessages: 10 };
    await makeTool().invoke({ message: 'first question' });
    await makeTool().invoke({ message: 'follow-up' });
    await makeTool({}, 'convo-2').invoke({ message: 'other conversation' });

    expect(harness.runner.runs[1].messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer to: first question' },
      { role: 'user', content: 'follow-up' },
    ]);
    expect(harness.runner.runs[2].messages).toEqual([
      { role: 'user', content: 'other conversation' },
    ]);
  });

  it('fails the task with a stable code when the run is rejected', async () => {
    await expect(makeTool().invoke({ message: 'forbidden please' })).rejects.toThrow(
      /TASK_STATE_FAILED: The API key has no remote access to this agent\./,
    );
  });

  it('never forwards the text of an unexpected error', async () => {
    const error: Error = await makeTool()
      .invoke({ message: 'explode' })
      .then(() => new Error('resolved'))
      .catch((caught: Error) => caught);

    expect(error.message).toMatch(/TASK_STATE_FAILED: The agent failed to answer\./);
    expect(error.message).not.toMatch(/hunter2|mongodb/);
  });

  it('cancels a running task and aborts its run', async () => {
    const { client } = await connect();
    const task = (await client.sendMessage(userText('hang until canceled'))) as Task;
    expect([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]).toContain(
      task.status?.state,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const canceled = await client.cancelTask({ tenant: '', id: task.id, metadata: undefined });

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(harness.runner.runs[0].signal.aborted).toBe(true);
  });

  it('fails a run that exceeds the timeout', async () => {
    harness.server = { enabled: true, runTimeoutMs: 1_000 };
    await expect(makeTool().invoke({ message: 'hang forever' })).rejects.toThrow(
      /The agent did not answer in time\./,
    );
  });

  it('hides a task from other users', async () => {
    const { client } = await connect('user-1');
    const task = (await client.sendMessage(userText('hello'))) as Task;
    const { client: intruder } = await connect('user-2');

    await expect(intruder.getTask({ tenant: '', id: task.id, historyLength: 0 })).rejects.toThrow(
      /not found/i,
    );
  });

  it('rejects messages with file parts', async () => {
    const { client } = await connect();
    const request = userText('see attachment');
    request.message!.parts.push({
      content: { $case: 'url', value: 'https://example.com/a.pdf' },
      metadata: undefined,
      filename: 'a.pdf',
      mediaType: 'application/pdf',
    });
    request.configuration!.returnImmediately = false;

    const task = (await client.sendMessage(request)) as Task;

    expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(harness.runner.runs).toHaveLength(0);
  });
});
