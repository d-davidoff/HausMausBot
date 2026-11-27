export const AGENDA_TIME_ZONE = "Europe/Berlin";
export const DEFAULT_COUNTDOWN_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const COUNTDOWN_MARKER = /(^|[^a-z0-9_])#countdown(?![a-z0-9_-])/i;

const berlinDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: AGENDA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface CountdownItem {
  id: string;
  calendarId: string;
  eventId: string;
  title: string;
  targetDate: string;
  daysRemaining: number;
  allDay: boolean;
}

export interface CountdownSnapshot {
  items: CountdownItem[];
  updatedAt: string;
  source: "google";
  /** Calendars resolved after applying saved selections and server fallback sources. */
  calendars?: { id: string; name: string }[];
}

export interface CalendarEventLike {
  id?: string;
  status?: string;
  summary?: string;
  title?: string;
  description?: string;
  allDay?: boolean;
  start?: number | string | { date?: string; dateTime?: string } | null;
  recurringEventId?: string;
  seriesId?: string;
}

export interface CalendarInputLike {
  calendarId: string;
  events: CalendarEventLike[];
}

export function getCountdownWindowDays(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_COUNTDOWN_WINDOW_DAYS;
  const days = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_COUNTDOWN_WINDOW_DAYS;
}

export function berlinDay(date: Date): string {
  const parts = berlinDateFormat.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function dateNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function removeCountdownMarker(description: string): string {
  return description
    .replace(/#countdown/gi, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function toCountdowns(
  calendars: CalendarInputLike[],
  now: Date,
  windowDays = DEFAULT_COUNTDOWN_WINDOW_DAYS,
): CountdownItem[] {
  if (!Number.isInteger(windowDays) || windowDays < 1) return [];

  const today = berlinDay(now);
  const windowEnd = addDays(today, windowDays);
  const nextByEvent = new Map<string, { item: CountdownItem; startMs: number }>();

  for (const calendar of calendars) {
    for (const event of calendar.events) {
      if (
        event.status === "cancelled" ||
        !event.id ||
        !COUNTDOWN_MARKER.test(event.description ?? "")
      ) {
        continue;
      }

      let allDay = Boolean(event.allDay);
      let rawStart: unknown = event.start;

      if (rawStart && typeof rawStart === "object") {
        const startObj = rawStart as { date?: string; dateTime?: string };
        allDay = Boolean(startObj.date);
        rawStart = startObj.date ?? startObj.dateTime;
      }

      if (rawStart === undefined || rawStart === null) continue;

      let startMs: number;
      let targetDate: string;

      if (allDay) {
        targetDate = typeof rawStart === "string" ? rawStart.slice(0, 10) : new Date(rawStart as number).toISOString().slice(0, 10);
        startMs = Date.parse(`${targetDate}T00:00:00Z`);
      } else {
        startMs = typeof rawStart === "number" ? rawStart : Date.parse(String(rawStart));
        if (!Number.isFinite(startMs)) continue;
        targetDate = berlinDay(new Date(startMs));
      }

      if (!Number.isFinite(startMs)) continue;
      if (targetDate < today || targetDate >= windowEnd) continue;
      if (!allDay && startMs <= now.getTime()) continue;

      const eventKey = event.seriesId || event.recurringEventId || event.id;
      const id = `${calendar.calendarId}:${eventKey}`;
      const item: CountdownItem = {
        id,
        calendarId: calendar.calendarId,
        eventId: eventKey,
        title: (event.title ?? event.summary)?.trim() || "Termin",
        targetDate,
        daysRemaining: Math.round((dateNumber(targetDate) - dateNumber(today)) / DAY_MS),
        allDay,
      };

      const previous = nextByEvent.get(id);
      if (!previous || startMs < previous.startMs) {
        nextByEvent.set(id, { item, startMs });
      }
    }
  }

  return [...nextByEvent.values()]
    .sort(
      (a, b) =>
        a.item.targetDate.localeCompare(b.item.targetDate) ||
        Number(b.item.allDay) - Number(a.item.allDay) ||
        a.startMs - b.startMs,
    )
    .map(({ item }) => item);
}
