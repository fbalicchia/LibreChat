import { Role, TaskState } from '@a2a-js/sdk';
import { createHash, randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { getA2AToolName } from 'librechat-data-provider';
import type { Part, Task, Message, StreamResponse, SendMessageRequest } from '@a2a-js/sdk';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { A2AAgentConfig } from 'librechat-data-provider';
import type { Client } from '@a2a-js/sdk/client';
import type { A2ASettings } from './client';
import { connectA2AAgent } from './client';

export interface A2AToolInput {
  message: string;
  taskId?: string;
}

export interface CreateA2AToolParams {
  agentKey: string;
  config: A2AAgentConfig;
  settings?: A2ASettings;
  userId: string;
  /** Keys the remote context, so follow-ups in one conversation continue the agent's context. */
  conversationId?: string;
  /** Resolved on every call so short-lived credentials are read fresh. */
  resolveHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface A2AOutcome {
  taskId?: string;
  contextId?: string;
  state?: TaskState;
  artifacts: Map<string, Part[]>;
  statusParts: Part[];
  messageParts: Part[];
}

const terminalStates = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const failedStates = new Set([
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const CANCEL_TIMEOUT_MS = 5_000;

export const a2aToolSchema = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'The request for the agent in natural language. Include every detail it needs: it does not see this conversation.',
    },
    taskId: {
      type: 'string',
      description:
        'Only when answering an agent that asked for more input: the taskId from its previous reply.',
    },
  },
  required: ['message'],
} as const;

export function getA2AToolDescription(agentKey: string, config: A2AAgentConfig): string {
  if (config.description) {
    return config.description;
  }
  return `Delegates a task to the remote "${config.title ?? agentKey}" agent over the A2A protocol and returns its answer.`;
}

/** Deterministic, so every turn of a conversation lands in the same remote context. */
export function deriveA2AContextId(
  userId: string,
  conversationId: string,
  agentKey: string,
): string {
  const hex = createHash('sha256').update(`${userId}:${conversationId}:${agentKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: '' };
}

function partToText(part: Part): string {
  const content = part.content;
  switch (content?.$case) {
    case 'text':
      return content.value;
    case 'data':
      return JSON.stringify(content.value);
    case 'url':
      return `[file ${part.filename || part.mediaType}] ${content.value}`;
    case 'raw':
      return `[binary file ${part.filename || part.mediaType} omitted]`;
    default:
      return '';
  }
}

function partsToText(parts: Part[]): string {
  return parts.map(partToText).filter(Boolean).join('\n');
}

function applyTask(outcome: A2AOutcome, task: Task): void {
  outcome.taskId = task.id;
  outcome.contextId = task.contextId;
  outcome.state = task.status?.state;
  outcome.statusParts = task.status?.message?.parts ?? outcome.statusParts;
  for (const artifact of task.artifacts) {
    outcome.artifacts.set(artifact.artifactId, artifact.parts);
  }
}

function applyEvent(outcome: A2AOutcome, event: StreamResponse): void {
  const payload = event.payload;
  switch (payload?.$case) {
    case 'task':
      applyTask(outcome, payload.value);
      return;
    case 'message':
      outcome.messageParts = payload.value.parts;
      return;
    case 'statusUpdate':
      outcome.taskId = payload.value.taskId;
      outcome.state = payload.value.status?.state;
      outcome.statusParts = payload.value.status?.message?.parts ?? outcome.statusParts;
      return;
    case 'artifactUpdate': {
      const artifact = payload.value.artifact;
      if (!artifact) {
        return;
      }
      const existing = payload.value.append
        ? (outcome.artifacts.get(artifact.artifactId) ?? [])
        : [];
      outcome.artifacts.set(artifact.artifactId, [...existing, ...artifact.parts]);
      return;
    }
    default:
      return;
  }
}

function isTask(result: Message | Task): result is Task {
  return 'artifacts' in result;
}

/** Turns the final A2A state into the text the calling model reads. */
function formatA2AOutcome(agentName: string, outcome: A2AOutcome): string {
  const statusText = partsToText(outcome.statusParts);
  const answer = [...outcome.artifacts.values(), outcome.messageParts]
    .map(partsToText)
    .filter(Boolean)
    .join('\n\n');

  if (outcome.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    return `${agentName} needs more input to continue (taskId: ${outcome.taskId}).\n${statusText}\nAsk the user, then call this tool again with the answer and the same taskId.`;
  }
  if (outcome.state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    throw new Error(`${agentName} requires additional authentication, which is not supported yet.`);
  }
  if (outcome.state != null && failedStates.has(outcome.state)) {
    throw new Error(`${agentName} ended the task as ${TaskState[outcome.state]}: ${statusText}`);
  }
  if (outcome.state != null && !terminalStates.has(outcome.state)) {
    return `${agentName} is still working on the task (taskId: ${outcome.taskId}).${answer ? `\nPartial result:\n${answer}` : ''}`;
  }
  return answer || statusText || `${agentName} completed the task without returning content.`;
}

async function sendAndCollect(
  client: Client,
  request: SendMessageRequest,
  streaming: boolean,
  signal: AbortSignal,
  outcome: A2AOutcome,
): Promise<void> {
  if (!streaming) {
    const result = await client.sendMessage(request, { signal });
    if (isTask(result)) {
      applyTask(outcome, result);
    } else {
      outcome.messageParts = result.parts;
    }
    return;
  }
  for await (const event of client.sendMessageStream(request, { signal })) {
    applyEvent(outcome, event);
  }
}

async function cancelRemoteTask(client: Client, taskId: string): Promise<void> {
  try {
    await client.cancelTask(
      { tenant: '', id: taskId, metadata: undefined },
      { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) },
    );
  } catch (error) {
    logger.debug('[A2A] Remote task cancellation failed', { taskId, error });
  }
}

/** Creates the tool through which an agent delegates work to one configured A2A agent. */
export function createA2ATool({
  agentKey,
  config,
  settings,
  userId,
  conversationId,
  resolveHeaders,
  fetchImpl,
}: CreateA2AToolParams): DynamicStructuredTool {
  const agentName = config.title ?? agentKey;
  return tool(
    async (input: A2AToolInput, runConfig): Promise<string> => {
      const signal = AbortSignal.any(
        [runConfig?.signal, AbortSignal.timeout(config.timeout)].filter(
          (s): s is AbortSignal => s != null,
        ),
      );
      const { client, card } = await connectA2AAgent({
        config,
        settings,
        fetchImpl,
        headers: resolveHeaders(),
      });
      const request: SendMessageRequest = {
        tenant: '',
        message: {
          messageId: randomUUID(),
          contextId: conversationId ? deriveA2AContextId(userId, conversationId, agentKey) : '',
          taskId: input.taskId ?? '',
          role: Role.ROLE_USER,
          parts: [textPart(input.message)],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately: false,
        },
        metadata: undefined,
      };
      const outcome: A2AOutcome = { artifacts: new Map(), statusParts: [], messageParts: [] };
      const streaming = config.streaming && card.capabilities?.streaming === true;
      try {
        await sendAndCollect(client, request, streaming, signal, outcome);
      } catch (error) {
        const pending = outcome.state == null || !terminalStates.has(outcome.state);
        if (signal.aborted && outcome.taskId && pending) {
          await cancelRemoteTask(client, outcome.taskId);
        }
        throw error;
      }
      return formatA2AOutcome(agentName, outcome);
    },
    {
      name: getA2AToolName(agentKey),
      description: getA2AToolDescription(agentKey, config),
      schema: a2aToolSchema,
    },
  ) as unknown as DynamicStructuredTool;
}
