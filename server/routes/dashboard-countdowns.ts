import { createHash } from "node:crypto";
import { berlinDay, getCountdownWindowDays, toCountdowns, type CountdownSnapshot } from "../../shared/dashboard-countdowns.ts";
import type { DashboardCalendarChoice } from "../../shared/dashboard-calendar.ts";
import type { CalendarPreferencesStore } from "../dashboard/calendar-preferences.ts";
import { DashboardCalendarStageError } from "../dashboard/calendar-service.ts";
import { addAgendaDays, berlinMidnight } from "../dashboard/calendar-time.ts";
import { SourceError } from "../connected-reads.ts";
import type { CalendarInput } from "../dashboard/agenda.ts";
import { PASS, type RouteHandler } from "./table.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHUNK_MS = 90 * DAY_MS;
const SNAPSHOT_CACHE_TTL_MS = 60_000;

function preferenceUserId(auth: Parameters<RouteHandler>[0]["auth"]): string | null {
  if (auth.kind === "loopback") return "local-owner";
  const { session } = auth;
  if (session.userId && session.membershipAuthority !== "portal") return `user:${session.userId}`;
  const email = session.email?.trim().toLowerCase();
  if (email) return `email:${createHash("sha256").update(email).digest("hex")}`;
  return session.membershipAuthority ? null : "local-owner";
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/invalid[_ ]grant|unauthori[sz]ed|unauthenticated|expired|401|reconnect/.test(message)) return "reconnect_required";
  if (/403|forbidden|permission|access denied|insufficient scope/.test(message)) return "calendar_access_denied";
  if (/404|not found|requested entity/.test(message)) return "calendar_not_found";
  if (/shortened|too large|size limit/.test(message)) return "response_too_large";
  if (error instanceof SourceError && error.severalAccounts) return "account_selection_required";
  return "provider_read_failed";
}

export function createDashboardCountdownsRoute(deps: {
  calendars(): Promise<{ accountId: string; calendars: DashboardCalendarChoice[] }>;
  events(calendarIds: readonly string[], from: number, to: number): Promise<CalendarInput[]>;
  preferences: CalendarPreferencesStore;
  now?: () => Date;
}): RouteHandler {
  const getNow = deps.now ?? (() => new Date());
  const snapshotCache = new Map<string, { at: number; snapshot: CountdownSnapshot }>();
  const inFlightReads = new Map<string, Promise<CountdownSnapshot>>();

  return async ({ res, path, method, json, url, auth }) => {
    if ((path !== "/api/dashboard/countdowns" && path !== "/api/countdowns") || method !== "GET") return PASS;
    res.setHeader("cache-control", "no-store");

    const userId = preferenceUserId(auth);
    if (!userId) return json(res, 403, { error: "A stable account identity is required for calendar preferences" });
    if (auth.kind === "session" && !auth.scopes.includes("client") && !auth.scopes.includes("admin")) {
      return json(res, 403, { error: "Client access required" });
    }

    let context: Awaited<ReturnType<typeof deps.calendars>>;
    try {
      context = await deps.calendars();
    } catch (error) {
      return json(res, 503, {
        error: "Google Calendar connection is unavailable",
        stage: "calendar_validation",
        code: failureCode(error),
      });
    }

    const availableById = new Map(context.calendars.map((cal) => [cal.id, cal]));
    const requestedIds = [...new Set(url.searchParams.getAll("calendarId"))];

    let targetCalendarIds: string[];
    if (requestedIds.length > 0) {
      if (requestedIds.length > 50 || requestedIds.some((id) => !id.trim() || id.length > 512)) {
        return json(res, 400, { error: "Invalid calendar selection" });
      }
      if (requestedIds.some((id) => !availableById.has(id))) {
        return json(res, 404, { error: "A selected calendar is no longer available" });
      }
      targetCalendarIds = requestedIds;
    } else {
      const storedIds = deps.preferences.selected(userId, context.accountId);
      const activeStoredIds = storedIds.filter((id) => availableById.has(id));
      const envIds = (process.env.GOOGLE_CALENDAR_IDS ?? process.env.COUNTDOWN_CALENDAR_IDS ?? "")
        .split(";")
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && availableById.has(id));

      if (activeStoredIds.length > 0) {
        targetCalendarIds = activeStoredIds;
      } else if (envIds.length > 0) {
        targetCalendarIds = envIds;
      } else {
        const primary = context.calendars.find((cal) => cal.primary) ?? context.calendars[0];
        targetCalendarIds = primary ? [primary.id] : [];
      }
    }

    const now = getNow();
    const rawWindow = url.searchParams.get("windowDays") ?? process.env.COUNTDOWN_WINDOW_DAYS;
    const windowDays = getCountdownWindowDays(rawWindow);

    if (targetCalendarIds.length === 0) {
      const emptySnapshot: CountdownSnapshot = {
        items: [],
        updatedAt: now.toISOString(),
        source: "google",
      };
      return json(res, 200, emptySnapshot);
    }

    const cacheKey = `${userId}:${context.accountId}:${windowDays}:${[...targetCalendarIds].sort().join(",")}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached && now.getTime() - cached.at < SNAPSHOT_CACHE_TTL_MS) {
      return json(res, 200, cached.snapshot);
    }

    const existingInFlight = inFlightReads.get(cacheKey);
    if (existingInFlight) {
      try {
        const snapshot = await existingInFlight;
        return json(res, 200, snapshot);
      } catch (error) {
        const cause = error instanceof DashboardCalendarStageError ? error.cause : error;
        return json(res, 503, {
          error: "Calendar events could not be read",
          stage: "events",
          code: failureCode(cause),
        });
      }
    }

    const today = berlinDay(now);
    const totalFrom = Date.parse(berlinMidnight(today));
    const totalTo = Date.parse(berlinMidnight(addAgendaDays(today, windowDays)));

    const fetchPromise = (async (): Promise<CountdownSnapshot> => {
      const mergedByCalendar = new Map<string, CalendarInput>();
      for (const calId of targetCalendarIds) {
        mergedByCalendar.set(calId, { calendarId: calId, events: [] });
      }

      for (let chunkStart = totalFrom; chunkStart < totalTo; chunkStart += MAX_CHUNK_MS) {
        const chunkEnd = Math.min(chunkStart + MAX_CHUNK_MS, totalTo);
        const chunkResults = await deps.events(targetCalendarIds, chunkStart, chunkEnd);
        for (const input of chunkResults) {
          const existing = mergedByCalendar.get(input.calendarId);
          if (existing) {
            existing.events.push(...input.events);
          } else {
            mergedByCalendar.set(input.calendarId, { ...input });
          }
        }
      }

      const items = toCountdowns([...mergedByCalendar.values()], now, windowDays);
      const snapshot: CountdownSnapshot = {
        items,
        updatedAt: now.toISOString(),
        source: "google",
      };
      snapshotCache.set(cacheKey, { at: now.getTime(), snapshot });
      return snapshot;
    })();

    inFlightReads.set(cacheKey, fetchPromise);

    try {
      const snapshot = await fetchPromise;
      return json(res, 200, snapshot);
    } catch (error) {
      const cause = error instanceof DashboardCalendarStageError ? error.cause : error;
      return json(res, 503, {
        error: "Calendar events could not be read",
        stage: "events",
        code: failureCode(cause),
      });
    } finally {
      inFlightReads.delete(cacheKey);
    }
  };
}
