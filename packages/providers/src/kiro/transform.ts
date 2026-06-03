/**
 * Translate a WrongStack `Request` into the Kiro (`GenerateAssistantResponse`)
 * conversation-state body.
 *
 * Kiro speaks a CodeWhisperer-flavoured history of `userInputMessage` /
 * `assistantResponseMessage` entries. WrongStack messages carry tool_use and
 * tool_result as content blocks; this module flattens them into Kiro's
 * `toolUses` (on assistant turns) and `userInputMessageContext.toolResults`
 * (on user turns).
 */

import type {
  ImageBlock,
  Message,
  Request,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/core';
import { resolveKiroModel } from './models.js';

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: 'success' | 'error';
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: 'KIRO_CLI';
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export interface KiroRequestBody {
  conversationState: {
    chatTriggerType: 'MANUAL';
    agentTaskType: 'vibe';
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
  agentMode: 'vibe';
}

export const TOOL_RESULT_LIMIT = 250_000;

/** Strip unpaired UTF-16 surrogates that break the AWS JSON encoder. */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

function blocksOf(m: Message): Exclude<Message['content'], string> | TextBlock[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

function imagesOf(m: Message): KiroImage[] {
  if (typeof m.content === 'string') return [];
  return m.content
    .filter((b): b is ImageBlock => b.type === 'image')
    .map((img) => ({
      format: (img.source.media_type?.split('/')[1] || 'png'),
      source: { bytes: img.source.data ?? img.source.url ?? '' },
    }));
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } },
    },
  }));
}

/**
 * Build the full Kiro request body from a canonical Request.
 *
 * The final message becomes `currentMessage`; everything before it becomes
 * `history`. The optional system prompt is prepended to the first user turn
 * (Kiro has no dedicated system field).
 */
export function buildKiroRequest(req: Request, conversationId: string, profileArn?: string): KiroRequestBody {
  const modelId = resolveKiroModel(req.model);
  const systemPrompt = (req.system ?? []).map((b) => b.text).join('\n');

  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;

  const prependSystem = (content: string): string => {
    if (systemPrompt && !systemPrepended) {
      systemPrepended = true;
      return `${systemPrompt}\n\n${content}`;
    }
    return content;
  };

  const pushUser = (content: string, images: KiroImage[], toolResults: KiroToolResult[]): void => {
    const last = history[history.length - 1]?.userInputMessage;
    const uimc =
      toolResults.length > 0 ? { userInputMessageContext: { toolResults } } : undefined;
    if (last && !uimc && !last.userInputMessageContext) {
      // Merge consecutive plain user turns to keep alternation natural.
      last.content += `\n\n${content}`;
      if (images.length > 0) last.images = [...(last.images ?? []), ...images];
      return;
    }
    history.push({
      userInputMessage: {
        content: sanitizeSurrogates(content),
        modelId,
        origin: 'KIRO_CLI',
        ...(images.length > 0 ? { images } : {}),
        ...(uimc ?? {}),
      },
    });
  };

  // Walk all but the last message into history.
  const head = req.messages.slice(0, -1);
  for (const msg of head) {
    const blocks = blocksOf(msg);
    if (msg.role === 'assistant') {
      let content = '';
      const toolUses: KiroToolUse[] = [];
      for (const b of blocks) {
        if (b.type === 'text') content += (b as TextBlock).text;
        else if (b.type === 'thinking')
          content = `<thinking>${(b as ThinkingBlock).thinking}</thinking>\n\n${content}`;
        else if (b.type === 'tool_use') {
          const tu = b as ToolUseBlock;
          toolUses.push({ name: tu.name, toolUseId: tu.id, input: tu.input ?? {} });
        }
      }
      if (!content && toolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: { content, ...(toolUses.length > 0 ? { toolUses } : {}) },
      });
    } else {
      // user / system: split into tool_result blocks vs plain content.
      const toolResults: KiroToolResult[] = [];
      let text = '';
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const tr = b as ToolResultBlock;
          toolResults.push({
            content: [{ text: truncate(tr.content ?? '', TOOL_RESULT_LIMIT) }],
            status: tr.is_error ? 'error' : 'success',
            toolUseId: tr.tool_use_id,
          });
        } else if (b.type === 'text') {
          text += (b as TextBlock).text;
        }
      }
      const content = prependSystem(text || (toolResults.length > 0 ? 'Tool results provided.' : ''));
      pushUser(content, imagesOf(msg), toolResults);
    }
  }

  // Final message → currentMessage. If it's an assistant turn (rare), fold it
  // into history and emit a neutral continuation prompt.
  const lastMsg = req.messages[req.messages.length - 1];
  let curContent = '';
  let curImages: KiroImage[] = [];
  const curToolResults: KiroToolResult[] = [];

  if (lastMsg) {
    const blocks = blocksOf(lastMsg);
    if (lastMsg.role === 'assistant') {
      let content = '';
      const toolUses: KiroToolUse[] = [];
      for (const b of blocks) {
        if (b.type === 'text') content += (b as TextBlock).text;
        else if (b.type === 'tool_use') {
          const tu = b as ToolUseBlock;
          toolUses.push({ name: tu.name, toolUseId: tu.id, input: tu.input ?? {} });
        }
      }
      if (content || toolUses.length > 0) {
        history.push({ assistantResponseMessage: { content, ...(toolUses.length > 0 ? { toolUses } : {}) } });
      }
      curContent = 'Please proceed with the task.';
    } else {
      let text = '';
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const tr = b as ToolResultBlock;
          curToolResults.push({
            content: [{ text: truncate(tr.content ?? '', TOOL_RESULT_LIMIT) }],
            status: tr.is_error ? 'error' : 'success',
            toolUseId: tr.tool_use_id,
          });
        } else if (b.type === 'text') {
          text += (b as TextBlock).text;
        }
      }
      curImages = imagesOf(lastMsg);
      curContent = prependSystem(text || (curToolResults.length > 0 ? 'Tool results provided.' : ''));
    }
  }

  const uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } = {};
  if (curToolResults.length > 0) uimc.toolResults = curToolResults;
  if (req.tools && req.tools.length > 0) uimc.tools = convertToolsToKiro(req.tools);

  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      agentTaskType: 'vibe',
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: sanitizeSurrogates(curContent),
          modelId,
          origin: 'KIRO_CLI',
          ...(curImages.length > 0 ? { images: curImages } : {}),
          ...(Object.keys(uimc).length > 0 ? { userInputMessageContext: uimc } : {}),
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    agentMode: 'vibe',
  };
}
