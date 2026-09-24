import {
  ClientFactory,
  ClientFactoryOptions,
  RestTransportFactory,
  JsonRpcTransportFactory,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client';
import type { A2AAgentConfig, TCustomConfig } from 'librechat-data-provider';
import type { Client } from '@a2a-js/sdk/client';
import type { AgentCard } from '@a2a-js/sdk';
import { isActionDomainAllowed } from '~/auth/domain';

export type A2ASettings = TCustomConfig['a2aSettings'];

export interface A2AConnectParams {
  config: A2AAgentConfig;
  /** Headers resolved for the current user and request, sent on every call. */
  headers: Record<string, string>;
  settings?: A2ASettings;
  fetchImpl?: typeof fetch;
}

export interface A2AConnection {
  client: Client;
  card: AgentCard;
}

/** Thrown when a configured or advertised URL is not allowed; never retried. */
export class A2AUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2AUrlPolicyError';
  }
}

async function assertUrlAllowed(url: string, settings: A2ASettings): Promise<void> {
  const allowed = await isActionDomainAllowed(
    url,
    settings?.allowedDomains,
    settings?.allowedAddresses,
  );
  if (!allowed) {
    throw new A2AUrlPolicyError(
      `A2A URL "${new URL(url).origin}" is not allowed; add it to a2aSettings.allowedDomains`,
    );
  }
}

/**
 * The card is fetched from an admin-configured URL but its interface URLs are
 * remote data: without an explicit override they must stay on the card's origin
 * unless the admin allowlisted their host.
 */
async function resolveInterfaceUrl(
  advertised: string,
  config: A2AAgentConfig,
  settings: A2ASettings,
): Promise<string> {
  if (config.url) {
    return config.url;
  }
  const sameOrigin = new URL(advertised).origin === new URL(config.agentCardUrl).origin;
  const hasAllowlist = (settings?.allowedDomains?.length ?? 0) > 0;
  if (!sameOrigin && !hasAllowlist) {
    throw new A2AUrlPolicyError(
      `A2A agent card points to "${new URL(advertised).origin}", outside its own origin; set "url" for this agent or allowlist the host in a2aSettings.allowedDomains`,
    );
  }
  await assertUrlAllowed(advertised, settings);
  return advertised;
}

/** Redirects are refused: a followed redirect would bypass the URL policy above. */
function withHeaders(fetchImpl: typeof fetch, headers: Record<string, string>): typeof fetch {
  const authedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) {
      merged.set(key, value);
    }
    return fetchImpl(input, { ...init, headers: merged, redirect: 'error' });
  };
  return Object.assign(authedFetch, { preconnect: fetchImpl.preconnect });
}

/**
 * Resolves the agent card and builds an SDK client for it. v0.3 and v1.0 agents
 * are both supported: the SDK picks the wire version from the card's shape.
 */
export async function connectA2AAgent({
  config,
  headers,
  settings,
  fetchImpl = fetch,
}: A2AConnectParams): Promise<A2AConnection> {
  await assertUrlAllowed(config.agentCardUrl, settings);
  if (config.url) {
    await assertUrlAllowed(config.url, settings);
  }

  const authedFetch = withHeaders(fetchImpl, headers);
  const legacyCompat = { enabled: true };
  const cardResolver = new DefaultAgentCardResolver({ legacyCompat, fetchImpl: authedFetch });
  const card = await cardResolver.resolve(config.agentCardUrl, '');
  const resolved = await Promise.allSettled(
    card.supportedInterfaces.map(async (agentInterface) => ({
      ...agentInterface,
      url: await resolveInterfaceUrl(agentInterface.url, config, settings),
    })),
  );
  const supportedInterfaces = resolved.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (supportedInterfaces.length === 0) {
    const rejection = resolved.find((result) => result.status === 'rejected');
    throw rejection?.reason ?? new A2AUrlPolicyError('A2A agent card declares no interfaces');
  }

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authedFetch, legacyCompat }),
        new RestTransportFactory({ fetchImpl: authedFetch, legacyCompat }),
      ],
      cardResolver,
    }),
  );
  const resolvedCard: AgentCard = { ...card, supportedInterfaces };
  const client = await factory.createFromAgentCard(resolvedCard);
  return { client, card: resolvedCard };
}
