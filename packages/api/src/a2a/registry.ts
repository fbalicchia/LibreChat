import { logger } from '@librechat/data-schemas';
import { Constants, getA2AAgentKey, getA2AToolName } from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { A2AAgentsConfig, TPlugin } from 'librechat-data-provider';
import type { JsonSchemaType } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { ActionToolDefinition } from '~/tools/definitions';
import type { A2ASettings } from './client';
import type { RequestBody } from '~/types';
import { createA2ATool, a2aToolSchema, getA2AToolDescription } from './tool';
import { resolveHeaders } from '~/utils/env';

export interface CreateA2AToolsParams {
  agents?: A2AAgentsConfig;
  settings?: A2ASettings;
  toolNames: string[];
  user: Partial<IUser> & { id: string };
  body?: RequestBody;
  /** The run's resolved conversation; the request body still says "new" on a first turn. */
  conversationId?: string;
  fetchImpl?: typeof fetch;
}

function configuredAgents(agents: A2AAgentsConfig | undefined, toolNames: string[]) {
  return toolNames.flatMap((toolName) => {
    const agentKey = getA2AAgentKey(toolName);
    const config = agentKey != null ? agents?.[agentKey] : undefined;
    return agentKey != null && config != null ? [{ toolName, agentKey, config }] : [];
  });
}

/** True only for A2A tool names whose agent is present in the current config. */
export function isConfiguredA2ATool(
  agents: A2AAgentsConfig | undefined,
  toolName: string,
): boolean {
  return configuredAgents(agents, [toolName]).length > 0;
}

/** Tool schemas for event-driven initialization; no network call is made. */
export function getA2AToolDefinitions(
  agents: A2AAgentsConfig | undefined,
  toolNames: string[],
): ActionToolDefinition[] {
  return configuredAgents(agents, toolNames).map(({ toolName, agentKey, config }) => ({
    name: toolName,
    description: getA2AToolDescription(agentKey, config),
    parameters: a2aToolSchema as unknown as JsonSchemaType,
  }));
}

/** Entries for the agent builder's tool picker, one per configured A2A agent. */
export function getA2APlugins(agents: A2AAgentsConfig | undefined): TPlugin[] {
  return Object.entries(agents ?? {}).map(([agentKey, config]) => ({
    name: config.title ?? agentKey,
    pluginKey: getA2AToolName(agentKey),
    description: getA2AToolDescription(agentKey, config),
    authenticated: true,
  }));
}

/** Instantiates the A2A tools an agent run is about to execute. */
export function createA2ATools({
  agents,
  settings,
  toolNames,
  user,
  body,
  conversationId = body?.conversationId,
  fetchImpl,
}: CreateA2AToolsParams): DynamicStructuredTool[] {
  const selected = configuredAgents(agents, toolNames);
  if (selected.length < toolNames.length) {
    logger.warn('[A2A] Skipping tools whose agent is no longer configured', {
      requested: toolNames.length,
      configured: selected.length,
    });
  }
  return selected.map(({ agentKey, config }) =>
    createA2ATool({
      agentKey,
      config,
      settings,
      fetchImpl,
      userId: user.id,
      conversationId: conversationId === Constants.NEW_CONVO ? undefined : conversationId,
      resolveHeaders: () =>
        resolveHeaders({ headers: config.headers, user, body, stripUnresolved: true }),
    }),
  );
}
