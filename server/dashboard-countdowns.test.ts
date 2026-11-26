import { describe, expect, it, vi } from "vitest";
import { SourceError, type CalendarEvent } from "./connected-reads.ts";
import { openCalendarPreferencesStore } from "./dashboard/calendar-preferences.ts";
import { createDashboardCountdownsRoute } from "./routes/dashboard-countdowns.ts";
import type { RouteContext } from "./routes/table.ts";

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "event-1",
  title: "Event",
  start: Date.parse("2026-11-25T10:00:00Z"),
  end: Date.parse("2026-11-25T11:00:00Z"),
  allDay: false,
  status: "confirmed",
  selfDeclined: false,
  attendees: [{ email: "private@example.test", self: false, organizer: true }],
  location: "private location",
  description: "private notes #countdown",
  ...overrides,
});

describe("dashboard countdowns route", () => {
  it("returns only render data without private details for eligible #countdown events", async () => {
    const fixedNow = new Date("2026-11-25T08:00:00+01:00");
    const read = vi.fn(async (_calendarIds: readonly string[], _from: number, _to: number) => [
      {
        calendarId: "primary",
        events: [
          event({
            id: "birthday",
            title: "Birthday Party",
            description: "Party time! #countdown",
            allDay: true,
            start: Date.parse("2026-11-28T00:00:00Z"),
          }),
          event({
            id: "no-tag",
            title: "Regular meeting",
            description: "Nothing special here",
            start: Date.parse("2026-11-26T14:00:00+01:00"),
          }),
        ],
      },
    ]);

    const prefs = openCalendarPreferencesStore();
    prefs.save("local-owner", "account-1", ["primary"]);

    const handler = createDashboardCountdownsRoute({
      calendars: async () => ({
        accountId: "account-1",
        calendars: [{ id: "primary", name: "Primary", primary: true }],
      }),
      events: read,
      preferences: prefs,
      now: () => fixedNow,
    });

    let response: { status: number; body: unknown } | undefined;
    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => {
        response = { status, body };
      }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(response?.status).toBe(200);
    const body = response!.body as any;
    expect(body.source).toBe("google");
    expect(body.items.length).toBe(1);
    expect(body.items[0]).toEqual({
      id: "primary:birthday",
      calendarId: "primary",
      eventId: "birthday",
      title: "Birthday Party",
      targetDate: "2026-11-28",
      daysRemaining: 3,
      allDay: true,
    });

    // Verify browser receives render data only - no private leak
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("private location");
    expect(serialized).not.toContain("private notes");
  });

  it("supports configurable look-ahead window and defaults to 90 days", async () => {
    const fixedNow = new Date("2026-11-25T08:00:00+01:00");
    const read = vi.fn(async (_calendarIds: readonly string[], _from: number, _to: number) => {
      return [{ calendarId: "primary", events: [] }];
    });

    const prefs = openCalendarPreferencesStore();
    const handler = createDashboardCountdownsRoute({
      calendars: async () => ({
        accountId: "account-1",
        calendars: [{ id: "primary", name: "Primary", primary: true }],
      }),
      events: read,
      preferences: prefs,
      now: () => fixedNow,
    });

    // Default 90 days
    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: vi.fn(),
    } as unknown as RouteContext);

    expect(read).toHaveBeenCalledOnce();
    const [_, defaultFrom, defaultTo] = read.mock.calls[0]!;
    expect(Math.round((defaultTo - defaultFrom) / (24 * 3600 * 1000))).toBe(90);

    // Custom 30 days via query param
    read.mockClear();
    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns?windowDays=30"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: vi.fn(),
    } as unknown as RouteContext);

    expect(read).toHaveBeenCalledOnce();
    const [_2, customFrom, customTo] = read.mock.calls[0]!;
    expect(Math.round((customTo - customFrom) / (24 * 3600 * 1000))).toBe(30);
  });

  it("chunks requests when look-ahead exceeds 90 days to stay within connected-reads bounds", async () => {
    const fixedNow = new Date("2026-11-25T08:00:00+01:00");
    const chunks: Array<{ from: number; to: number }> = [];
    const read = vi.fn(async (_calendarIds: readonly string[], from: number, to: number) => {
      chunks.push({ from, to });
      return [{ calendarId: "primary", events: [] }];
    });

    const handler = createDashboardCountdownsRoute({
      calendars: async () => ({
        accountId: "account-1",
        calendars: [{ id: "primary", name: "Primary", primary: true }],
      }),
      events: read,
      preferences: openCalendarPreferencesStore(),
      now: () => fixedNow,
    });

    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns?windowDays=180"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: vi.fn(),
    } as unknown as RouteContext);

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.to - chunk.from).toBeLessThanOrEqual(90 * 24 * 3600 * 1000);
    }
  });

  it("rejects unauthorized sessions and preserves family membership boundaries", async () => {
    const handler = createDashboardCountdownsRoute({
      calendars: async () => ({ accountId: "account-1", calendars: [] }),
      events: async () => [],
      preferences: openCalendarPreferencesStore(),
    });

    let deniedResponse: { status: number; body: unknown } | undefined;
    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: {
        kind: "session",
        session: { id: "s-1", email: "guest@example.test", scopes: [] },
        scopes: [],
      },
      json: ((_res: unknown, status: number, body: unknown) => {
        deniedResponse = { status, body };
      }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(deniedResponse?.status).toBe(403);
  });

  it("reports unavailable or revoked connection clearly with standard error code", async () => {
    const handler = createDashboardCountdownsRoute({
      calendars: async () => {
        throw new SourceError("googlecalendar", "invalid_grant: token revoked");
      },
      events: async () => [],
      preferences: openCalendarPreferencesStore(),
    });

    let response: { status: number; body: unknown } | undefined;
    await handler({
      path: "/api/dashboard/countdowns",
      url: new URL("http://localhost/api/dashboard/countdowns"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => {
        response = { status, body };
      }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(response?.status).toBe(503);
    expect(response?.body).toMatchObject({
      error: "Google Calendar connection is unavailable",
      stage: "calendar_validation",
      code: "reconnect_required",
    });
  });

  it("also serves /api/countdowns for Family OS compatibility", async () => {
    const fixedNow = new Date("2026-11-25T08:00:00+01:00");
    const handler = createDashboardCountdownsRoute({
      calendars: async () => ({ accountId: "account-1", calendars: [{ id: "primary", name: "Primary", primary: true }] }),
      events: async () => [{ calendarId: "primary", events: [] }],
      preferences: openCalendarPreferencesStore(),
      now: () => fixedNow,
    });

    let response: { status: number; body: unknown } | undefined;
    await handler({
      path: "/api/countdowns",
      url: new URL("http://localhost/api/countdowns"),
      method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => {
        response = { status, body };
      }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ source: "google", items: [] });
  });
});
