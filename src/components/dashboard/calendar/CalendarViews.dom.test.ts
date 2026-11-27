// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CalendarProvider } from "./CalendarController";
import { CalendarAgenda } from "../agenda/CalendarAgenda";
import { CountdownList } from "../countdown/CountdownList";
import { setRelayLink } from "@/lib/relay-server";
import type { DashboardView } from "../widget";

vi.mock("@/lib/connected-apps", () => ({ preloadConnectedApps: async () => ({ authoritative: true, services: { googlecalendar: { connected: true } } }) }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: unknown) => unknown) => select({ pluginsOpen: false }) }));
vi.mock("./GoogleCalendarConnection", () => ({ GoogleCalendarConnection: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => setRelayLink(null));
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const day = (title: string) => [{ date: "2026-11-27", events: [{ id: title, calendarId: "school", title, start: "2026-11-27T12:00:00Z", end: "2026-11-27T13:00:00Z", allDay: false }] }];
const countdown = (title: string) => ({ items: [{ id: title, calendarId: "school", eventId: title, title, targetDate: "2026-11-28", daysRemaining: 1, allDay: true }], calendars: [{ id: "school", name: "School" }], updatedAt: "2026-11-27T12:00:00Z", source: "google" });

it("refreshes both calendar views after a save, ignores older reads, and preserves queued saves while switching views", async () => {
  let saved: string[] = ["primary"];
  let oldAgenda: ((value: Response) => void) | undefined;
  let oldCountdown: ((value: Response) => void) | undefined;
  let finishSave: ((value: Response) => void) | undefined;
  const reads: string[] = [];
  const saves: string[][] = [];
  setRelayLink({ close: () => {}, fetch: async (path, request) => {
    if (request?.method === "PUT") {
      saved = JSON.parse(new TextDecoder().decode(request.body ?? new Uint8Array())).calendarIds;
      saves.push(saved);
      if (saves.length === 1) return new Promise<Response>((resolve) => { finishSave = resolve; });
      return response({ selectedCalendarIds: saved });
    }
    reads.push(path);
    if (path === "/api/dashboard/calendar-agenda") return response({ calendars: [{ id: "primary", name: "Home", primary: true }, { id: "school", name: "School", primary: false }], selectedCalendarIds: saved });
    if (path.includes("countdowns")) {
      if (saves.length === 0) return new Promise<Response>((resolve) => { oldCountdown = resolve; });
      return response(countdown("New countdown"));
    }
    if (saves.length === 0) return new Promise<Response>((resolve) => { oldAgenda = resolve; });
    return response(day("New agenda"));
  } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (view: DashboardView) => root.render(createElement(CalendarProvider, { children: [createElement(CalendarAgenda, { key: "agenda", view }), createElement(CountdownList, { key: "countdown", view })] }));
  await act(async () => render("configuration"));
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => { boxes[1]!.click(); boxes[0]!.click(); });
  await act(async () => render("presentation"));
  expect(container.textContent).toContain("Saving calendar selection");
  await act(async () => { finishSave!(response({})); });
  expect(saves).toEqual([["primary", "school"], ["school"]]);
  expect(container.textContent).toContain("New agenda");
  expect(container.textContent).toContain("New countdown");
  const before = reads.length;
  await act(async () => render("configuration"));
  await act(async () => render("presentation"));
  expect(reads).toHaveLength(before);
  await act(async () => { oldAgenda!(response(day("Old agenda"))); oldCountdown!(response(countdown("Old countdown"))); });
  expect(container.textContent).not.toContain("Old agenda");
  expect(container.textContent).not.toContain("Old countdown");
  expect(reads).toContain("/api/dashboard/calendar-agenda?calendarId=school");
  await act(async () => root.unmount());
});
