import { describe, expect, it } from "vitest";
import {
  getCountdownWindowDays,
  removeCountdownMarker,
  toCountdowns,
} from "./dashboard-countdowns.ts";

const now = new Date("2026-11-14T12:00:00+01:00");
const calendar = (...events: any[]) => [{ calendarId: "school", events }];

describe("dashboard countdowns", () => {
  it("removes the countdown marker while preserving description text", () => {
    expect(removeCountdownMarker("School trip #countdown\nBring lunch")).toBe(
      "School trip\nBring lunch",
    );
    expect(removeCountdownMarker("#COUNTDOWN")).toBe("");
  });

  it("uses a configurable 90-day default and rejects invalid windows", () => {
    expect(getCountdownWindowDays(undefined)).toBe(90);
    expect(getCountdownWindowDays("30")).toBe(30);
    expect(getCountdownWindowDays("45")).toBe(45);
    expect(getCountdownWindowDays(45)).toBe(45);
    expect(getCountdownWindowDays("0")).toBe(90);
    expect(getCountdownWindowDays("10000")).toBe(90);
    expect(getCountdownWindowDays("-5")).toBe(90);
    expect(getCountdownWindowDays("abc")).toBe(90);
  });

  it("selects only #countdown in descriptions and sorts upcoming events", () => {
    const items = toCountdowns(
      calendar(
        {
          id: "later",
          summary: "Later",
          description: "<p>#COUNTDOWN</p>",
          start: { date: "2026-11-20" },
        },
        {
          id: "without",
          summary: "Without marker",
          start: { date: "2026-11-16" },
        },
        {
          id: "title-only",
          summary: "#countdown in title",
          start: { date: "2026-11-16" },
        },
        {
          id: "first",
          summary: "Chemie",
          description: "#countdown",
          start: { dateTime: "2026-11-16T11:30:00+01:00" },
        },
        {
          id: "not-marker",
          description: "#countdown-extra",
          start: { date: "2026-11-16" },
        },
      ),
      now,
    );

    expect(items.map((item) => item.title)).toEqual(["Chemie", "Later"]);
    expect(items[0]!.daysRemaining).toBe(2);
  });

  it("works with CalendarEvent format (numbers and boolean allDay)", () => {
    const items = toCountdowns(
      calendar(
        {
          id: "event-1",
          title: "Exam",
          description: "Don't forget #countdown",
          allDay: true,
          start: Date.parse("2026-11-20T00:00:00Z"),
          status: "confirmed",
        },
        {
          id: "event-2",
          title: "Doctor",
          description: "#countdown",
          allDay: false,
          start: Date.parse("2026-11-15T10:00:00+01:00"),
          status: "confirmed",
        },
      ),
      now,
    );

    expect(items.map((item) => item.title)).toEqual(["Doctor", "Exam"]);
    expect(items[0]!.daysRemaining).toBe(1);
    expect(items[1]!.daysRemaining).toBe(6);
  });

  it("keeps the next recurring occurrence only", () => {
    const items = toCountdowns(
      calendar(
        {
          id: "chemie-1",
          recurringEventId: "chemie",
          description: "#countdown",
          summary: "Chemie",
          start: { dateTime: "2026-11-16T11:30:00+01:00" },
        },
        {
          id: "chemie-2",
          recurringEventId: "chemie",
          description: "#countdown",
          summary: "Chemie",
          start: { dateTime: "2026-11-23T11:30:00+01:00" },
        },
      ),
      now,
    );
    expect(items.length).toBe(1);
    expect(items[0]!.targetDate).toBe("2026-11-16");
  });

  it("all-day events remain visible on their starting day; elapsed timed events do not", () => {
    const items = toCountdowns(
      calendar(
        {
          id: "today",
          summary: "Birthday",
          description: "#countdown",
          start: { date: "2026-11-14" },
        },
        {
          id: "earlier",
          summary: "Past class",
          description: "#countdown",
          start: { dateTime: "2026-11-14T08:00:00+01:00" },
        },
        {
          id: "later",
          summary: "Tonight",
          description: "#countdown",
          start: { dateTime: "2026-11-14T20:00:00+01:00" },
        },
      ),
      now,
    );
    expect(items.map((item) => item.title)).toEqual(["Birthday", "Tonight"]);
    expect(items.every((item) => item.daysRemaining === 0)).toBe(true);
  });

  it("90-day window excludes day 90 and uses Berlin dates over DST", () => {
    const items = toCountdowns(
      calendar(
        {
          id: "within",
          description: "#countdown",
          start: { date: "2027-02-11" },
        },
        {
          id: "outside",
          description: "#countdown",
          start: { date: "2027-02-12" },
        },
      ),
      now,
      90,
    );
    expect(items.length).toBe(1);
    expect(items[0]!.daysRemaining).toBe(89);

    const dstItems = toCountdowns(
      calendar({
        id: "dst",
        description: "#countdown",
        start: { dateTime: "2027-03-28T10:00:00+02:00" },
      }),
      new Date("2027-03-27T12:00:00+01:00"),
      5,
    );
    expect(dstItems[0]!.daysRemaining).toBe(1);
  });
});
