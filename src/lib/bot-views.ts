export const BOT_VIEWS_KEY = "openmausbot.botViews.v1";

export type BotViews = Record<string, "ui-interface">;

export function readBotViews(): BotViews {
  try {
    const raw = globalThis.localStorage?.getItem(BOT_VIEWS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: BotViews = {};
    for (const [botId, view] of Object.entries(parsed)) {
      if (botId && view === "ui-interface") result[botId] = "ui-interface";
    }
    return result;
  } catch {
    return {};
  }
}

export function rememberBotViews(views: BotViews): void {
  try {
    if (Object.keys(views).length === 0) {
      if (typeof globalThis.localStorage?.removeItem === "function") globalThis.localStorage.removeItem(BOT_VIEWS_KEY);
      else globalThis.localStorage?.setItem(BOT_VIEWS_KEY, "{}");
    } else {
      globalThis.localStorage?.setItem(BOT_VIEWS_KEY, JSON.stringify(views));
    }
  } catch {
  }
}

export function withRememberedBotViews<State extends { botViews: BotViews }>(state: State): State {
  const botViews = readBotViews();
  return Object.keys(botViews).length === 0 ? state : { ...state, botViews };
}
