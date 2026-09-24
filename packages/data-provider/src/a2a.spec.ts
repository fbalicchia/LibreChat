import { A2AAgentsSchema, getA2AAgentKey, getA2AToolName, isA2ATool } from './a2a';
import { configSchema } from './config';

const agentCardUrl = 'https://agents.example.com/.well-known/agent-card.json';

describe('A2A config', () => {
  it('leaves the feature off when no agents are configured', () => {
    const config = configSchema.parse({ version: '1.3.0' });

    expect(config.a2aAgents).toBeUndefined();
    expect(config.a2aSettings).toBeUndefined();
  });

  it('applies defaults and keeps headers verbatim for runtime resolution', () => {
    const config = configSchema.parse({
      version: '1.3.0',
      a2aAgents: {
        textsql: {
          agentCardUrl,
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        },
      },
      a2aSettings: { allowedDomains: ['agents.example.com'] },
    });

    expect(config.a2aAgents?.textsql).toEqual({
      agentCardUrl,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      timeout: 120_000,
      streaming: true,
    });
    expect(config.a2aSettings?.allowedDomains).toEqual(['agents.example.com']);
  });

  it.each(['bad key', 'x'.repeat(60), 'lookup_mcp_server', 'get_action_x'])(
    'rejects the agent key %s',
    (key) => {
      expect(A2AAgentsSchema.safeParse({ [key]: { agentCardUrl } }).success).toBe(false);
    },
  );

  it('round-trips agent keys through tool names', () => {
    const toolName = getA2AToolName('text-sql');

    expect(toolName).toBe('a2a__text-sql');
    expect(isA2ATool(toolName)).toBe(true);
    expect(getA2AAgentKey(toolName)).toBe('text-sql');
    expect(isA2ATool('a2a__')).toBe(false);
    expect(getA2AAgentKey('web_search')).toBeUndefined();
  });
});

describe('isA2ATool', () => {
  it('rejects non-string entries from request bodies', () => {
    expect(isA2ATool(null)).toBe(false);
    expect(isA2ATool(undefined)).toBe(false);
    expect(getA2AAgentKey(null)).toBeUndefined();
  });
});
