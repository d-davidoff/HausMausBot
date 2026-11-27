import { afterEach, describe, expect, it, vi } from "vitest";

import { BOT_VIEWS_KEY, readBotViews, rememberBotViews, withRememberedBotViews } from "./bot-views";

const surface = (initial: Record<string, string> = {}) => {
  const stored = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    stored,
  };
};

describe("bot views", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads an empty map when nothing is stored or stored JSON is corrupt", () => {
    vi.stubGlobal("localStorage", surface());
    expect(readBotViews()).toEqual({});
    vi.stubGlobal("localStorage", surface({ [BOT_VIEWS_KEY]: "{not-json" }));
    expect(readBotViews()).toEqual({});
    vi.stubGlobal("localStorage", surface({ [BOT_VIEWS_KEY]: JSON.stringify(["a"]) }));
    expect(readBotViews()).toEqual({});
    vi.stubGlobal("localStorage", surface({ [BOT_VIEWS_KEY]: JSON.stringify({ a: "ui-interface", b: "chat", "": "ui-interface" }) }));
    expect(readBotViews()).toEqual({ a: "ui-interface" });
  });

  it("round-trips and clears storage when empty", () => {
    const store = surface();
    vi.stubGlobal("localStorage", store);
    rememberBotViews({ "bot-1": "ui-interface" });
    expect(readBotViews()).toEqual({ "bot-1": "ui-interface" });
    expect(withRememberedBotViews({ botViews: {} }).botViews).toEqual({ "bot-1": "ui-interface" });
    rememberBotViews({});
    expect(store.stored.has(BOT_VIEWS_KEY)).toBe(false);
    expect(readBotViews()).toEqual({});
  });

  it("tolerates throwing storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(readBotViews()).toEqual({});
    expect(() => rememberBotViews({ "bot-1": "ui-interface" })).not.toThrow();
    expect(() => rememberBotViews({})).not.toThrow();
  });
});
