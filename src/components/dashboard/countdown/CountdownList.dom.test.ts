// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ connected: true }));
vi.mock("@/lib/connected-apps", () => ({
  connectorStatusMemory: () => ({ authoritative: true, services: { googlecalendar: { connected: fixture.connected } } }),
  preloadConnectedApps: async () => ({ authoritative: true, refused: false, services: { googlecalendar: { connected: fixture.connected } } }),
}));
vi.mock("@/lib/connector-status", () => ({
  hasActiveConnection: (service: { connected?: boolean }) => service.connected === true,
}));
vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ pluginsOpen: false }),
}));

import { setRelayLink } from "@/lib/relay-server";
import { CountdownContent, CountdownList } from "./CountdownList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  setRelayLink(null);
  globalThis.fetch = nativeFetch;
  fixture.connected = true;
  document.body.innerHTML = "";
});

it("renders countdown cards, handles empty/error/loading/disconnected states, and refreshes on visibility", async () => {
  let eventTitle = "Vacation";
  const relayCalls: Array<{ path: string; method: string }> = [];

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      relayCalls.push({ path, method });
      if (path.startsWith("/api/dashboard/countdowns")) {
        return jsonResponse({
          items: [
            {
              id: "school:trip",
              calendarId: "school",
              eventId: "trip",
              title: eventTitle,
              targetDate: "2026-12-01",
              daysRemaining: 5,
              allDay: true,
            },
            {
              id: "primary:today-event",
              calendarId: "primary",
              eventId: "today-event",
              title: "Party",
              targetDate: "2026-11-26",
              daysRemaining: 0,
              allDay: true,
            },
          ],
          updatedAt: "2026-11-26T12:00:00.000Z",
          source: "google",
        });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(CountdownList));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(relayCalls.length).toBeGreaterThan(0);
  expect(container.textContent).toContain("Vacation");
  expect(container.textContent).toContain("5");
  expect(container.textContent).toContain("days");
  expect(container.textContent).toContain("Party");
  expect(container.textContent).toContain("Today");

  // Visibility change refresh
  eventTitle = "Summer Trip";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.textContent).toContain("Summer Trip");

  await act(async () => {
    root.unmount();
  });
});

it("renders loading, empty, and disconnected states clearly in CountdownContent", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  // Loading state
  await act(async () => {
    root.render(createElement(CountdownContent, { snapshot: null, loading: true, failed: false, connected: true }));
  });
  expect(container.querySelector("[aria-label='Loading countdowns']")).not.toBeNull();

  // Empty state
  await act(async () => {
    root.render(createElement(CountdownContent, {
      snapshot: { items: [], updatedAt: new Date().toISOString(), source: "google" },
      loading: false,
      failed: false,
      connected: true,
    }));
  });
  expect(container.textContent).toContain("No upcoming countdowns.");

  // Disconnected state
  await act(async () => {
    root.render(createElement(CountdownContent, { snapshot: null, loading: false, failed: false, connected: false }));
  });
  expect(container.textContent).toContain("Google Calendar is disconnected.");

  // Unavailable / error state without cache
  let retried = false;
  await act(async () => {
    root.render(createElement(CountdownContent, {
      snapshot: null,
      loading: false,
      failed: true,
      connected: true,
      onRetry: () => { retried = true; },
    }));
  });
  expect(container.textContent).toContain("Countdowns unavailable.");
  const retryBtn = container.querySelector<HTMLButtonElement>("button");
  expect(retryBtn?.textContent).toBe("Try again");
  await act(async () => {
    retryBtn?.click();
  });
  expect(retried).toBe(true);

  // Unavailable state with stale cache
  await act(async () => {
    root.render(createElement(CountdownContent, {
      snapshot: {
        items: [{ id: "1", calendarId: "c", eventId: "e", title: "Trip", targetDate: "2026-12-01", daysRemaining: 5, allDay: true }],
        updatedAt: "2026-11-26T12:00:00.000Z",
        source: "google",
      },
      loading: false,
      failed: true,
      connected: true,
    }));
  });
  expect(container.textContent).toContain("Countdowns unavailable. Showing the last update from");
  expect(container.textContent).toContain("Trip");

  await act(async () => {
    root.unmount();
  });
});
