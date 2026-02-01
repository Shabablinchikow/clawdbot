import type { Bot } from "grammy";
import { logVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";

export interface CustomEmojiEntity {
  type: "custom_emoji";
  offset: number;
  length: number;
  custom_emoji_id: string;
}

export interface ResolvedCustomEmoji {
  id: string;
  emoji: string;
  setName?: string;
  filePath?: string;
  contentType?: string;
}

/**
 * Extract custom_emoji entities from message entities.
 */
export function extractCustomEmojiEntities(
  entities?: Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>,
): CustomEmojiEntity[] {
  if (!entities) {
    return [];
  }
  return entities.filter(
    (e): e is CustomEmojiEntity => e.type === "custom_emoji" && Boolean(e.custom_emoji_id),
  );
}

/**
 * Resolve custom emoji info by calling Telegram API.
 * Returns sticker info including emoji character and set name.
 */
export async function resolveCustomEmojis(
  bot: Bot,
  emojiIds: string[],
): Promise<Map<string, { emoji: string; setName?: string; fileId?: string }>> {
  if (emojiIds.length === 0) {
    return new Map();
  }

  try {
    const stickers = await bot.api.getCustomEmojiStickers(emojiIds);
    const result = new Map<string, { emoji: string; setName?: string; fileId?: string }>();

    for (const sticker of stickers) {
      if (sticker.custom_emoji_id) {
        result.set(sticker.custom_emoji_id, {
          emoji: sticker.emoji ?? "❓",
          setName: sticker.set_name,
          fileId: sticker.file_id,
        });
      }
    }

    return result;
  } catch (err) {
    // If API fails, return empty map - we'll fall back to placeholder text
    logVerbose(`Failed to resolve custom emojis: ${String(err)}`);
    return new Map();
  }
}

/**
 * Download custom emoji sticker files.
 */
export async function downloadCustomEmojiFiles(
  bot: Bot,
  token: string,
  emojiInfo: Map<string, { emoji: string; setName?: string; fileId?: string }>,
  maxBytes: number,
  proxyFetch?: typeof fetch,
): Promise<ResolvedCustomEmoji[]> {
  const results: ResolvedCustomEmoji[] = [];
  const fetchImpl = proxyFetch ?? globalThis.fetch;

  for (const [id, info] of emojiInfo) {
    if (!info.fileId) {
      results.push({ id, emoji: info.emoji, setName: info.setName });
      continue;
    }

    try {
      const file = await bot.api.getFile(info.fileId);
      if (!file.file_path) {
        results.push({ id, emoji: info.emoji, setName: info.setName });
        continue;
      }

      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.file_path,
      });
      const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", maxBytes);

      results.push({
        id,
        emoji: info.emoji,
        setName: info.setName,
        filePath: saved.path,
        contentType: saved.contentType,
      });
    } catch (err) {
      // If download fails, just include the emoji info without file
      logVerbose(`Failed to download custom emoji ${id}: ${String(err)}`);
      results.push({ id, emoji: info.emoji, setName: info.setName });
    }
  }

  return results;
}

/**
 * Expand custom emoji in text by replacing placeholders with descriptive text.
 * Returns the expanded text and list of resolved emojis.
 */
export function expandCustomEmojisInText(
  text: string,
  entities: CustomEmojiEntity[],
  resolved: Map<string, { emoji: string; setName?: string }>,
): string {
  if (entities.length === 0) {
    return text;
  }

  // Sort by offset descending to replace from end to start (preserves offsets)
  const sorted = [...entities].toSorted((a, b) => b.offset - a.offset);

  let result = text;
  for (const entity of sorted) {
    const info = resolved.get(entity.custom_emoji_id);
    if (!info) {
      continue;
    }

    // Replace the placeholder character with emoji + annotation
    const annotation = info.setName ? `[${info.emoji}:${info.setName}]` : `[${info.emoji}]`;
    result =
      result.slice(0, entity.offset) + annotation + result.slice(entity.offset + entity.length);
  }

  return result;
}

/**
 * Process custom emoji in a message: resolve, optionally download, and expand text.
 */
export async function processCustomEmojis(params: {
  text: string;
  entities?: Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }>;
  bot: Bot;
  token: string;
  maxBytes: number;
  downloadFiles?: boolean;
  proxyFetch?: typeof fetch;
}): Promise<{
  expandedText: string;
  customEmojis: ResolvedCustomEmoji[];
}> {
  const customEmojiEntities = extractCustomEmojiEntities(params.entities);
  if (customEmojiEntities.length === 0) {
    return { expandedText: params.text, customEmojis: [] };
  }

  const emojiIds = customEmojiEntities.map((e) => e.custom_emoji_id);
  const resolved = await resolveCustomEmojis(params.bot, emojiIds);

  const expandedText = expandCustomEmojisInText(params.text, customEmojiEntities, resolved);

  let customEmojis: ResolvedCustomEmoji[] = [];
  if (params.downloadFiles) {
    customEmojis = await downloadCustomEmojiFiles(
      params.bot,
      params.token,
      resolved,
      params.maxBytes,
      params.proxyFetch,
    );
  } else {
    // Just return resolved info without files
    for (const [id, info] of resolved) {
      customEmojis.push({ id, emoji: info.emoji, setName: info.setName });
    }
  }

  return { expandedText, customEmojis };
}
