/**
 * Kiro provider — AWS CodeWhisperer / Amazon Q `GenerateAssistantResponse`.
 *
 * Auth: the bearer access token is supplied as the WrongStack `apiKey`
 * (obtained from a Kiro / kiro-cli login). The provider speaks the Q
 * conversation-state wire format and parses the binary Event Stream body
 * into canonical `StreamEvent`s.
 */

import type { Capabilities, Request, StreamEvent, StopReason, Usage } from '@wrongstack/core';
import { ProviderError } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { WireAdapter } from '../wire-adapter.js';
import { parseKiroEvents } from './event-parser.js';
import { resolveKiroModel } from './models.js';
import { buildKiroRequest } from './transform.js';

const DEFAULT_BASE = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';

export interface KiroProviderOptions {
  /** Bearer access token from a Kiro login (passed through as apiKey). */
  apiKey: string;
  baseUrl?: string;
  /** Optional CodeWhisperer profile ARN sent with each request. */
  profileArn?: string;
  /** Stable conversation id. Defaults to a random UUID per provider instance. */
  conversationId?: string;
  fetchImpl?: typeof fetch;
}

export class KiroProvider extends WireAdapter {
  override readonly id = 'kiro';
  override readonly capabilities: Capabilities = capabilitiesForFamily('anthropic', {
    promptCache: false,
    cacheControl: 'none',
    maxContext: 1_000_000,
  });

  private readonly profileArn?: string;
  private readonly conversationId: string;

  constructor(opts: KiroProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl);
    this.profileArn = opts.profileArn;
    this.conversationId = opts.conversationId ?? cryptoRandomUUID();
  }

  protected override buildUrl(_req: Request): string {
    return this.baseUrl;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    const mid = cryptoRandomUUID().replace(/-/g, '');
    const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
    return {
      'content-type': 'application/x-amz-json-1.0',
      accept: 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
      'x-amzn-codewhisperer-optout': 'true',
      'amz-sdk-invocation-id': cryptoRandomUUID(),
      'amz-sdk-request': 'attempt=1; max=1',
      'x-amzn-kiro-agent-mode': 'vibe',
      'x-amz-user-agent': ua,
      'user-agent': ua,
    };
  }

  protected override buildBody(req: Request): Record<string, unknown> {
    // Validate the model id up-front so an unknown model fails clearly.
    resolveKiroModel(req.model);
    return buildKiroRequest(req, this.conversationId, this.profileArn) as unknown as Record<string, unknown>;
  }

  protected override translateError(status: number, text: string): ProviderError {
    const retryable = status === 429 || status === 503 || (status >= 500 && status < 600);
    return new ProviderError(`Kiro API error: ${status} ${text}`.trim(), status, retryable, this.id, {
      body: { message: text || undefined, raw: text },
    });
  }

  protected override parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseKiroStream(body, fallbackModel);
  }
}

function cryptoRandomUUID(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function* iterateBody(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
): AsyncIterable<Uint8Array> {
  if (!body) return;
  const isNode =
    typeof (body as { pipe?: unknown }).pipe === 'function' &&
    typeof (body as { on?: unknown }).on === 'function';
  if (isNode) {
    for await (const chunk of body as NodeJS.ReadableStream) {
      yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    }
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Translate the Kiro Event Stream body into canonical StreamEvents.
 *
 * Tool-call args stream as `toolUse` (first chunk, carrying name+id) followed
 * by `toolUseInput` chunks and a terminating `stop`. We accumulate the raw
 * JSON string and emit canonical tool_use_start / _input_delta / _stop.
 */
async function* parseKiroStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  fallbackModel: string,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let textOpen = false;
  let stopReason: StopReason = 'end_turn';
  let usage: Usage = { input: 0, output: 0 };
  let emittedToolCalls = 0;
  let lastContent = '';
  let streamError: string | null = null;

  let cur: { id: string; name: string; input: string } | null = null;

  const ensureStarted = function* (): Generator<StreamEvent> {
    if (!started) {
      started = true;
      yield { type: 'message_start', model: fallbackModel };
    }
  };

  const flushTool = function* (): Generator<StreamEvent> {
    if (!cur) return;
    const input = parseToolInput(cur.input.trim() || '{}');
    yield { type: 'tool_use_stop', id: cur.id, input };
    emittedToolCalls++;
    cur = null;
  };

  for await (const chunk of iterateBody(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, remaining } = parseKiroEvents(buffer);
    buffer = remaining;

    for (const event of events) {
      switch (event.type) {
        case 'content': {
          if (event.data === lastContent) continue;
          lastContent = event.data;
          yield* ensureStarted();
          if (!textOpen) {
            textOpen = true;
          }
          yield { type: 'text_delta', text: event.data };
          break;
        }
        case 'toolUse': {
          yield* ensureStarted();
          if (!cur || cur.id !== event.data.toolUseId) {
            yield* flushTool();
            cur = { id: event.data.toolUseId, name: event.data.name, input: '' };
            yield { type: 'tool_use_start', id: cur.id, name: cur.name };
          }
          if (event.data.input) {
            cur.input += event.data.input;
            yield { type: 'tool_use_input_delta', id: cur.id, partial: event.data.input };
          }
          if (event.data.stop) yield* flushTool();
          break;
        }
        case 'toolUseInput': {
          if (cur && event.data.input) {
            cur.input += event.data.input;
            yield { type: 'tool_use_input_delta', id: cur.id, partial: event.data.input };
          }
          break;
        }
        case 'toolUseStop': {
          if (event.data.stop) yield* flushTool();
          break;
        }
        case 'contextUsage': {
          // Best-effort: cannot derive exact tokens without a context window;
          // leave usage.input to the explicit usage event when present.
          break;
        }
        case 'usage': {
          if (event.data.inputTokens !== undefined) usage = { ...usage, input: event.data.inputTokens };
          if (event.data.outputTokens !== undefined) usage = { ...usage, output: event.data.outputTokens };
          break;
        }
        case 'error': {
          streamError = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
          break;
        }
      }
      if (streamError) break;
    }
    if (streamError) break;
  }

  yield* flushTool();

  if (streamError) {
    throw new ProviderError(`Kiro API stream error: ${streamError}`, 0, true, 'kiro', {
      body: { message: streamError },
    });
  }

  yield* ensureStarted();
  stopReason = emittedToolCalls > 0 ? 'tool_use' : 'end_turn';
  yield { type: 'message_stop', stopReason, usage };
}
