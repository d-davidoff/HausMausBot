// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  connected: true,
  refused: false,
  reconnect: false,
}));

vi.mock("@/lib/connected-apps", () => ({
  connectorStatusMemory: () =>
    fixture.refused
      ? null
      : {
          authoritative: true,
          services: {
            googletasks: {
              connected: fixture.connected,
              accounts: fixture.reconnect ? [{ id: "acc-1", status: "EXPIRED" }] : [],
            },
          },
        },
  preloadConnectedApps: async () =>
    fixture.refused
      ? { authoritative: true, refused: true, services: {} }
      : {
          authoritative: true,
          refused: false,
          services: {
            googletasks: {
              connected: fixture.connected,
              accounts: fixture.reconnect ? [{ id: "acc-1", status: "EXPIRED" }] : [],
            },
          },
        },
}));

vi.mock("@/lib/connector-status", () => ({
  hasActiveConnection: (service?: { connected?: boolean }) => service?.connected === true,
  accountToReconnect: (service?: { connected?: boolean; accounts?: Array<{ id: string; status: string }> }) =>
    service?.connected ? undefined : service?.accounts?.find((a) => a.status !== "ACTIVE"),
}));

vi.mock("@/state/store-select", () => ({
  useStoreSelector: (select: (state: unknown) => unknown) => select({ pluginsOpen: false }),
  useStoreDispatch: () => vi.fn(),
}));

vi.mock("@/lib/app-links", () => ({
  openExternalLink: vi.fn(async () => undefined),
}));

import { loadLocale, setLocale } from "@/lib/i18n";
import { setRelayLink } from "@/lib/relay-server";
import { TodayTasks } from "./TodayTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  setLocale("en");
  setRelayLink(null);
  fixture.connected = true;
  fixture.refused = false;
  fixture.reconnect = false;
  document.body.innerHTML = "";
});

