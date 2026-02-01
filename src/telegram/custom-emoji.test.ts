import { describe, expect, it } from "vitest";
import { extractCustomEmojiEntities, expandCustomEmojisInText } from "./custom-emoji.js";

describe("extractCustomEmojiEntities", () => {
  it("returns empty array when entities is undefined", () => {
    expect(extractCustomEmojiEntities(undefined)).toEqual([]);
  });

  it("returns empty array when entities is empty", () => {
    expect(extractCustomEmojiEntities([])).toEqual([]);
  });

  it("returns empty array when no custom_emoji entities exist", () => {
    const entities = [
      { type: "mention", offset: 0, length: 5 },
      { type: "bold", offset: 6, length: 5 },
      { type: "text_link", offset: 12, length: 4, url: "https://example.com" },
    ];
    expect(extractCustomEmojiEntities(entities)).toEqual([]);
  });

  it("extracts custom_emoji entities", () => {
    const entities = [
      { type: "mention", offset: 0, length: 5 },
      { type: "custom_emoji", offset: 6, length: 2, custom_emoji_id: "emoji123" },
      { type: "bold", offset: 9, length: 5 },
      { type: "custom_emoji", offset: 15, length: 2, custom_emoji_id: "emoji456" },
    ];
    const result = extractCustomEmojiEntities(entities);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "custom_emoji",
      offset: 6,
      length: 2,
      custom_emoji_id: "emoji123",
    });
    expect(result[1]).toEqual({
      type: "custom_emoji",
      offset: 15,
      length: 2,
      custom_emoji_id: "emoji456",
    });
  });

  it("skips custom_emoji without custom_emoji_id", () => {
    const entities = [
      { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "valid123" },
      { type: "custom_emoji", offset: 3, length: 2 }, // missing custom_emoji_id
      { type: "custom_emoji", offset: 6, length: 2, custom_emoji_id: "" }, // empty string
    ];
    const result = extractCustomEmojiEntities(entities);
    expect(result).toHaveLength(1);
    expect(result[0].custom_emoji_id).toBe("valid123");
  });
});

describe("expandCustomEmojisInText", () => {
  it("returns text unchanged when entities is empty", () => {
    const resolved = new Map([["emoji123", { emoji: "😂", setName: "TestPack" }]]);
    expect(expandCustomEmojisInText("Hello world", [], resolved)).toBe("Hello world");
  });

  it("returns text unchanged when resolved map is empty", () => {
    const entities = [
      { type: "custom_emoji" as const, offset: 6, length: 1, custom_emoji_id: "emoji123" },
    ];
    expect(expandCustomEmojisInText("Hello X world", entities, new Map())).toBe("Hello X world");
  });

  it("expands a single custom emoji with set name", () => {
    const text = "Hello X world";
    const entities = [
      { type: "custom_emoji" as const, offset: 6, length: 1, custom_emoji_id: "emoji123" },
    ];
    const resolved = new Map([["emoji123", { emoji: "😂", setName: "FunnyPack" }]]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe("Hello [😂:FunnyPack] world");
  });

  it("expands a single custom emoji without set name", () => {
    const text = "Hello X world";
    const entities = [
      { type: "custom_emoji" as const, offset: 6, length: 1, custom_emoji_id: "emoji123" },
    ];
    const resolved = new Map([["emoji123", { emoji: "🎉" }]]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe("Hello [🎉] world");
  });

  it("expands multiple custom emojis", () => {
    const text = "A B C";
    const entities = [
      { type: "custom_emoji" as const, offset: 0, length: 1, custom_emoji_id: "e1" },
      { type: "custom_emoji" as const, offset: 2, length: 1, custom_emoji_id: "e2" },
      { type: "custom_emoji" as const, offset: 4, length: 1, custom_emoji_id: "e3" },
    ];
    const resolved = new Map([
      ["e1", { emoji: "🅰️", setName: "Letters" }],
      ["e2", { emoji: "🅱️", setName: "Letters" }],
      ["e3", { emoji: "©️" }],
    ]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe(
      "[🅰️:Letters] [🅱️:Letters] [©️]",
    );
  });

  it("handles adjacent custom emojis", () => {
    const text = "XY";
    const entities = [
      { type: "custom_emoji" as const, offset: 0, length: 1, custom_emoji_id: "e1" },
      { type: "custom_emoji" as const, offset: 1, length: 1, custom_emoji_id: "e2" },
    ];
    const resolved = new Map([
      ["e1", { emoji: "🔥" }],
      ["e2", { emoji: "💧" }],
    ]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe("[🔥][💧]");
  });

  it("skips unresolved custom emoji", () => {
    const text = "A B C";
    const entities = [
      { type: "custom_emoji" as const, offset: 0, length: 1, custom_emoji_id: "e1" },
      { type: "custom_emoji" as const, offset: 2, length: 1, custom_emoji_id: "unknown" },
      { type: "custom_emoji" as const, offset: 4, length: 1, custom_emoji_id: "e3" },
    ];
    const resolved = new Map([
      ["e1", { emoji: "🔴" }],
      ["e3", { emoji: "🔵" }],
    ]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe("[🔴] B [🔵]");
  });

  it("handles multi-byte emoji placeholder", () => {
    // Custom emoji in Telegram can occupy 2 bytes (surrogate pair)
    const text = "Hi 👋 there";
    const entities = [
      { type: "custom_emoji" as const, offset: 3, length: 2, custom_emoji_id: "wave" },
    ];
    const resolved = new Map([["wave", { emoji: "👋", setName: "Hands" }]]);

    expect(expandCustomEmojisInText(text, entities, resolved)).toBe("Hi [👋:Hands] there");
  });
});
