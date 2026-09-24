import { A2AAgentsSchema } from 'librechat-data-provider';
import { getA2APlugins, isConfiguredA2ATool } from './registry';

const agents = A2AAgentsSchema.parse({
  textsql: {
    title: 'Text to SQL',
    agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
  },
});

describe('A2A registry', () => {
  it('lists one picker entry per configured agent', () => {
    expect(getA2APlugins(agents)).toEqual([
      {
        name: 'Text to SQL',
        pluginKey: 'a2a__textsql',
        description:
          'Delegates a task to the remote "Text to SQL" agent over the A2A protocol and returns its answer.',
        authenticated: true,
      },
    ]);
    expect(getA2APlugins(undefined)).toEqual([]);
  });

  it('accepts only tool names whose agent is configured', () => {
    expect(isConfiguredA2ATool(agents, 'a2a__textsql')).toBe(true);
    expect(isConfiguredA2ATool(agents, 'a2a__other')).toBe(false);
    expect(isConfiguredA2ATool(undefined, 'a2a__textsql')).toBe(false);
    expect(isConfiguredA2ATool(agents, 'textsql')).toBe(false);
  });
});
