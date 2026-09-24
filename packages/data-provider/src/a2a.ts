import { z } from 'zod';

/** Prefix of every tool name that invokes a configured A2A (Agent2Agent) agent. */
export const a2aToolPrefix = 'a2a__';

/** Default time an A2A agent call may take before it is aborted, in milliseconds. */
export const A2A_DEFAULT_TIMEOUT_MS = 120_000;

/** Tool names are limited to 64 characters by providers; the prefix takes 5 of them. */
const a2aAgentKeyPattern = /^[a-zA-Z0-9_-]{1,59}$/;

export const A2AAgentConfigSchema = z.object({
  /** Full URL of the agent card, e.g. `https://host/.well-known/agent-card.json`. */
  agentCardUrl: z.string().url(),
  /**
   * Service endpoint used instead of the interface URL advertised by the card, for agents
   * served behind a gateway or reverse proxy that cannot rewrite their own card.
   */
  url: z.string().url().optional(),
  /** Display name in the tool picker; defaults to the config key. */
  title: z.string().optional(),
  /** Tool description shown to the model; the agent card's description when omitted. */
  description: z.string().optional(),
  /**
   * Headers sent on every request, card fetch included. Values support `${ENV}` and the
   * `{{LIBRECHAT_USER_*}}`, `{{LIBRECHAT_BODY_*}}` and `{{LIBRECHAT_OPENID_*}}` placeholders.
   */
  headers: z.record(z.string()).optional(),
  timeout: z.number().int().min(1_000).max(3_600_000).default(A2A_DEFAULT_TIMEOUT_MS),
  /** Set to `false` to use blocking sends even when the card advertises streaming. */
  streaming: z.boolean().default(true),
});

/** Tool routing checks these delimiters, so a key containing one would be misrouted. */
const reservedToolDelimiters = ['_mcp_', '_action_'];

export const A2AAgentsSchema = z.record(
  z
    .string()
    .regex(a2aAgentKeyPattern, {
      message: 'A2A agent keys may only contain letters, numbers, "_" and "-" (max 59)',
    })
    .refine((key) => !reservedToolDelimiters.some((delimiter) => key.includes(delimiter)), {
      message: 'A2A agent keys may not contain "_mcp_" or "_action_"',
    }),
  A2AAgentConfigSchema,
);

export type A2AAgentConfig = z.infer<typeof A2AAgentConfigSchema>;
export type A2AAgentsConfig = z.infer<typeof A2AAgentsSchema>;

/** Tolerates null entries: agent tool lists arrive from untrusted request bodies. */
export function isA2ATool(toolName: string | null | undefined): boolean {
  return (
    typeof toolName === 'string' &&
    toolName.startsWith(a2aToolPrefix) &&
    toolName.length > a2aToolPrefix.length
  );
}

export function getA2AToolName(agentKey: string): string {
  return `${a2aToolPrefix}${agentKey}`;
}

/** Returns the config key of the agent a tool name invokes, or `undefined` for other tools. */
export function getA2AAgentKey(toolName: string | null | undefined): string | undefined {
  return isA2ATool(toolName) ? toolName?.slice(a2aToolPrefix.length) : undefined;
}
