import { createHash } from "node:crypto";

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

const KAGI_SUMMARIZE_ENDPOINT = "https://kagi.com/api/v0/summarize";
const DEFAULT_TIMEOUT_SECONDS = 60;

const SUMMARIZE_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const SUMMARIZER_ENGINES = ["cecil", "agnes", "muriel"] as const;
const SUMMARY_TYPES = ["summary", "takeaway"] as const;

// ISO language codes supported by Kagi Summarizer
const TARGET_LANGUAGES = [
  "BG",
  "CS",
  "DA",
  "DE",
  "EL",
  "EN",
  "ES",
  "ET",
  "FI",
  "FR",
  "HU",
  "ID",
  "IT",
  "JA",
  "KO",
  "LT",
  "LV",
  "NB",
  "NL",
  "PL",
  "PT",
  "RO",
  "RU",
  "SK",
  "SL",
  "SV",
  "TR",
  "UK",
  "ZH",
  "ZH-HANT",
] as const;

const KagiSummarizeSchema = Type.Object({
  url: Type.Optional(
    Type.String({
      description:
        "URL to summarize. Supports web pages, PDFs, Word docs, PowerPoint, audio files, and YouTube videos. Exclusive with 'text'.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description: "Text content to summarize. Exclusive with 'url'. Use POST for large texts.",
    }),
  ),
  engine: Type.Optional(
    Type.String({
      description:
        "Summarization engine: 'cecil' (fast, friendly), 'agnes' (formal, analytical), 'muriel' (enterprise-grade, best quality). Default: cecil.",
    }),
  ),
  summary_type: Type.Optional(
    Type.String({
      description:
        "Output format: 'summary' (prose paragraphs) or 'takeaway' (bullet points). Default: summary.",
    }),
  ),
  target_language: Type.Optional(
    Type.String({
      description:
        "Target language code for translation (e.g., 'EN', 'ES', 'RU', 'JA', 'ZH'). If not specified, output may match source language.",
    }),
  ),
  cache: Type.Optional(
    Type.Boolean({
      description: "Allow cached responses (default: true). Set false for sensitive documents.",
    }),
  ),
});

type SummarizerConfig = NonNullable<NonNullable<ClawdbotConfig["tools"]>["web"]>["summarizer"];

type KagiSummarizeResponse = {
  meta?: {
    id?: string;
    node?: string;
    ms?: number;
    api_balance?: number;
  };
  data?: {
    output?: string;
    tokens?: number;
  };
  error?: { code?: number; msg?: string };
};

function resolveSummarizerConfig(cfg?: ClawdbotConfig): SummarizerConfig {
  return cfg?.tools?.web?.summarizer;
}

function resolveSummarizerEnabled(config?: SummarizerConfig): boolean {
  if (typeof config?.enabled === "boolean") return config.enabled;
  return true;
}

function resolveKagiApiKey(config?: SummarizerConfig): string | undefined {
  const fromConfig = config?.apiKey?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.KAGI_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

function resolveTimeoutSeconds(config?: SummarizerConfig): number {
  const val = config?.timeoutSeconds;
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  return DEFAULT_TIMEOUT_SECONDS;
}

function resolveCacheTtlMs(config?: SummarizerConfig): number {
  const minutes = config?.cacheTtlMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0) {
    return minutes * 60 * 1000;
  }
  return DEFAULT_CACHE_TTL_MINUTES * 60 * 1000;
}

function resolveDefaultCache(config?: SummarizerConfig): boolean {
  if (typeof config?.cache === "boolean") return config.cache;
  return true;
}

function resolveDefaultEngine(config?: SummarizerConfig): (typeof SUMMARIZER_ENGINES)[number] {
  const engine = config?.engine;
  if (engine && SUMMARIZER_ENGINES.includes(engine as (typeof SUMMARIZER_ENGINES)[number])) {
    return engine as (typeof SUMMARIZER_ENGINES)[number];
  }
  return "cecil";
}

function resolveDefaultSummaryType(config?: SummarizerConfig): (typeof SUMMARY_TYPES)[number] {
  const summaryType = config?.summaryType;
  if (summaryType && SUMMARY_TYPES.includes(summaryType as (typeof SUMMARY_TYPES)[number])) {
    return summaryType as (typeof SUMMARY_TYPES)[number];
  }
  return "summary";
}

function resolveDefaultTargetLanguage(config?: SummarizerConfig): string | undefined {
  const lang = config?.targetLanguage?.trim().toUpperCase();
  if (lang && TARGET_LANGUAGES.includes(lang as (typeof TARGET_LANGUAGES)[number])) {
    return lang;
  }
  return undefined;
}

function validateEngine(
  engine: string | undefined,
): (typeof SUMMARIZER_ENGINES)[number] | undefined {
  if (!engine) return undefined;
  const normalized = engine.trim().toLowerCase();
  if (SUMMARIZER_ENGINES.includes(normalized as (typeof SUMMARIZER_ENGINES)[number])) {
    return normalized as (typeof SUMMARIZER_ENGINES)[number];
  }
  return undefined;
}

