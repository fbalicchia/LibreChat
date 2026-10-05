/** One turn replayed to the agent when a client continues an A2A context. */
export interface A2AHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Turns of each A2A context, keyed by a scope that already includes the caller and
 * the agent. A second implementation (e.g. database-backed) is a new argument to
 * `createA2AServer`, not a branch inside it.
 */
export interface A2AContextHistory {
  load(scope: string): Promise<A2AHistoryMessage[]>;
  /** Appends turns and keeps only the latest `maxMessages` of the context. */
  append(scope: string, messages: A2AHistoryMessage[], maxMessages: number): Promise<void>;
}

export interface InMemoryContextHistoryOptions {
  /** Contexts kept at once; the least recently used is evicted first. */
  maxContexts?: number;
  /** A context unused for this long starts over, in milliseconds. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_CONTEXTS = 1_000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Process-local history: contexts survive within one instance only, so a deployment
 * with several instances needs sticky sessions or a shared implementation.
 */
export function createInMemoryContextHistory({
  maxContexts = DEFAULT_MAX_CONTEXTS,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
}: InMemoryContextHistoryOptions = {}): A2AContextHistory {
  const contexts = new Map<string, { messages: A2AHistoryMessage[]; touchedAt: number }>();

  const live = (scope: string) => {
    const entry = contexts.get(scope);
    if (entry == null) {
      return undefined;
    }
    contexts.delete(scope);
    if (now() - entry.touchedAt > ttlMs) {
      return undefined;
    }
    contexts.set(scope, entry);
    return entry;
  };

  return {
    async load(scope) {
      return [...(live(scope)?.messages ?? [])];
    },
    async append(scope, messages, maxMessages) {
      if (maxMessages <= 0) {
        return;
      }
      const kept = [...(live(scope)?.messages ?? []), ...messages].slice(-maxMessages);
      contexts.set(scope, { messages: kept, touchedAt: now() });
      for (const oldest of contexts.keys()) {
        if (contexts.size <= maxContexts) {
          break;
        }
        contexts.delete(oldest);
      }
    },
  };
}
