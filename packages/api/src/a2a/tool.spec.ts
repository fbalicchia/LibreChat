import express from 'express';
import { randomUUID } from 'crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import { A2AAgentConfigSchema } from 'librechat-data-provider';
import { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } from '@a2a-js/sdk/server';
import { UserBuilder, jsonRpcHandler, agentCardHandler } from '@a2a-js/sdk/server/express';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { AgentCard, Part, TaskStatus } from '@a2a-js/sdk';
import type { A2AAgentConfig } from 'librechat-data-provider';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createA2ATool, deriveA2AContextId } from './tool';
import { A2AUrlPolicyError } from './client';

const text = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

interface Received {
  input: string;
  taskId: string;
  contextId: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Replies by keyword so each test drives one A2A task outcome. */
class ScriptedExecutor implements AgentExecutor {
  received: Received[] = [];
  canceled: string[] = [];
  headers: Record<string, string | string[] | undefined> = {};
  releaseHang: () => void = () => undefined;

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const input = ctx.userMessage.parts.map((part) => part.content?.value ?? '').join('');
    this.received.push({
      input,
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      headers: this.headers,
    });
    const status = (state: TaskState, reply?: string): TaskStatus => ({
      state,
      message: reply
        ? {
            messageId: randomUUID(),
            contextId: ctx.contextId,
            taskId: ctx.taskId,
            role: Role.ROLE_AGENT,
            parts: [text(reply)],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          }
        : undefined,
      timestamp: undefined,
    });
    const update = (state: TaskState, reply?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: status(state, reply),
          metadata: undefined,
        }),
      );

    bus.publish(
      AgentEvent.task(
        ctx.task ?? {
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: status(TaskState.TASK_STATE_SUBMITTED),
          artifacts: [],
          history: [ctx.userMessage],
          metadata: undefined,
        },
      ),
    );
    update(TaskState.TASK_STATE_WORKING);

    if (input.includes('need-month')) {
      update(TaskState.TASK_STATE_INPUT_REQUIRED, 'Which month?');
    } else if (input.includes('explode')) {
      update(TaskState.TASK_STATE_FAILED, 'database unavailable');
    } else if (input.includes('hang')) {
      await new Promise<void>((resolve) => {
        this.releaseHang = resolve;
      });
      return;
    } else {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: {
            artifactId: 'answer',
            name: 'answer',
            description: '',
            parts: [
              text(`echo: ${input}`),
              { ...text(''), content: { $case: 'data', value: { rows: 2 } } },
            ],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      update(TaskState.TASK_STATE_COMPLETED);
    }
    bus.finished();
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.canceled.push(taskId);
    this.releaseHang();
    bus.finished();
  }
}

interface TestAgent {
  base: string;
  executor: ScriptedExecutor;
  close: () => Promise<void>;
}

