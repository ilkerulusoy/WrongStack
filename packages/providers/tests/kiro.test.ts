import type { Request } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { KiroProvider } from '../src/kiro/index.js';
import { parseKiroEvents } from '../src/kiro/event-parser.js';
import { resolveKiroModel, KIRO_MODELS, kiroModelsDev } from '../src/kiro/models.js';
import { buildKiroRequest } from '../src/kiro/transform.js';

/** Build a fetch impl that streams the given chunks back as the response body. */
function streamingFetch(chunks: string[], status = 200) {
  return vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => chunks.join(''),
      body,
    };
  }) as unknown as typeof fetch;
}

const sig = () => new AbortController().signal;

describe('kiro models', () => {
  it('resolves dash version ids to dot form', () => {
    expect(resolveKiroModel('claude-opus-4-6')).toBe('claude-opus-4.6');
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4');
    expect(resolveKiroModel('auto')).toBe('auto');
  });

  it('throws on unknown model id', () => {
    expect(() => resolveKiroModel('gpt-4o')).toThrow(/Unknown Kiro model/);
  });

  it('exposes a non-empty catalog in models.dev shape', () => {
    expect(KIRO_MODELS.length).toBeGreaterThan(0);
    const dev = kiroModelsDev();
    expect(dev['claude-opus-4-6']).toMatchObject({ tool_call: true });
    expect(dev['claude-opus-4-6'].limit).toMatchObject({ context: 1_000_000 });
  });
});

describe('kiro event-parser', () => {
  it('extracts content and usage events from a buffer', () => {
    const buf = '{"content":"Hello"}{"content":" world"}{"usage":{"inputTokens":3,"outputTokens":5}}';
    const { events, remaining } = parseKiroEvents(buf);
    expect(remaining).toBe('');
    expect(events).toEqual([
      { type: 'content', data: 'Hello' },
      { type: 'content', data: ' world' },
      { type: 'usage', data: { inputTokens: 3, outputTokens: 5 } },
    ]);
  });

  it('preserves an incomplete trailing object as remaining', () => {
    const buf = '{"content":"ok"}{"content":"partial';
    const { events, remaining } = parseKiroEvents(buf);
    expect(events).toEqual([{ type: 'content', data: 'ok' }]);
    expect(remaining).toBe('{"content":"partial');
  });

  it('parses tool-use events', () => {
    const buf = '{"name":"read","toolUseId":"t1","input":""}{"input":"{\\"path\\":\\"a\\"}"}{"stop":true}';
    const { events } = parseKiroEvents(buf);
    expect(events[0]).toEqual({ type: 'toolUse', data: { name: 'read', toolUseId: 't1', input: '', stop: undefined } });
    expect(events[1]).toEqual({ type: 'toolUseInput', data: { input: '{"path":"a"}' } });
    expect(events[2]).toEqual({ type: 'toolUseStop', data: { stop: true } });
  });
});

describe('kiro transform', () => {
  it('prepends system prompt to the current user message and sets agentMode', () => {
    const req: Request = {
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'be terse' }],
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    };
    const body = buildKiroRequest(req, 'conv-1');
    expect(body.agentMode).toBe('vibe');
    expect(body.conversationState.conversationId).toBe('conv-1');
    const cur = body.conversationState.currentMessage.userInputMessage;
    expect(cur.content).toBe('be terse\n\nhi');
    expect(cur.modelId).toBe('claude-sonnet-4.6');
    expect(cur.origin).toBe('KIRO_CLI');
  });

  it('maps tool_use blocks to history toolUses and tool_result blocks to current toolResults', () => {
    const req: Request = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tc1', name: 'glob', input: { pattern: '*' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'a.ts\nb.ts' }],
        },
      ],
      tools: [
        { name: 'glob', description: 'glob', inputSchema: { type: 'object' }, permission: 'auto', mutating: false },
      ],
      maxTokens: 10,
    };
    const body = buildKiroRequest(req, 'c');
    const hist = body.conversationState.history!;
    const arm = hist.find((h) => h.assistantResponseMessage)?.assistantResponseMessage;
    expect(arm?.toolUses).toEqual([{ name: 'glob', toolUseId: 'tc1', input: { pattern: '*' } }]);
    const cur = body.conversationState.currentMessage.userInputMessage;
    expect(cur.userInputMessageContext?.toolResults).toEqual([
      { content: [{ text: 'a.ts\nb.ts' }], status: 'success', toolUseId: 'tc1' },
    ]);
    expect(cur.userInputMessageContext?.tools?.[0]?.toolSpecification.name).toBe('glob');
  });
});

describe('KiroProvider', () => {
  it('requires an apiKey', () => {
    expect(() => new KiroProvider({ apiKey: '' })).toThrow(/apiKey required/);
  });

  it('sends the Kiro wire headers and bearer token', async () => {
    let captured: { url?: string; init?: { headers?: Record<string, string>; body?: string } } = {};
    const fetchImpl = vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      captured = { url: String(url), init };
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"content":"ok"}'));
          c.close();
        },
      });
      return { ok: true, status: 200, text: async () => '', body };
    }) as unknown as typeof fetch;

    const p = new KiroProvider({ apiKey: 'tok-123', fetchImpl });
    await p.complete(
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: sig() },
    );
    expect(captured.url).toContain('generateAssistantResponse');
    expect(captured.init?.headers?.['authorization']).toBe('Bearer tok-123');
    expect(captured.init?.headers?.['x-amz-target']).toBe(
      'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    );
    const sentBody = JSON.parse(captured.init?.body ?? '{}');
    expect(sentBody.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.6');
  });

  it('aggregates a text response', async () => {
    const fetchImpl = streamingFetch(['{"content":"Hello"}', '{"content":" there"}', '{"usage":{"outputTokens":2}}']);
    const p = new KiroProvider({ apiKey: 'k', fetchImpl });
    const res = await p.complete(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      { signal: sig() },
    );
    expect(res.content).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.output).toBe(2);
  });

  it('parses a streamed tool call into a tool_use block', async () => {
    const fetchImpl = streamingFetch([
      '{"name":"read","toolUseId":"t9","input":""}',
      '{"input":"{\\"path\\":\\"x.ts\\"}"}',
      '{"stop":true}',
    ]);
    const p = new KiroProvider({ apiKey: 'k', fetchImpl });
    const res = await p.complete(
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'read x' }], maxTokens: 1 },
      { signal: sig() },
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'tool_use', id: 't9', name: 'read', input: { path: 'x.ts' } }]);
  });

  it('throws ProviderError on non-2xx', async () => {
    const fetchImpl = streamingFetch(['{"message":"forbidden"}'], 403);
    const p = new KiroProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'auto', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: sig() },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('surfaces a mid-stream error event', async () => {
    const fetchImpl = streamingFetch(['{"error":"ThrottlingException","message":"slow down"}']);
    const p = new KiroProvider({ apiKey: 'k', fetchImpl });
    await expect(
      p.complete(
        { model: 'auto', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
        { signal: sig() },
      ),
    ).rejects.toThrow(/ThrottlingException: slow down/);
  });
});
