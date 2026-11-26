import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { TASK_LISTS_TOOL, TASK_PATCH_TOOL, TASKS_LIST_TOOL } from "./connected-reads.ts";
import { berlinTaskDay } from "../shared/dashboard-tasks.ts";
import { startFakeConnectedApps, type FakeConnectedApps } from "./testing/fake-connected-apps.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

describe("dashboard Google Tasks isolated server fixture", () => {
  let apps: FakeConnectedApps;
  let fixture: Fixture;

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    apps = await startFakeConnectedApps();
    fixture = await launchVerificationServer({
      ...process.env,
      OMB_COMPOSIO_BROKER_URL: apps.url,
      OMB_COMPOSIO_BROKER_TOKEN: apps.token,
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    await apps?.close();
    vi.restoreAllMocks();
  });

  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: fixture.info.url,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it("exercises two-level pagination, duplicate task IDs across lists, completion + reload, denied/stale writes, and read failures", async () => {
    const today = berlinTaskDay(new Date());
    const todayIso = `${today}T00:00:00.000Z`;
    const todayMidnightBerlin = new Date().toISOString();

    apps.connected = { googletasks: true };
    apps.accounts = { googletasks: [{ id: "acc-home", alias: "Home", status: "ACTIVE" }] };
    apps.taskListsPageSize = 1;
    apps.tasksPageSize = 1;
    apps.calls = [];
    apps.taskNow = () => todayMidnightBerlin;
    apps.taskLists = [
      { id: "list-one", title: "Groceries" },
      { id: "list-two", title: "Workouts" },
    ];
    apps.tasksByList = {
      "list-one": [
        { id: "dup-id", title: "Buy oats", status: "needsAction", due: todayIso, notes: "Private note" },
        { id: "deleted-1", title: "Removed", status: "needsAction", due: todayIso, deleted: true },
      ],
      "list-two": [
        {
          id: "dup-id",
          title: "900K views | Mobility session",
          status: "needsAction",
          due: todayIso,
          hidden: true,
          notes: `Day 2 of 7 · 08:30 Europe/Berlin · 15 min\n[Family-OS challenge: ${"b".repeat(64)}/${today}]`,
        },
        {
          id: "done-today",
          title: "Stretch",
          status: "completed",
          due: todayIso,
          completed: todayMidnightBerlin,
        },
        {
          id: "done-yesterday",
          title: "Old completed",
          status: "completed",
          due: todayIso,
          completed: "2020-01-01T12:00:00.000Z",
        },
      ],
    };

    const initial = await request("GET", "/api/dashboard/tasks");
    expect(initial.status).toBe(200);
    expect(initial.body.accountId).toBe("acc-home");
    expect(initial.body.lists).toEqual([
      {
        id: "list-one",
        title: "Groceries",
        items: [{ id: "dup-id", listId: "list-one", title: "Buy oats", status: "needsAction", due: todayIso, isChallenge: false }],
      },
      {
        id: "list-two",
        title: "Workouts",
        items: [
          {
            id: "dup-id",
            listId: "list-two",
            title: "Mobility session",
            status: "needsAction",
            due: todayIso,
            isChallenge: true,
            challengeTime: "08:30",
            challengeMinutes: 15,
          },
          {
            id: "done-today",
            listId: "list-two",
            title: "Stretch",
            status: "completed",
            due: todayIso,
            completed: todayMidnightBerlin,
            isChallenge: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(initial.body)).not.toContain("Private note");

    // Verify two-level pagination actually ran against the stubbed connector.
    expect(apps.calls.filter((call) => call.tool === TASK_LISTS_TOOL)).toHaveLength(2);
    expect(apps.calls.filter((call) => call.tool === TASKS_LIST_TOOL)).toHaveLength(4);

    // Complete dup-id in list-one only, then reload.
    const completed = await request("POST", "/api/dashboard/tasks/lists/list-one/tasks/dup-id/complete", {
      accountId: "acc-home",
    });
    expect(completed).toEqual({
      status: 200,
      body: { status: "completed", completed: todayMidnightBerlin },
    });

    const reloaded = await request("GET", "/api/dashboard/tasks");
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.lists[0].items[0]).toMatchObject({ id: "dup-id", listId: "list-one", status: "completed" });
    expect(reloaded.body.lists[1].items[0]).toMatchObject({ id: "dup-id", listId: "list-two", status: "needsAction" });

    // Denied request (untrusted cross-origin browser header) and stale account selection make zero provider writes.
    const patchCountBefore = apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL).length;
    const denied = await request(
      "POST",
      "/api/dashboard/tasks/lists/list-two/tasks/dup-id/complete",
      { accountId: "acc-home" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    expect(denied.status).toBe(403);

    const stale = await request("POST", "/api/dashboard/tasks/lists/list-two/tasks/dup-id/complete", {
      accountId: "acc-stale",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale_account_selection");
    expect(apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL)).toHaveLength(patchCountBefore);

    // Provider error on read returns 503 error payload, never an empty 200 list.
    apps.tasksError = "500 upstream failure";
    const failedRead = await request("GET", "/api/dashboard/tasks");
    expect(failedRead.status).toBe(503);
    expect(failedRead.body.lists).toBeUndefined();
    apps.tasksError = undefined;
  });
});
