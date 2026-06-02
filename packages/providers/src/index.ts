import type {
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
  ProviderFactory,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/core';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { KiroProvider } from './kiro/index.js';
import { getKiroCliToken } from './kiro/kiro-cli.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OpenAIProvider } from './openai.js';

export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export { OpenAIProvider, type OpenAIProviderOptions } from './openai.js';
export {
  OpenAICompatibleProvider,
  type OpenAICompatibleOptions,
  type CompatibilityQuirks,
} from './openai-compatible.js';
export { GoogleProvider, type GoogleProviderOptions } from './google.js';
export { KiroProvider, type KiroProviderOptions } from './kiro/index.js';
export { KIRO_MODELS, kiroModelsDev, resolveKiroModel } from './kiro/models.js';
export { WireAdapter } from './wire-adapter.js';
export {
  WireFormatProvider,
  defineWireFormat,
  createWireFormatFactory,
  type WireFormatConfig,
  type WireFactoryOptions,
} from './wire-format.js';
export { mistralWireFormat } from './presets/mistral.js';
export { anthropicWireFormat } from './presets/anthropic.js';
export { openaiWireFormat } from './presets/openai.js';
export { googleWireFormat } from './presets/google.js';
export { capabilitiesFor } from './capabilities.js';
export { capabilitiesForFamily, CAPABILITIES_BY_FAMILY } from './family-capabilities.js';
export { parseProviderHttpError } from './error-parse.js';
export { normalizeAnthropic, normalizeOpenAI } from './stop-reason.js';
export { toolsToAnthropic } from './tool-format/to-anthropic.js';
export { contentFromAnthropic } from './tool-format/from-anthropic.js';
export {
  toolsToOpenAI,
  messagesToOpenAI,
  type OpenAIMessage,
  type OpenAIToolCall,
  type ConvertOptions,
} from './tool-format/to-openai.js';
export { contentFromOpenAI, type OpenAIChoice } from './tool-format/from-openai.js';

export interface BuildFactoriesOptions {
  registry: ModelsRegistry;
  /** Used to log unsupported families during boot. */
  log?: Logger;
}

/**
 * Build one ProviderFactory per provider known to models.dev. The factory's
 * `create(cfg)` resolves the wire-family at construction time and returns the
 * matching transport. Unsupported families return a stub that throws when
 * complete() is called, so the system can still boot.
 */
export async function buildProviderFactoriesFromRegistry(
  opts: BuildFactoriesOptions,
): Promise<ProviderFactory[]> {
  const providers = await opts.registry.listProviders();
  const factories: ProviderFactory[] = [];
  const unsupported: ResolvedProvider[] = [];

  for (const p of providers) {
    if (p.family === 'unsupported') {
      unsupported.push(p);
      continue;
    }
    // kiro speaks the Q wire format, not Anthropic's HTTP API — it is in the
    // catalog (so it shows up in the picker) but must use the static kiro
    // factory below, not the generic anthropic transport.
    if (p.id === 'kiro') continue;
    factories.push({
      type: p.id,
      family: p.family,
      create: (cfg: ProviderConfig) => makeProvider(p, cfg),
    });
  }

  // Generic factories so users can hand-roll a provider not in models.dev.
  factories.push({
    type: 'openai-compatible',
    family: 'openai-compatible',
    create: (cfg) =>
      new OpenAICompatibleProvider({
        id: 'openai-compatible',
        apiKey: requireKey(cfg),
        baseUrl: cfg.baseUrl ?? '',
        headers: cfg.headers,
        quirks: cfg.quirks as ConstructorParameters<typeof OpenAICompatibleProvider>[0]['quirks'],
      }),
  });

  // Kiro (AWS CodeWhisperer / Amazon Q). Not in models.dev — registered
  // statically so users can select it after a Kiro login. The bearer token
  // is passed through as the apiKey.
  factories.push({
    type: 'kiro',
    // Kiro is Anthropic-family on the inside (Claude models dominate the
    // catalog) so the agent's tool-format routing treats it correctly.
    family: 'anthropic',
    create: (cfg) => makeKiroProvider(cfg),
  });

  if (unsupported.length > 0 && opts.log) {
    // Debug-only: the user already knows their plan; only surface when
    // troubleshooting why a specific provider isn't selectable.
    opts.log.info(
      `${unsupported.length} provider(s) need a plugin (unsupported wire family): ` +
        unsupported.map((p) => p.id).join(', '),
    );
  }

  return factories;
}

function makeProvider(p: ResolvedProvider, cfg: ProviderConfig): Provider {
  // Config overrides the catalog. This is the path that lets users wire
  // up internal proxies / self-hosted endpoints without needing models.dev.
  const family: WireFamily = cfg.family ?? p.family;
  const envVars = cfg.envVars && cfg.envVars.length > 0 ? cfg.envVars : p.envVars;
  const apiKey = cfg.apiKey ?? readFromEnv(envVars);
  if (!apiKey && family !== 'unsupported') {
    throw new Error(
      `Provider "${p.id}" requires an API key. Set ${
        envVars.join(' or ') || 'apiKey in config'
      } or run \`wstack auth ${p.id}\`.`,
    );
  }
  const baseUrl = cfg.baseUrl ?? p.apiBase;

  if (!family || family === 'unsupported') {
    if (family === 'unsupported') {
      throw new Error(
        `Provider "${p.id}" uses an unsupported wire family (${p.npm ?? 'unknown'}). ` +
          `Register a custom factory via a plugin to enable it.`,
      );
    }
    throw new Error(
      `Provider "${p.id}" has no wire family configured. ` +
        `Set an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") in config or the models.dev catalog.`,
    );
  }

  switch (family) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: apiKey!, baseUrl });
    case 'openai':
      return new OpenAIProvider({
        apiKey: apiKey!,
        baseUrl,
        id: p.id,
        quirks: cfg.quirks as ConstructorParameters<typeof OpenAIProvider>[0]['quirks'],
      });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        id: p.id,
        apiKey: apiKey!,
        baseUrl: baseUrl ?? '',
        headers: cfg.headers,
        quirks: cfg.quirks as ConstructorParameters<typeof OpenAICompatibleProvider>[0]['quirks'],
      });
    case 'google':
      return new GoogleProvider({ id: p.id, apiKey: apiKey!, baseUrl });
  }
}

