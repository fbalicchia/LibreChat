import type { AgentCard } from '@a2a-js/sdk';

/** The agent fields a card is built from; plain values, not the stored document. */
export interface A2AServedAgent {
  id: string;
  name?: string | null;
  description?: string | null;
  conversation_starters?: string[] | null;
}

export interface BuildA2AAgentCardParams {
  agent: A2AServedAgent;
  /** The agent's JSON-RPC endpoint, e.g. `https://host/api/a2a/agents/agent_x`. */
  url: string;
  /** Public origin of this LibreChat, shown as the card's provider. */
  serverDomain: string;
}

/** Name of the card's security scheme: the bearer accepted by LibreChat's remote agents API. */
export const A2A_BEARER_SCHEME = 'librechatBearer';

const TEXT_MODES = ['text/plain'];
const MAX_EXAMPLES = 5;

/**
 * Describes one LibreChat agent as an A2A agent. The card advertises both the v1.0
 * and v0.3 JSON-RPC bindings on the same URL; the handler serves both.
 */
export function buildA2AAgentCard({
  agent,
  url,
  serverDomain,
}: BuildA2AAgentCardParams): AgentCard {
  const name = agent.name?.trim() || agent.id;
  const description = agent.description?.trim() || `LibreChat agent ${name}`;
  return {
    name,
    description,
    version: '1.0.0',
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' },
    ],
    provider: { organization: 'LibreChat', url: serverDomain },
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {
      [A2A_BEARER_SCHEME]: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            scheme: 'bearer',
            bearerFormat: 'Agent API key or OIDC access token',
            description:
              'A credential accepted by the remote agents API whose user can access this agent.',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { [A2A_BEARER_SCHEME]: { list: [] } } }],
    defaultInputModes: TEXT_MODES,
    defaultOutputModes: TEXT_MODES,
    skills: [
      {
        id: agent.id,
        name,
        description,
        tags: ['librechat-agent'],
        examples: (agent.conversation_starters ?? []).filter(Boolean).slice(0, MAX_EXAMPLES),
        inputModes: TEXT_MODES,
        outputModes: TEXT_MODES,
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