function validateSummaryType(
  summaryType: string | undefined,
): (typeof SUMMARY_TYPES)[number] | undefined {
  if (!summaryType) return undefined;
  const normalized = summaryType.trim().toLowerCase();
  if (SUMMARY_TYPES.includes(normalized as (typeof SUMMARY_TYPES)[number])) {
    return normalized as (typeof SUMMARY_TYPES)[number];
  }
  return undefined;
}

function validateTargetLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const normalized = lang.trim().toUpperCase();
  if (TARGET_LANGUAGES.includes(normalized as (typeof TARGET_LANGUAGES)[number])) {
    return normalized;
  }
  // Allow ZH-HANT variant
  if (normalized === "ZH-HANT" || normalized === "ZHHANT") return "ZH-HANT";
  return undefined;
}

async function runSummarize(params: {
  url?: string;
  text?: string;
  engine: string;
  summaryType: string;
  targetLanguage?: string;
  apiKey: string;
  cache: boolean;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  // Use hash for text input to avoid cache collisions from truncation
  const sourceKey = params.url
    ? params.url
    : createHash("sha256")
        .update(params.text || "")
        .digest("hex")
        .slice(0, 16);
  const cacheKey = normalizeCacheKey(
    `kagi-summarize:${sourceKey}:${params.engine}:${params.summaryType}:${params.targetLanguage || "auto"}:${params.cache}`,
  );

  if (params.cache) {
    const cached = readCache(SUMMARIZE_CACHE, cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const start = Date.now();

  // Build request body
  const body: Record<string, unknown> = {
    engine: params.engine,
    summary_type: params.summaryType,
    cache: params.cache,
  };

  if (params.url) {
    body.url = params.url;
  } else if (params.text) {
    body.text = params.text;
  }

  if (params.targetLanguage) {
    body.target_language = params.targetLanguage;
  }

  const res = await fetch(KAGI_SUMMARIZE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bot ${params.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Kagi Summarizer API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as KagiSummarizeResponse;

  if (data.error) {
    throw new Error(`Kagi Summarizer API error: ${data.error.msg || "Unknown error"}`);
  }

  const payload = {
    provider: "kagi-summarizer",
    source: params.url || "(text input)",
    engine: params.engine,
    summaryType: params.summaryType,
    targetLanguage: params.targetLanguage || "auto",
    tookMs: Date.now() - start,
    summary: data.data?.output ?? "",
    tokens: data.data?.tokens,
    apiBalance: data.meta?.api_balance,
  };

  if (params.cache) {
    writeCache(SUMMARIZE_CACHE, cacheKey, payload, params.cacheTtlMs);
  }

  return payload;
}

export function createKagiSummarizeTool(options?: {
  config?: ClawdbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const config = resolveSummarizerConfig(options?.config);
  if (!resolveSummarizerEnabled(config)) return null;

  const apiKey = resolveKagiApiKey(config);
  if (!apiKey && !options?.sandboxed) return null;

  return {
    label: "Kagi Summarizer",
    name: "kagi_summarize",
    description:
      "Summarize content using Kagi Universal Summarizer. Supports web pages, PDFs, Word/PowerPoint docs, audio files, YouTube videos, and plain text. Choose between prose summary or bullet-point takeaways. Can translate summaries to 30+ languages.",
    parameters: KagiSummarizeSchema,
    execute: async (_toolCallId, args) => {
      const resolvedApiKey = resolveKagiApiKey(config);
      if (!resolvedApiKey) {
        return jsonResult({
          error: "missing_kagi_api_key",
          message:
            "kagi_summarize needs an API key. Set KAGI_API_KEY in the Gateway environment, or configure tools.web.summarizer.apiKey.",
          docs: "https://help.kagi.com/kagi/api/summarizer.html",
        });
      }

      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url");
      const text = readStringParam(params, "text");

      if (!url && !text) {
        return jsonResult({
          error: "missing_input",
          message: "Either 'url' or 'text' parameter is required.",
          docs: "https://help.kagi.com/kagi/api/summarizer.html",
        });
      }

      if (url && text) {
        return jsonResult({
          error: "conflicting_input",
          message: "Parameters 'url' and 'text' are mutually exclusive. Provide only one.",
          docs: "https://help.kagi.com/kagi/api/summarizer.html",
        });
      }

      const rawEngine = readStringParam(params, "engine");
      const engine = validateEngine(rawEngine) ?? resolveDefaultEngine(config);

      const rawSummaryType = readStringParam(params, "summary_type");
      const summaryType = validateSummaryType(rawSummaryType) ?? resolveDefaultSummaryType(config);

      const rawTargetLanguage = readStringParam(params, "target_language");
      const targetLanguage =
        validateTargetLanguage(rawTargetLanguage) ?? resolveDefaultTargetLanguage(config);

      const cache = readBoolParam(params, "cache") ?? resolveDefaultCache(config);

      const result = await runSummarize({
        url,
        text,
        engine,
        summaryType,
        targetLanguage,
        apiKey: resolvedApiKey,
        cache,
        timeoutSeconds: resolveTimeoutSeconds(config),
        cacheTtlMs: resolveCacheTtlMs(config),
      });

      return jsonResult(result);
    },
  };
}
