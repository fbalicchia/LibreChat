import type { A2AHistoryMessage } from './history';

export interface A2AAgentRunRequest {
  /** Origin of this LibreChat's own HTTP server, e.g. `http://127.0.0.1:3080`. */
  baseURL: string;
  agentId: string;
  /**
   * The caller's Agent API key or OIDC token, forwarded to an endpoint behind the same
   * remote-agent auth, so the run sees exactly the caller's access.
   */
  bearerToken: string;
  messages: A2AHistoryMessage[];
  signal: AbortSignal;
}

/** Stable codes the executor maps to task states; never upstream text. */
export type A2ARunErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'agent_error'
  | 'empty_response';

export type A2AAgentRunResult =
  | { ok: true; text: string }
  | { ok: false; error: { code: A2ARunErrorCode; status?: number } };

/**
 * Runs one agent turn. Rejected outcomes of the run (auth, limits, agent errors) are
 * results; transport failures and aborts throw.
 */
export type A2AAgentRunner = (request: A2AAgentRunRequest) => Promise<A2AAgentRunResult>;

export interface ChatCompletionsRunnerOptions {
  fetchImpl?: typeof fetch;
}

const CHAT_COMPLETIONS_PATH = '/api/agents/v1/chat/completions';

function codeForStatus(status: number): A2ARunErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'agent_error';
  }
}

function readContent(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * Runs the agent through the OpenAI-compatible agents API, so A2A shares its
 * authentication, remote-access checks, content filters, tools, usage accounting and
 * tracing. Non-streaming on purpose: a failure after streaming starts is reported
 * in-band as text, while a blocking response keeps its HTTP status.
 */
export function createChatCompletionsRunner({
  fetchImpl = fetch,
}: ChatCompletionsRunnerOptions = {}): A2AAgentRunner {
  return async ({ baseURL, agentId, bearerToken, messages, signal }) => {
    const res = await fetchImpl(new URL(CHAT_COMPLETIONS_PATH, baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({ model: agentId, stream: false, messages }),
      redirect: 'error',
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, error: { code: codeForStatus(res.status), status: res.status } };
    }
    const text = readContent(await res.json()).trim();
    if (text === '') {
      return { ok: false, error: { code: 'empty_response' } };
    }
    return { ok: true, text };
  };
}
