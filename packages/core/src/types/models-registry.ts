/**
 * Mirror of the models.dev/api.json schema. Top-level is keyed by provider id.
 * We keep `unknown` for fields we don't read so the cached payload stays faithful.
 */

export interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    [k: string]: number | undefined;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  [k: string]: unknown;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  /** Env vars that hold the API key, in priority order. */
  env?: string[];
  /** Identifies the wire format family (e.g. @ai-sdk/anthropic). */
  npm?: string;
  /** Default base URL when not provided by SDK defaults. */
  api?: string;
  /** Documentation URL. */
  doc?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevPayload = Record<string, ModelsDevProvider>;

/**
 * Canonical wire-format families WrongStack knows how to speak natively.
 * Used by the provider registry to pick a transport.
 */
export type WireFamily =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'google'
  | 'kiro'
  | 'unsupported';

export interface ResolvedProvider {
  id: string;
  name: string;
  family: WireFamily;
  apiBase?: string;
  envVars: string[];
  doc?: string;
  models: ModelsDevModel[];
  npm?: string;
}

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    maxContext: number;
    maxOutput?: number;
    knowledge?: string;
  };
  cost?: ModelsDevModel['cost'];
}

export interface ModelsRegistry {
  /** Load (from cache or network). Idempotent; second call returns cached value. */
  load(opts?: { force?: boolean }): Promise<ModelsDevPayload>;
  /** Force-refresh from network and overwrite cache. */
  refresh(): Promise<ModelsDevPayload>;
  /** All providers, classified by wire family. */
  listProviders(): Promise<ResolvedProvider[]>;
  /** A single provider by id, or undefined. */
  getProvider(id: string): Promise<ResolvedProvider | undefined>;
  /** A model lookup with capabilities + cost. */
  getModel(providerId: string, modelId: string): Promise<ResolvedModel | undefined>;
  /** Suggest a default model for the given provider (latest by release_date). */
  suggestModel(providerId: string): Promise<string | undefined>;
  /** Cache freshness in seconds since last successful network fetch (Infinity if never). */
  ageSeconds(): Promise<number>;
}
