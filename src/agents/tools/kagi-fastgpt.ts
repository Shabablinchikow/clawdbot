import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readBoolParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const KAGI_FASTGPT_ENDPOINT = "https://kagi.com/api/v0/fastgpt";
const DEFAULT_TIMEOUT_SECONDS = 30;

const FASTGPT_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const KagiFastGPTSchema = Type.Object({
  query: Type.String({ description: "Question or query to answer using AI with web search." }),
  cache: Type.Optional(
    Type.Boolean({
      description: "Allow cached responses (default: true).",
    }),
  ),
});

type FastGPTConfig = NonNullable<NonNullable<ClawdbotConfig["tools"]>["web"]>["fastgpt"];

type KagiFastGPTReference = {
  title?: string;
  snippet?: string;
  url?: string;
};

type KagiFastGPTResponse = {
  meta?: {
    id?: string;
    node?: string;
    ms?: number;
    api_balance?: number;
  };
  data?: {
    output?: string;
    tokens?: number;
    references?: KagiFastGPTReference[];
  };
  error?: { code?: number; msg?: string };
};

function resolveFastGPTConfig(cfg?: ClawdbotConfig): FastGPTConfig {
  return cfg?.tools?.web?.fastgpt;
}

function resolveFastGPTEnabled(config?: FastGPTConfig): boolean {
  if (typeof config?.enabled === "boolean") return config.enabled;
  return true;
}

function resolveKagiApiKey(config?: FastGPTConfig): string | undefined {
  const fromConfig = config?.apiKey?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.KAGI_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

function resolveTimeoutSeconds(config?: FastGPTConfig): number {
  const val = config?.timeoutSeconds;
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  return DEFAULT_TIMEOUT_SECONDS;
}

function resolveCacheTtlMs(config?: FastGPTConfig): number {
  const minutes = config?.cacheTtlMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0) {
    return minutes * 60 * 1000;
  }
  return DEFAULT_CACHE_TTL_MINUTES * 60 * 1000;
}

function resolveDefaultCache(config?: FastGPTConfig): boolean {
  if (typeof config?.cache === "boolean") return config.cache;
  return true;
}

async function runFastGPT(params: {
  query: string;
  apiKey: string;
  cache: boolean;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`kagi-fastgpt:${params.query}:${params.cache}`);

  if (params.cache) {
    const cached = readCache(FASTGPT_CACHE, cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const start = Date.now();

  const res = await fetch(KAGI_FASTGPT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bot ${params.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: params.query,
      cache: params.cache,
      web_search: true,
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Kagi FastGPT API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as KagiFastGPTResponse;

  if (data.error) {
    throw new Error(`Kagi FastGPT API error: ${data.error.msg || "Unknown error"}`);
  }

  const references = (data.data?.references ?? []).map((ref) => ({
    title: ref.title ?? "",
    url: ref.url ?? "",
    snippet: ref.snippet ?? "",
  }));

  const payload = {
    query: params.query,
    provider: "kagi-fastgpt",
    tookMs: Date.now() - start,
    answer: data.data?.output ?? "",
    tokens: data.data?.tokens,
    references,
    apiBalance: data.meta?.api_balance,
  };

  if (params.cache) {
    writeCache(FASTGPT_CACHE, cacheKey, payload, params.cacheTtlMs);
  }

  return payload;
}

export function createKagiFastGPTTool(options?: {
  config?: ClawdbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const config = resolveFastGPTConfig(options?.config);
  if (!resolveFastGPTEnabled(config)) return null;

  const apiKey = resolveKagiApiKey(config);
  if (!apiKey && !options?.sandboxed) return null;

  return {
    label: "Kagi FastGPT",
    name: "kagi_fastgpt",
    description:
      "Answer questions using Kagi FastGPT - an AI that searches the web and provides synthesized answers with references. Best for factual questions requiring up-to-date information. Returns an answer with source citations.",
    parameters: KagiFastGPTSchema,
    execute: async (_toolCallId, args) => {
      const resolvedApiKey = resolveKagiApiKey(config);
      if (!resolvedApiKey) {
        return jsonResult({
          error: "missing_kagi_api_key",
          message:
            "kagi_fastgpt needs an API key. Set KAGI_API_KEY in the Gateway environment, or configure tools.web.fastgpt.apiKey.",
          docs: "https://help.kagi.com/kagi/api/fastgpt.html",
        });
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const cache = readBoolParam(params, "cache") ?? resolveDefaultCache(config);

      const result = await runFastGPT({
        query,
        apiKey: resolvedApiKey,
        cache,
        timeoutSeconds: resolveTimeoutSeconds(config),
        cacheTtlMs: resolveCacheTtlMs(config),
      });

      return jsonResult(result);
    },
  };
}
