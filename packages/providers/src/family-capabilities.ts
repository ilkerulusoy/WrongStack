import type { Capabilities, WireFamily } from '@wrongstack/core';

export const CAPABILITIES_BY_FAMILY: Record<WireFamily, Capabilities> = {
  anthropic: {
    tools: true,
    parallelTools: true,
    vision: true,
    streaming: true,
    promptCache: true,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 200_000,
    cacheControl: 'native',
  },
  openai: {
    tools: true,
    parallelTools: true,
    vision: true,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: true,
    maxContext: 128_000,
    cacheControl: 'auto',
  },
  'openai-compatible': {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 32_000,
    cacheControl: 'none',
  },
  google: {
    tools: true,
    parallelTools: true,
    vision: true,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: true,
    maxContext: 1_000_000,
    cacheControl: 'none',
  },
  kiro: {
    tools: true,
    parallelTools: true,
    vision: true,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 1_000_000,
    cacheControl: 'none',
  },
  unsupported: {
    tools: false,
    parallelTools: false,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: false,
    jsonMode: false,
    maxContext: 0,
    cacheControl: 'none',
  },
};

export function capabilitiesForFamily(
  family: WireFamily,
  overrides: Partial<Capabilities> = {},
): Capabilities {
  return {
    ...(CAPABILITIES_BY_FAMILY[family] ?? CAPABILITIES_BY_FAMILY.unsupported),
    ...overrides,
  };
}
