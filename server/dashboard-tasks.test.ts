import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { TASK_PATCH_TOOL } from "./connected-reads.ts";
import { createDashboardTasksService } from "./dashboard/tasks-service.ts";
import { openTasksPreferencesStore } from "./dashboard/tasks-preferences.ts";
import { requiredScope } from "./request-auth.ts";
import { createDashboardTasksRoute } from "./routes/dashboard-tasks.ts";
import type { RouteContext } from "./routes/table.ts";
import { startFakeConnectedApps, type FakeConnectedApps } from "./testing/fake-connected-apps.ts";

describe("dashboard tasks routes with stubbed connector", () => {
  let apps: FakeConnectedApps;

  beforeAll(async () => {
    apps = await startFakeConnectedApps();
  });

  afterAll(async () => {
    await apps.close();
  });

  function setup(options: {
    authorizeMember?: Parameters<typeof createDashboardTasksRoute>[0]["authorizeMember"];
    canAccessConnection?: Parameters<typeof createDashboardTasksService>[0]["canAccessConnection"];
    now?: () => Date;
  } = {}) {
    const preferences = openTasksPreferencesStore();
    const service = createDashboardTasksService({
      getCfg: () => ({}) as AppConfig,
      now: options.now,
      configured: () => true,
      canAccessConnection: options.canAccessConnection,
      inventory: async () => {
        const res = await fetch(`${apps.url}/v1/connectors/connected`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          services: Record<string, { connected: boolean; accounts?: Array<{ id: string; alias?: string; status: string }> }>;
        };
        return {
          complete: true,
          services: Object.fromEntries(
            Object.entries(body.services).map(([slug, state]) => [
              slug,
              {
                connected: state.connected,
                pending: false,
                status: state.connected ? "ACTIVE" : "not_connected",
                accounts: state.accounts ?? [],
              },
            ]),
          ),
        };
      },
      relay: async (_cfg, payload, transportSessionId, signal) => {
        const headers = new Headers({ "content-type": "application/json" });
        if (transportSessionId) headers.set("mcp-session-id", transportSessionId);
        const res = await fetch(`${apps.url}/v1/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
        return {
          status: res.status,
          bytes: new Uint8Array(await res.arrayBuffer()),
          transportSessionId: res.headers.get("mcp-session-id") ?? undefined,
        };
      },
    });
    const handler = createDashboardTasksRoute({
      service,
      preferences,
      authorizeMember: options.authorizeMember,
    });

    const invoke = async (input: {
      method: string;
      path: string;
      body?: unknown;
      auth?: RouteContext["auth"];
    }) => {
      let response: { status: number; body: unknown } | undefined;
      await handler({
        method: input.method,
        path: input.path.split("?")[0]!,
        url: new URL(`http://localhost${input.path}`),
        req: {} as RouteContext["req"],
        res: { setHeader: () => undefined } as unknown as RouteContext["res"],
        auth: input.auth ?? { kind: "loopback", scopes: ["admin", "client"] },
        readBody: async () => input.body,
        json: ((_res: unknown, status: number, body: unknown) => {
          response = { status, body };
        }) as RouteContext["json"],
      });
      return response!;
    };

    return { invoke, preferences };
  }

  it("allows client-scoped family sessions in CLIENT_ALLOW and blocks denied requests without provider writes", async () => {
    expect(requiredScope("GET", "/api/dashboard/tasks")).toBe("client");
    expect(requiredScope("PUT", "/api/dashboard/tasks")).toBe("client");
    expect(requiredScope("POST", "/api/dashboard/tasks/lists/list-1/tasks/task-1/complete")).toBe("client");

    apps.connected = { googletasks: true };
    apps.accounts = { googletasks: [{ id: "acc-1", status: "ACTIVE" }] };
    apps.calls = [];
    apps.taskLists = [{ id: "list-1", title: "Home" }];
    apps.tasksByList = {
      "list-1": [{ id: "task-1", title: "Water plants", status: "needsAction", due: "2026-11-26T00:00:00Z" }],
    };

    const { invoke } = setup({
      authorizeMember: (auth) => auth.kind !== "session" || auth.session.email !== "removed@example.test",
      canAccessConnection: ({ auth, mode }) => !(mode === "write" && auth.kind === "session" && auth.session.email === "readonly@example.test"),
      now: () => new Date("2026-11-26T10:00:00+01:00"),
    });

    // Service-trust loopback (bot shell) is refused with zero provider calls.
    const botShell = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-1/tasks/task-1/complete",
      body: { accountId: "acc-1" },
      auth: { kind: "loopback", scopes: ["client"], trust: "service" },
    });
    expect(botShell.status).toBe(403);

    // Removed member is refused with zero provider calls.
    const removed = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-1/tasks/task-1/complete",
      body: { accountId: "acc-1" },
      auth: {
        kind: "session",
        via: "cookie",
        scopes: ["client"],
        session: { id: "s-removed", email: "removed@example.test", membershipAuthority: "team" } as any,
      },
    });
    expect(removed.status).toBe(403);

    // Family member without write access to connection can read, cannot write, and makes no provider write.
    const readRes = await invoke({
      method: "GET",
      path: "/api/dashboard/tasks",
      auth: {
        kind: "session",
        via: "cookie",
        scopes: ["client"],
        session: { id: "s-ro", email: "readonly@example.test", membershipAuthority: "team" } as any,
      },
    });
    expect(readRes.status).toBe(200);

    const writeDenied = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-1/tasks/task-1/complete",
      body: { accountId: "acc-1" },
      auth: {
        kind: "session",
        via: "cookie",
        scopes: ["client"],
        session: { id: "s-ro", email: "readonly@example.test", membershipAuthority: "team" } as any,
      },
    });
    expect(writeDenied.status).toBe(403);
    expect(apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL)).toEqual([]);

    // Invalid IDs are rejected with 400 and make no provider calls.
    const badIds = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/%2e%2e/tasks/task-1/complete",
      body: { accountId: "acc-1" },
    });
    expect(badIds.status).toBe(400);
    expect(apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL)).toEqual([]);
  });

  it("binds completion to the row's supplying account after an account switch, rejects stale selections, and persists after reload", async () => {
    apps.connected = { googletasks: true };
    apps.accounts = {
      googletasks: [
        { id: "acc-a", status: "ACTIVE" },
        { id: "acc-b", status: "ACTIVE" },
      ],
    };
    apps.calls = [];
    apps.taskNow = () => "2026-11-26T14:15:00.000Z";
    apps.tasksByAccount = {
      "acc-a": {
        taskLists: [{ id: "list-a", title: "Account A List" }],
        tasksByList: {
          "list-a": [{ id: "same-task", title: "From A", status: "needsAction", due: "2026-11-26T00:00:00Z" }],
        },
      },
      "acc-b": {
        taskLists: [{ id: "list-b", title: "Account B List" }],
        tasksByList: {
          "list-b": [{ id: "same-task", title: "From B", status: "needsAction", due: "2026-11-26T00:00:00Z" }],
        },
      },
    };

    const { invoke } = setup({ now: () => new Date("2026-11-26T14:00:00+01:00") });

    const unselected = await invoke({ method: "GET", path: "/api/dashboard/tasks" });
    expect(unselected.status).toBe(409);
    expect(unselected.body).toMatchObject({ code: "account_selection_required" });

    // Select acc-a and read its tasks.
    expect((await invoke({ method: "PUT", path: "/api/dashboard/tasks", body: { accountId: "acc-a" } })).status).toBe(200);
    const fromA = await invoke({ method: "GET", path: "/api/dashboard/tasks" });
    expect(fromA.status).toBe(200);
    expect(fromA.body).toMatchObject({
      accountId: "acc-a",
      lists: [{ id: "list-a", items: [{ id: "same-task", title: "From A", status: "needsAction" }] }],
    });

    // Switch preference to acc-b.
    expect((await invoke({ method: "PUT", path: "/api/dashboard/tasks", body: { accountId: "acc-b" } })).status).toBe(200);

    // Completing the row from acc-a binds to acc-a, not acc-b, and returns ONLY status + completed.
    const completed = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-a/tasks/same-task/complete",
      body: { accountId: "acc-a" },
    });
    expect(completed).toEqual({
      status: 200,
      body: { status: "completed", completed: "2026-11-26T14:15:00.000Z" },
    });

    // Reloading acc-a shows persisted completion; acc-b remains incomplete.
    const reloadedA = await invoke({ method: "GET", path: "/api/dashboard/tasks?accountId=acc-a" });
    expect(reloadedA.body).toMatchObject({
      lists: [{ id: "list-a", items: [{ id: "same-task", status: "completed", completed: "2026-11-26T14:15:00.000Z" }] }],
    });
    const reloadedB = await invoke({ method: "GET", path: "/api/dashboard/tasks" });
    expect(reloadedB.body).toMatchObject({
      accountId: "acc-b",
      lists: [{ id: "list-b", items: [{ id: "same-task", status: "needsAction" }] }],
    });

    // Reopening returns needsAction and persists on reload.
    const reopened = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-a/tasks/same-task/reopen",
      body: { accountId: "acc-a" },
    });
    expect(reopened).toEqual({
      status: 200,
      body: { status: "needsAction" },
    });
    const afterReopenA = await invoke({ method: "GET", path: "/api/dashboard/tasks?accountId=acc-a" });
    expect(afterReopenA.body).toMatchObject({
      lists: [{ id: "list-a", items: [{ id: "same-task", status: "needsAction" }] }],
    });

    // Stale account selection makes no provider write.
    const beforePatchCount = apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL).length;
    const stale = await invoke({
      method: "POST",
      path: "/api/dashboard/tasks/lists/list-a/tasks/same-task/complete",
      body: { accountId: "acc-removed" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "stale_account_selection" });
    expect(apps.calls.filter((call) => call.tool === TASK_PATCH_TOOL)).toHaveLength(beforePatchCount);
  });
});