/**
 * Build a Provider purely from config — no models.dev lookup at all.
 * Used for user-defined providers and offline operation.
 */
export function makeProviderFromConfig(id: string, cfg: ProviderConfig): Provider {
  if (id === 'kiro' || cfg.type === 'kiro') {
    return makeKiroProvider(cfg);
  }
  if (!cfg.family) {
    throw new Error(
      `Provider "${id}" needs an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") when not in the models.dev catalog.`,
    );
  }
  const synthetic: ResolvedProvider = {
    id,
    name: id,
    family: cfg.family,
    apiBase: cfg.baseUrl,
    envVars: cfg.envVars ?? [],
    models: (cfg.models ?? []).map((m) => ({ id: m, name: m })),
    npm: undefined,
  };
  return makeProvider(synthetic, cfg);
}

function readFromEnv(vars: string[]): string | undefined {
  for (const v of vars) {
    const val = process.env[v];
    if (val) return val;
  }
  return undefined;
}

function requireKey(cfg: ProviderConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  throw new Error('Provider config requires apiKey (or set the corresponding env var).');
}

function makeKiroProvider(cfg: ProviderConfig): Provider {
  const profileArn =
    typeof cfg.quirks?.profileArn === 'string' ? (cfg.quirks.profileArn as string) : undefined;

  // Prefer an explicit token (config or env); otherwise read it straight from
  // the local kiro-cli login so a logged-in user needs no extra setup.
  const explicit = cfg.apiKey ?? readFromEnv(cfg.envVars ?? ['KIRO_ACCESS_TOKEN']);
  if (explicit) {
    return new KiroProvider({ apiKey: explicit, baseUrl: cfg.baseUrl, profileArn });
  }
  const cli = getKiroCliToken();
  if (cli) {
    return new KiroProvider({
      apiKey: cli.accessToken,
      baseUrl: cfg.baseUrl ?? `https://q.${cli.region}.amazonaws.com/generateAssistantResponse`,
      profileArn: profileArn ?? cli.profileArn,
    });
  }
  throw new Error(
    'Provider "kiro" requires a bearer access token. Log in with `kiro-cli`, set KIRO_ACCESS_TOKEN, or set apiKey in config.',
  );
}