async function startAgent({ foreignInterface = false } = {}): Promise<TestAgent> {
  const app = express();
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpcUrl = foreignInterface ? 'http://agent.internal.example:9000/rpc' : `${base}/rpc`;
  const card: AgentCard = {
    name: 'probe',
    description: 'Answers questions about data',
    version: '1.0.0',
    supportedInterfaces: [
      { url: rpcUrl, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
      { url: rpcUrl, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' },
    ],
    provider: undefined,
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    signatures: [],
  };
  const executor = new ScriptedExecutor();
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);

  app.use((req, _res, next) => {
    executor.headers = req.headers;
    next();
  });
  app.use('/v1/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.get('/v03/.well-known/agent-card.json', (_req, res) => {
    res.json({
      protocolVersion: '0.3.0',
      name: 'probe',
      description: 'Answers questions about data',
      url: rpcUrl,
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    });
  });
  app.use(
    '/rpc',
    express.json(),
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );

  return {
    base,
    executor,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const configFor = (input: Partial<A2AAgentConfig> & { agentCardUrl: string }): A2AAgentConfig =>
  A2AAgentConfigSchema.parse(input);

describe('createA2ATool', () => {
  let agent: TestAgent;
  let settings: { allowedAddresses: string[] };

  beforeEach(async () => {
    agent = await startAgent();
    settings = { allowedAddresses: [new URL(agent.base).host] };
  });

  afterEach(async () => {
    await agent.close();
  });

  const makeTool = (config: A2AAgentConfig, overrides: { conversationId?: string } = {}) =>
    createA2ATool({
      agentKey: 'textsql',
      config,
      settings,
      userId: 'user-1',
      conversationId: overrides.conversationId ?? 'convo-1',
      resolveHeaders: () => ({ Authorization: 'Bearer user-token' }),
    });

  it.each([
    ['v1.0', 'v1', true],
    ['v1.0', 'v1', false],
    ['v0.3', 'v03', true],
    ['v0.3', 'v03', false],
  ])('returns the answer of a %s agent (card %s, streaming %s)', async (_v, path, streaming) => {
    const tool = makeTool(
      configFor({ agentCardUrl: `${agent.base}/${path}/.well-known/agent-card.json`, streaming }),
    );

    const output = await tool.invoke({ message: 'rows in orders?' });

    expect(output).toBe('echo: rows in orders?\n{"rows":2}');
    expect(agent.executor.headers.authorization).toBe('Bearer user-token');
  });

  it('keeps one remote context per conversation across calls', async () => {
    const config = configFor({ agentCardUrl: `${agent.base}/v1/.well-known/agent-card.json` });

    await makeTool(config).invoke({ message: 'first' });
    await makeTool(config).invoke({ message: 'second' });
    await makeTool(config, { conversationId: 'convo-2' }).invoke({ message: 'third' });

    const [first, second, third] = agent.executor.received;
    expect(first.contextId).toBe(deriveA2AContextId('user-1', 'convo-1', 'textsql'));
    expect(second.contextId).toBe(first.contextId);
    expect(third.contextId).not.toBe(first.contextId);
  });

  it('surfaces input-required with the taskId and continues that task', async () => {
    const tool = makeTool(
      configFor({ agentCardUrl: `${agent.base}/v03/.well-known/agent-card.json` }),
    );

    const question = await tool.invoke({ message: 'sales? need-month' });
    const taskId = agent.executor.received[0].taskId;

    expect(question).toContain('Which month?');
    expect(question).toContain(`taskId: ${taskId}`);

    const answer = await tool.invoke({ message: 'March', taskId });

    expect(agent.executor.received[1].taskId).toBe(taskId);
    expect(answer).toBe('echo: March\n{"rows":2}');
  });

  it('throws when the remote task fails', async () => {
    const tool = makeTool(
      configFor({ agentCardUrl: `${agent.base}/v1/.well-known/agent-card.json` }),
    );

    await expect(tool.invoke({ message: 'explode' })).rejects.toThrow('database unavailable');
  });

  it('cancels the remote task when the call times out', async () => {
    const tool = makeTool(
      configFor({ agentCardUrl: `${agent.base}/v1/.well-known/agent-card.json`, timeout: 1_000 }),
    );

    await expect(tool.invoke({ message: 'hang' })).rejects.toThrow();
    expect(agent.executor.canceled).toEqual([agent.executor.received[0].taskId]);
  });
});

describe('A2A service URL policy', () => {
  let agent: TestAgent;

  beforeEach(async () => {
    agent = await startAgent({ foreignInterface: true });
  });

  afterEach(async () => {
    await agent.close();
  });

  const invoke = (config: A2AAgentConfig) =>
    createA2ATool({
      agentKey: 'gateway',
      config,
      settings: { allowedAddresses: [new URL(agent.base).host] },
      userId: 'user-1',
      resolveHeaders: () => ({}),
    }).invoke({ message: 'hello' });

  it('rejects a card whose interface points outside its origin', async () => {
    const config = configFor({ agentCardUrl: `${agent.base}/v1/.well-known/agent-card.json` });

    await expect(invoke(config)).rejects.toBeInstanceOf(A2AUrlPolicyError);
    expect(agent.executor.received).toHaveLength(0);
  });

  it('calls the configured url instead of the advertised one', async () => {
    const config = configFor({
      agentCardUrl: `${agent.base}/v03/.well-known/agent-card.json`,
      url: `${agent.base}/rpc`,
    });

    await expect(invoke(config)).resolves.toBe('echo: hello\n{"rows":2}');
  });

  it('refuses a private card url that is not allowlisted', async () => {
    const tool = createA2ATool({
      agentKey: 'private',
      config: configFor({ agentCardUrl: `${agent.base}/v1/.well-known/agent-card.json` }),
      userId: 'user-1',
      resolveHeaders: () => ({}),
    });

    await expect(tool.invoke({ message: 'hello' })).rejects.toBeInstanceOf(A2AUrlPolicyError);
  });
});
