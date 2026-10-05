import express from 'express';
import { a2aServerSchema } from 'librechat-data-provider';
import type { Request, RequestHandler, Router } from 'express';
import type { A2AServerConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { A2AContextHistory } from './history';
import type { A2AAgentRunner } from './runner';
import { createInMemoryContextHistory } from './history';
import { createChatCompletionsRunner } from './runner';
import { createA2AServer } from './handler';

export interface A2AServerRouterDeps {
  /**
   * Run in order before every A2A request: tenant resolution, Agent API key auth,
   * request config (`req.config`) and the remote-agents feature check.
   */
  authenticate: RequestHandler[];
  /** Checks remote access to the agent named by `:agentId`; see `createCheckAgentPathAccess`. */
  checkAgentAccess: RequestHandler;
  /** Public origin of this LibreChat (`DOMAIN_SERVER`). */
  serverDomain: string;
  /** Origin of this process's HTTP listener, used unless the config sets `internalBaseURL`. */
  defaultInternalBaseURL: string;
  runner?: A2AAgentRunner;
  history?: A2AContextHistory;
  taskStore?: TaskStore;
}

/**
 * Where this process reaches its own listener: `localhost` for a wildcard or unset
 * host (it resolves for both IPv4 and IPv6 listeners), otherwise the host itself.
 */
export function getA2AInternalBaseURL(host: string | undefined, port: number): string {
  if (host == null || host === '' || host === '0.0.0.0' || host === '::') {
    return `http://localhost:${port}`;
  }
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** The server settings of the request's config, or `undefined` while A2A serving is off. */
function enabledServerConfig(req: Request): A2AServerConfig | undefined {
  const server = (req as Request & { config?: AppConfig }).config?.a2aSettings?.server;
  return server?.enabled === true ? a2aServerSchema.parse(server) : undefined;
}

/**
 * Routes, relative to the mount point (`A2A_SERVER_PATH`):
 *  - `GET  /:agentId/.well-known/agent-card.json` the agent card
 *  - `POST /:agentId` JSON-RPC: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`
 * Both require an Agent API key with remote access to the agent; the card describes
 * the agent, so it is not served anonymously.
 */
export function createA2AServerRouter({
  authenticate,
  checkAgentAccess,
  serverDomain,
  defaultInternalBaseURL,
  runner = createChatCompletionsRunner(),
  history = createInMemoryContextHistory(),
  taskStore,
}: A2AServerRouterDeps): Router {
  const server = createA2AServer({
    runner,
    history,
    serverDomain,
    taskStore,
    getSettings: (req) => {
      const config = enabledServerConfig(req);
      return {
        maxHistoryMessages: config?.maxHistoryMessages ?? 0,
        runTimeoutMs: config?.runTimeoutMs ?? 0,
        baseURL: config?.internalBaseURL ?? defaultInternalBaseURL,
      };
    },
  });

  const requireEnabled: RequestHandler = (req, res, next) => {
    if (enabledServerConfig(req) == null) {
      res.status(404).json({ error: { code: 'a2a_server_disabled' } });
      return;
    }
    next();
  };

  const router = express.Router({ mergeParams: true });
  const guard = [...authenticate, requireEnabled, checkAgentAccess];
  router.use('/:agentId/.well-known/agent-card.json', ...guard, server.card);
  router.use('/:agentId', ...guard, server.rpc);
  return router;
}
