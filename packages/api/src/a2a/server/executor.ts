import { randomUUID } from 'crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import { logger } from '@librechat/data-schemas';
import type { AgentExecutor, ExecutionEventBus, RequestContext, User } from '@a2a-js/sdk/server';
import type { Message, Part, TaskStatus } from '@a2a-js/sdk';
import type { A2AAgentRunner, A2ARunErrorCode } from './runner';
import type { A2AContextHistory } from './history';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The authenticated caller of one A2A request. Its `userName` scopes the SDK's task
 * store and event buses, so tasks are visible only to the same user on the same agent.
 */
export class A2ACaller implements User {
  constructor(
    readonly userId: string,
    readonly agentId: string,
    readonly bearerToken: string,
    /** Read from the request's config, so a config change applies to the next task. */
    readonly settings: A2ARunSettings,
  ) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return `${this.userId}:${this.agentId}`;
  }
}

/** Codes a client can branch on; the text beside them is fixed and safe to show. */
export type A2ATaskErrorCode =
  | A2ARunErrorCode
  | 'timeout'
  | 'unsupported_content'
  | 'internal_error';

const ERROR_TEXT: Record<A2ATaskErrorCode, string> = {
  invalid_request: 'The agent rejected the request.',
  unauthorized: 'The API key is not valid for this agent.',
  forbidden: 'The API key has no remote access to this agent.',
  not_found: 'The agent was not found.',
  conflict: 'The agent cannot run for this account right now.',
  rate_limited: 'Too many requests; retry later.',
  agent_error: 'The agent failed to answer.',
  empty_response: 'The agent returned an empty answer.',
  timeout: 'The agent did not answer in time.',
  unsupported_content: 'Only text and data parts are supported.',
  internal_error: 'The agent failed to answer.',
};

export interface A2ARunSettings {
  maxHistoryMessages: number;
  runTimeoutMs: number;
  /** Origin of the agents API the run goes through. */
  baseURL: string;
}

export interface LibreChatAgentExecutorOptions {
  runner: A2AAgentRunner;
  history: A2AContextHistory;
}

interface RunningTask {
  contextId: string;
  controller: AbortController;
  canceled: boolean;
  timedOut: boolean;
}

const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

/** Text of the parts an agent can read; `undefined` when the message carries files. */
function readUserText(message: Message): string | undefined {
  const texts: string[] = [];
  for (const part of message.parts) {
    const content = part.content;
    if (content?.$case === 'text') {
      texts.push(content.value);
    } else if (content?.$case === 'data') {
      texts.push(JSON.stringify(content.value));
    } else if (content != null) {
      return undefined;
    }
  }
  return texts.join('\n').trim();
}

/**
 * Runs LibreChat agents for A2A tasks. One instance serves every agent: the agent and
 * the caller's key come from the request's {@link A2ACaller}, and the running-task map
 * is shared so `tasks/cancel` reaches a run started by another request.
 */
export class LibreChatAgentExecutor implements AgentExecutor {
  private readonly running = new Map<string, RunningTask>();

  constructor(private readonly options: LibreChatAgentExecutorOptions) {}

  execute = async (ctx: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId } = ctx;
    const status = (state: TaskState, text?: string): TaskStatus => ({
      state,
      message: text ? this.agentMessage(taskId, contextId, text) : undefined,
      timestamp: new Date().toISOString(),
    });
    const update = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(state, text),
          metadata: undefined,
        }),
      );
    const fail = (state: TaskState, code: A2ATaskErrorCode) => {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(state, ERROR_TEXT[code]),
          metadata: { code },
        }),
      );
    };

    bus.publish(
      AgentEvent.task(
        ctx.task ?? {
          id: taskId,
          contextId,
          status: status(TaskState.TASK_STATE_SUBMITTED),
          artifacts: [],
          history: [ctx.userMessage],
          metadata: undefined,
        },
      ),
    );

    const caller = ctx.context.user;
    if (!(caller instanceof A2ACaller)) {
      fail(TaskState.TASK_STATE_REJECTED, 'unauthorized');
      bus.finished();
      return;
    }
    const input = readUserText(ctx.userMessage);
    if (input == null || input === '') {
      fail(TaskState.TASK_STATE_REJECTED, 'unsupported_content');
      bus.finished();
      return;
    }

    update(TaskState.TASK_STATE_WORKING);
    const { runner, history } = this.options;
    const { maxHistoryMessages, runTimeoutMs, baseURL } = caller.settings;
    const scope = `${caller.userName}:${contextId}`;
    const task: RunningTask = {
      contextId,
      controller: new AbortController(),
      canceled: false,
      timedOut: false,
    };
    this.running.set(taskId, task);
    const timer = setTimeout(() => {
      task.timedOut = true;
      task.controller.abort();
    }, runTimeoutMs);

    try {
      const prior = maxHistoryMessages > 0 ? await history.load(scope) : [];
      const result = await runner({
        baseURL,
        agentId: caller.agentId,
        bearerToken: caller.bearerToken,
        messages: [...prior, { role: 'user', content: input }],
        signal: task.controller.signal,
      });
      if (task.canceled) {
        return;
      }
      if (!result.ok) {
        fail(TaskState.TASK_STATE_FAILED, result.error.code);
        return;
      }
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: `${taskId}-response`,
            name: 'response',
            description: '',
            parts: [textPart(result.text)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      update(TaskState.TASK_STATE_COMPLETED);
      if (maxHistoryMessages > 0) {
        await history.append(
          scope,
          [
            { role: 'user', content: input },
            { role: 'assistant', content: result.text },
          ],
          maxHistoryMessages,
        );
      }
    } catch (error) {
      if (task.canceled) {
        return;
      }
      if (task.timedOut) {
        fail(TaskState.TASK_STATE_FAILED, 'timeout');
        return;
      }
      logger.error('[A2A server] Agent run failed', getSafeErrorMetadata(error));
      fail(TaskState.TASK_STATE_FAILED, 'internal_error');
    } finally {
      clearTimeout(timer);
      this.running.delete(taskId);
      if (!task.canceled) {
        bus.finished();
      }
    }
  };

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    const task = this.running.get(taskId);
    if (task != null) {
      task.canceled = true;
      task.controller.abort();
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: task.contextId,
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );
    }
    bus.finished();
  };

  private agentMessage(taskId: string, contextId: string, text: string): Message {
    return {
      messageId: randomUUID(),
      contextId,
      taskId,
      role: Role.ROLE_AGENT,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
  }
}
