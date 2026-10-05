import { getA2AAgentUrl } from 'librechat-data-provider';
import { jsonRpcHandler, agentCardHandler } from '@a2a-js/sdk/server/express';
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  DefaultExecutionEventBusManager,
} from '@a2a-js/sdk/server';
import type { Request, RequestHandler } from 'express';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { A2AContextHistory } from './history';
import type { A2ARunSettings } from './executor';
import type { A2AAgentRunner } from './runner';
import type { A2AServedAgent } from './card';
import { LibreChatAgentExecutor, A2ACaller } from './executor';
import { buildA2AAgentCard } from './card';

export interface CreateA2AServerOptions {
  runner: A2AAgentRunner;
  history: A2AContextHistory;
  /** Settings for the request's task, read from its config. */
  getSettings: (req: Request) => A2ARunSettings;
  /** Public origin of this LibreChat (`DOMAIN_SERVER`); card URLs are built from it. */
  serverDomain: string;
  /** Defaults to a process-local store, scoped per caller and agent. */
  taskStore?: TaskStore;
}

/** What the API-key and remote-access middleware leave on the request before A2A runs. */
interface A2AAuthedRequest extends Request {
  user?: { id: string };
  agent?: A2AServedAgent;
}

export interface A2AServer {
  /** Serves the agent card; mount at `/:agentId/.well-known/agent-card.json`. */
  card: RequestHandler;
  /** Serves JSON-RPC (`message/send`, `message/stream`, `tasks/*`); mount at `/:agentId`. */
  rpc: RequestHandler;
}

const BEARER_PREFIX = 'Bearer ';

function readAuthed(req: Request) {
  const { user, agent } = req as A2AAuthedRequest;
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
  if (user?.id == null || agent?.id == null || bearerToken === '') {
    return undefined;
  }
  return { user, agent, bearerToken };
}

/**
 * Serves each LibreChat agent as its own A2A agent. Authentication and the
 * remote-access check run before these handlers; the task store, event buses and
 * executor are shared so a task can be read or canceled from a later request.
 */
export function createA2AServer({
  runner,
  history,
  getSettings,
  serverDomain,
  taskStore = new InMemoryTaskStore(),
}: CreateA2AServerOptions): A2AServer {
  const eventBusManager = new DefaultExecutionEventBusManager();
  const executor = new LibreChatAgentExecutor({ runner, history });

  const cardFor = (agent: A2AServedAgent) =>
    buildA2AAgentCard({ agent, url: getA2AAgentUrl(serverDomain, agent.id), serverDomain });

  const card: RequestHandler = (req, res, next) => {
    const authed = readAuthed(req);
    if (authed == null) {
      res.status(401).json({ error: { code: 'unauthorized' } });
      return;
    }
    const agentCard = cardFor(authed.agent);
    return agentCardHandler({
      agentCardProvider: async () => agentCard,
      cache: { maxAge: 0 },
      legacyCompat: { enabled: true },
    })(req, res, next);
  };

  const rpc: RequestHandler = (req, res, next) => {
    const authed = readAuthed(req);
    if (authed == null) {
      res.status(401).json({ error: { code: 'unauthorized' } });
      return;
    }
    const caller = new A2ACaller(
      authed.user.id,
      authed.agent.id,
      authed.bearerToken,
      getSettings(req),
    );
    const requestHandler = new DefaultRequestHandler(
      cardFor(authed.agent),
      taskStore,
      executor,
      eventBusManager,
    );
    return jsonRpcHandler({
      requestHandler,
      userBuilder: async () => caller,
      legacyCompat: { enabled: true },
    })(req, res, next);
  };

  return { card, rpc };
}