it("keys rows by list/task pair, disables only the pending row, and marks only that row completed after confirmation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  let resolvePatch: ((res: Response) => void) | undefined;
  const completeCalls: Array<{ path: string; body: unknown }> = [];

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      if (path.startsWith("/api/dashboard/tasks") && method === "GET") {
        return jsonResponse({
          accountId: "acc-1",
          date: "2026-11-26",
          updatedAt: "2026-11-26T11:00:00.000Z",
          source: "google",
          lists: [
            {
              id: "list-a",
              title: "Household",
              items: [
                {
                  id: "shared-id",
                  listId: "list-a",
                  title: "Empty dishwasher",
                  status: "needsAction",
                  due: "2026-11-26T00:00:00Z",
                  isChallenge: false,
                },
              ],
            },
            {
              id: "list-b",
              title: "Exercise",
              items: [
                {
                  id: "shared-id",
                  listId: "list-b",
                  title: "Core flow",
                  status: "needsAction",
                  due: "2026-11-26T00:00:00Z",
                  isChallenge: true,
                  challengeTime: "08:30",
                  challengeMinutes: 15,
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/complete") && method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array()));
        completeCalls.push({ path, body });
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(container.textContent).toContain("Household");
  expect(container.textContent).toContain("Exercise");
  expect(container.textContent).toContain("08:30");

  const rowA = container.querySelector('[data-task-row="list-a:shared-id"]')!;
  const rowB = container.querySelector('[data-task-row="list-b:shared-id"]')!;
  const btnA = rowA.querySelector<HTMLButtonElement>("button")!;
  const btnB = rowB.querySelector<HTMLButtonElement>("button")!;

  await act(async () => {
    btnA.click();
  });

  expect(btnA.disabled).toBe(true);
  expect(btnB.disabled).toBe(false);
  expect(completeCalls).toEqual([
    { path: "/api/dashboard/tasks/lists/list-a/tasks/shared-id/complete", body: { accountId: "acc-1" } },
  ]);

  await act(async () => {
    resolvePatch?.(jsonResponse({ status: "completed", completed: "2026-11-26T11:01:00.000Z" }));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(rowA.querySelector('[aria-label="Completed"]')).not.toBeNull();
  expect(rowB.querySelector('[aria-label="Completed"]')).toBeNull();

  await act(async () => {
    root.unmount();
  });
});

it("never renders 'No tasks due today' on failed reads, and refreshes provider state after an ambiguous timeout before offering retry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  let readCount = 0;
  let failRead = true;
  let taskStatus: "needsAction" | "completed" = "needsAction";

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      if (path.startsWith("/api/dashboard/tasks") && method === "GET") {
        readCount += 1;
        if (failRead) {
          return jsonResponse({ error: "Google Tasks could not be read.", code: "provider_read_failed" }, 503);
        }
        return jsonResponse({
          accountId: "acc-1",
          date: "2026-11-26",
          updatedAt: "2026-11-26T11:00:00.000Z",
          source: "google",
          lists: [
            {
              id: "list-1",
              title: "Home",
              items: [
                {
                  id: "t-1",
                  listId: "list-1",
                  title: "Take out trash",
                  status: taskStatus,
                  due: "2026-11-26T00:00:00Z",
                  ...(taskStatus === "completed" ? { completed: "2026-11-26T11:02:00.000Z" } : {}),
                  isChallenge: false,
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/complete") && method === "POST") {
        // Provider actually applied it despite gateway timeout.
        taskStatus = "completed";
        return jsonResponse(
          { error: "Google Tasks timed out before confirming completion.", code: "ambiguous_timeout" },
          504,
        );
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(container.textContent).toContain("Google Tasks could not be read.");
  expect(container.textContent).not.toContain("No tasks due today");

  // Retry succeeds.
  failRead = false;
  const retryBtn = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  await act(async () => {
    retryBtn.click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(container.textContent).toContain("Take out trash");

  // Trigger ambiguous timeout: widget must refresh provider state and discover it was completed.
  const readsBeforeTimeout = readCount;
  const completeBtn = container.querySelector<HTMLButtonElement>('[data-task-row="list-1:t-1"] button')!;
  await act(async () => {
    completeBtn.click();
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(readCount).toBeGreaterThan(readsBeforeTimeout);
  expect(container.querySelector('[data-task-row="list-1:t-1"] [aria-label="Completed"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await act(async () => {
    root.unmount();
  });
});

it("refreshes at Berlin midnight and shows 'No tasks due today' only after a successful read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T23:59:58+01:00"));

  let currentDay = "2026-11-26";
  let reads = 0;

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      if (path.startsWith("/api/dashboard/tasks") && (request?.method ?? "GET") === "GET") {
        reads += 1;
        return jsonResponse({
          accountId: "acc-1",
          date: currentDay,
          updatedAt: new Date().toISOString(),
          source: "google",
          lists:
            currentDay === "2026-11-26"
              ? [
                  {
                    id: "list-1",
                    title: "Home",
                    items: [
                      {
                        id: "t-old",
                        listId: "list-1",
                        title: "Yesterday task",
                        status: "needsAction",
                        due: "2026-11-26T00:00:00Z",
                        isChallenge: false,
                      },
                    ],
                  },
                ]
              : [],
        });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(container.textContent).toContain("Yesterday task");
  expect(container.textContent).not.toContain("No tasks due today");

  const readsBeforeMidnight = reads;
  currentDay = "2026-11-27";

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });

  expect(reads).toBeGreaterThan(readsBeforeMidnight);
  expect(container.textContent).not.toContain("Yesterday task");
  expect(container.textContent).toContain("No tasks due today");

  await act(async () => {
    root.unmount();
  });
});

it("supports multi-account selection, family member fallback when inventory is refused, and binds completion to the row's account after switching", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));
  fixture.refused = true;

  let selected = "";
  let resolveA: ((res: Response) => void) | undefined;
  const completeBodies: Array<{ path: string; body: unknown }> = [];

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      if (path === "/api/dashboard/tasks" && method === "PUT") {
        const body = JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array())) as { accountId: string };
        selected = body.accountId;
        return jsonResponse({ accountId: selected, accounts: [{ id: "acc-a", label: "Parents", status: "ACTIVE" }, { id: "acc-b", label: "Kids", status: "ACTIVE" }] });
      }
      if (path.startsWith("/api/dashboard/tasks") && method === "GET") {
        const url = new URL(`http://localhost${path}`);
        const acct = url.searchParams.get("accountId") ?? selected;
        if (!acct) {
          return jsonResponse(
            {
              error: "Choose a Google Tasks account.",
              code: "account_selection_required",
              accounts: [
                { id: "acc-a", label: "Parents", status: "ACTIVE" },
                { id: "acc-b", label: "Kids", status: "ACTIVE" },
              ],
            },
            409,
          );
        }
        return jsonResponse({
          accountId: acct,
          accounts: [
            { id: "acc-a", label: "Parents", status: "ACTIVE" },
            { id: "acc-b", label: "Kids", status: "ACTIVE" },
          ],
          date: "2026-11-26",
          updatedAt: "2026-11-26T11:00:00.000Z",
          source: "google",
          lists: [
            {
              id: `list-${acct}`,
              title: acct === "acc-a" ? "Parents List" : "Kids List",
              items: [
                {
                  id: "t-1",
                  listId: `list-${acct}`,
                  title: acct === "acc-a" ? "Parents task" : "Kids task",
                  status: "needsAction",
                  due: "2026-11-26T00:00:00Z",
                  isChallenge: false,
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/complete") && method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array()));
        completeBodies.push({ path, body });
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks, { view: "configuration" }));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(container.textContent).toContain("Choose a Google Tasks account.");
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Google Tasks account"]')!;

  await act(async () => {
    select.value = "acc-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
  });

  await act(async () => { root.render(createElement(TodayTasks, { view: "presentation" })); });
  expect(container.textContent).toContain("Parents task");

  // Start completing Parents task, then switch to Kids while completion is in flight.
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-task-row="list-acc-a:t-1"] button')!.click();
  });

  await act(async () => {
    root.render(createElement(TodayTasks, { view: "configuration" }));
  });
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Google Tasks account"]')!;
    select.value = "acc-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
  });

  await act(async () => { root.render(createElement(TodayTasks, { view: "presentation" })); });
  expect(container.textContent).toContain("Kids task");

  // Even when acc-a completion resolves later, it bound to acc-a and never marks Kids task completed.
  await act(async () => {
    resolveA?.(jsonResponse({ status: "completed", completed: "2026-11-26T11:05:00.000Z" }));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(completeBodies).toEqual([
    { path: "/api/dashboard/tasks/lists/list-acc-a/tasks/t-1/complete", body: { accountId: "acc-a" } },
  ]);
  expect(container.querySelector('[data-task-row="list-acc-b:t-1"] [aria-label="Completed"]')).toBeNull();

  await act(async () => {
    root.unmount();
  });
});

it("localizes the tasks heading and Google Tasks button label", async () => {
  setRelayLink({
    close: () => undefined,
    fetch: async () =>
      jsonResponse({
        accountId: "acc-1",
        date: "2026-11-26",
        updatedAt: "2026-11-26T11:00:00.000Z",
        source: "google",
        lists: [],
      }),
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.querySelector("h2")?.textContent).toContain("My tasks");
  expect(container.querySelector("h2 .sr-only")?.textContent).toBe("Open Google Tasks");

  await act(async () => {
    await loadLocale("ru");
  });
  expect(container.querySelector("h2")?.textContent).toContain("Мои задачи");
  expect(container.querySelector("h2 .sr-only")?.textContent).toBe("Открыть Google Задачи");

  await act(async () => {
    root.unmount();
  });
});

it("keeps completion disabled after an ambiguous timeout when the status refresh fails until a subsequent refresh succeeds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  let failRefresh = false;
  let completeAttempts = 0;

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      if (path.startsWith("/api/dashboard/tasks") && method === "GET") {
        if (failRefresh) {
          return jsonResponse({ error: "Google Tasks could not be read.", code: "provider_read_failed" }, 503);
        }
        return jsonResponse({
          accountId: "acc-1",
          date: "2026-11-26",
          updatedAt: "2026-11-26T11:00:00.000Z",
          source: "google",
          lists: [
            {
              id: "list-1",
              title: "Home",
              items: [
                {
                  id: "t-1",
                  listId: "list-1",
                  title: "Check mail",
                  status: "needsAction",
                  due: "2026-11-26T00:00:00Z",
                  isChallenge: false,
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/complete") && method === "POST") {
        completeAttempts += 1;
        if (completeAttempts === 1) {
          return jsonResponse(
            { error: "Google Tasks timed out before confirming completion.", code: "ambiguous_timeout" },
            504,
          );
        }
        return jsonResponse({ status: "completed", completed: "2026-11-26T11:05:00.000Z" });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  // Fail the post-timeout refresh so provider state stays unconfirmed.
  failRefresh = true;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-task-row="list-1:t-1"] button')!.click();
    await vi.advanceTimersByTimeAsync(10);
  });

  const btnAfterFailedRefresh = container.querySelector<HTMLButtonElement>('[data-task-row="list-1:t-1"] button')!;
  expect(btnAfterFailedRefresh.disabled).toBe(true);
  expect(container.textContent).toContain("Refresh tasks before trying again.");

  // Once a subsequent refresh succeeds, completion is re-enabled and can succeed.
  failRefresh = false;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="status"] button')!.click();
    await vi.advanceTimersByTimeAsync(10);
  });

  const btnAfterSucceededRefresh = container.querySelector<HTMLButtonElement>('[data-task-row="list-1:t-1"] button')!;
  expect(btnAfterSucceededRefresh.disabled).toBe(false);

  await act(async () => {
    btnAfterSucceededRefresh.click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(completeAttempts).toBe(2);
  expect(container.querySelector('[data-task-row="list-1:t-1"] [aria-label="Completed"]')).not.toBeNull();

  await act(async () => {
    root.unmount();
  });
});

it("withholds cached tasks until the account and its data have been verified", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  sessionStorage.setItem(
    "openmausbot.dashboard.tasks",
    JSON.stringify({
      accountId: "acc-1",
      date: "2026-11-26",
      updatedAt: "2026-11-26T10:00:00.000Z",
      source: "google",
      lists: [
        {
          id: "list-1",
          title: "Home",
          items: [
            {
              id: "t-cached",
              listId: "list-1",
              title: "Instant cached chore",
              status: "needsAction",
              due: "2026-11-26T00:00:00Z",
              isChallenge: false,
            },
          ],
        },
      ],
    }),
  );

  let resolveFetch: ((res: Response) => void) | undefined;
  setRelayLink({
    close: () => undefined,
    fetch: () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(container.textContent).not.toContain("Instant cached chore");
  expect(container.textContent).toContain("Loading tasks…");

  await act(async () => {
    resolveFetch?.(
      jsonResponse({
        accountId: "acc-1",
        date: "2026-11-26",
        updatedAt: "2026-11-26T11:00:00.000Z",
        source: "google",
        lists: [
          {
            id: "list-1",
            title: "Home",
            items: [
              {
                id: "t-fresh",
                listId: "list-1",
                title: "Fresh revalidated chore",
                status: "needsAction",
                due: "2026-11-26T00:00:00Z",
                isChallenge: false,
              },
            ],
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(container.textContent).toContain("Fresh revalidated chore");
  expect(container.textContent).not.toContain("Instant cached chore");
  expect(sessionStorage.getItem("openmausbot.dashboard.tasks")).toContain("Fresh revalidated chore");

  await act(async () => {
    root.unmount();
  });
});

it("ignores cached tasks from any prior visit when authorization cannot be verified", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  sessionStorage.setItem(
    "openmausbot.dashboard.tasks",
    JSON.stringify({
      accountId: "acc-1",
      date: "2026-11-25",
      updatedAt: "2026-11-25T22:00:00.000Z",
      source: "google",
      lists: [],
    }),
  );

  let resolvePreviousDayCheck: ((res: Response) => void) | undefined;
  setRelayLink({
    close: () => undefined,
    fetch: () =>
      new Promise<Response>((resolve) => {
        resolvePreviousDayCheck = resolve;
      }),
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(container.textContent).toContain("Loading tasks…");
  expect(container.textContent).not.toContain("No tasks due today");

  resolvePreviousDayCheck?.(jsonResponse({ error: "Cancelled" }, 503));
  await act(async () => {
    root.unmount();
  });


  sessionStorage.setItem(
    "openmausbot.dashboard.tasks",
    JSON.stringify({
      accountId: "acc-1",
      date: "2026-11-26",
      updatedAt: "2026-11-26T10:00:00.000Z",
      source: "google",
      lists: [
        {
          id: "list-1",
          title: "Home",
          items: [
            {
              id: "t-cached",
              listId: "list-1",
              title: "Stale same-day chore",
              status: "needsAction",
              due: "2026-11-26T00:00:00Z",
              isChallenge: false,
            },
          ],
        },
      ],
    }),
  );

  let nextStatus: { status: number; body: unknown } = {
    status: 503,
    body: { error: "Google Tasks could not be read.", code: "provider_read_failed" },
  };
  setRelayLink({
    close: () => undefined,
    fetch: async () => jsonResponse(nextStatus.body, nextStatus.status),
  });

  const secondContainer = document.createElement("div");
  document.body.appendChild(secondContainer);
  const secondRoot = createRoot(secondContainer);

  await act(async () => {
    secondRoot.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(secondContainer.textContent).not.toContain("Stale same-day chore");
  expect(secondContainer.textContent).toContain("Google Tasks could not be read.");

  // Once the connection is reported missing, the stale cache is cleared.
  nextStatus = { status: 404, body: { error: "Not connected", code: "not_connected" } };
  await act(async () => {
    secondContainer.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(sessionStorage.getItem("openmausbot.dashboard.tasks")).toBeNull();
  expect(secondContainer.textContent).toContain("Google Tasks isn’t connected.");

  await act(async () => {
    secondRoot.unmount();
  });
});

it("toggles completion and unchecking by clicking the task text or checkbox", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00+01:00"));

  const calls: Array<{ path: string; body: unknown }> = [];
  let status: "needsAction" | "completed" = "needsAction";

  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      if (path.startsWith("/api/dashboard/tasks") && method === "GET") {
        return jsonResponse({
          accountId: "acc-1",
          date: "2026-11-26",
          updatedAt: "2026-11-26T11:00:00.000Z",
          source: "google",
          lists: [
            {
              id: "list-1",
              title: "Home",
              items: [
                {
                  id: "t-1",
                  listId: "list-1",
                  title: "Stretch",
                  status,
                  due: "2026-11-26T00:00:00Z",
                  ...(status === "completed" ? { completed: "2026-11-26T11:05:00.000Z" } : {}),
                  isChallenge: false,
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/complete") && method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array()));
        calls.push({ path, body });
        status = "completed";
        return jsonResponse({ status: "completed", completed: "2026-11-26T11:05:00.000Z" });
      }
      if (path.endsWith("/reopen") && method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array()));
        calls.push({ path, body });
        status = "needsAction";
        return jsonResponse({ status: "needsAction" });
      }
      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(createElement(TodayTasks));
    await vi.advanceTimersByTimeAsync(10);
  });

  const row = container.querySelector('[data-task-row="list-1:t-1"]')!;
  const titleSpan = Array.from(row.querySelectorAll("span")).find((el) => el.textContent === "Stretch")!;
  await act(async () => {
    titleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(calls[0]).toEqual({ path: "/api/dashboard/tasks/lists/list-1/tasks/t-1/complete", body: { accountId: "acc-1" } });
  expect(row.querySelector('[aria-label="Completed"]')).not.toBeNull();
  expect(row.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");

  // Clicking the completed text or checkbox unchecks via /reopen.
  const updatedTitleSpan = Array.from(row.querySelectorAll("span")).find((el) => el.textContent === "Stretch")!;
  await act(async () => {
    updatedTitleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
  });

  expect(calls[1]).toEqual({ path: "/api/dashboard/tasks/lists/list-1/tasks/t-1/reopen", body: { accountId: "acc-1" } });
  expect(row.querySelector('[aria-label="Completed"]')).toBeNull();
  expect(row.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
  expect(sessionStorage.getItem("openmausbot.dashboard.tasks")).toContain('"status":"needsAction"');

  await act(async () => {
    root.unmount();
  });
});
