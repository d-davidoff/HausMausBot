import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { TASK_LISTS_TOOL, TASK_PATCH_TOOL, TASKS_LIST_TOOL } from "../connected-reads.ts";
import { createDashboardTasksService, DashboardTasksError } from "./tasks-service.ts";

function mcpReply(id: unknown, slug: string, response: { successful: boolean; data: unknown; error: string | null }) {
  const text = JSON.stringify({
    successful: true,
    data: { results: [{ tool_slug: slug, response }] },
    error: null,
  });
  return {
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })),
  };
}

describe("dashboard tasks service", () => {
  it("pages through both task lists and tasks, pins account across every page, strips notes, and filters by Berlin day", async () => {
    const calls: Array<{ account?: string; slug: string; args: Record<string, unknown> }> = [];
    const fixedNow = new Date("2026-11-26T22:30:00Z"); // 23:30 in Europe/Berlin (2026-11-26)

    const service = createDashboardTasksService({
      getCfg: () => ({}) as AppConfig,
      now: () => fixedNow,
      configured: () => true,
      inventory: async () => ({
        complete: true,
        services: {
          googletasks: {
            connected: true,
            pending: false,
            status: "ACTIVE",
            accounts: [{ id: "acc-family", alias: "Family", status: "ACTIVE" }],
          },
        },
      }),
      relay: async (_cfg, payload) => {
        const frame = payload as {
          method: string;
          id: unknown;
          params?: { arguments?: { tools?: Array<{ account?: string; tool_slug: string; arguments: Record<string, unknown> }> } };
        };
        if (frame.method === "initialize") {
          return {
            status: 200,
            bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })),
            transportSessionId: "tasks-session-1",
          };
        }
        if (frame.method === "notifications/initialized") {
          return { status: 200, bytes: new Uint8Array() };
        }
        const tool = frame.params!.arguments!.tools![0]!;
        calls.push({ account: tool.account, slug: tool.tool_slug, args: tool.arguments });

        if (tool.tool_slug === TASK_LISTS_TOOL) {
          if (!tool.arguments.pageToken) {
            return mcpReply(frame.id, TASK_LISTS_TOOL, {
              successful: true,
              data: { items: [{ id: "list-1", title: "Household" }], nextPageToken: "lists-p2" },
              error: null,
            });
          }
          return mcpReply(frame.id, TASK_LISTS_TOOL, {
            successful: true,
            data: { items: [{ id: "list-2", title: "Exercise" }] },
            error: null,
          });
        }

        if (tool.tool_slug === TASKS_LIST_TOOL) {
          if (tool.arguments.tasklist_id === "list-1") {
            if (!tool.arguments.pageToken) {
              return mcpReply(frame.id, TASKS_LIST_TOOL, {
                successful: true,
                data: {
                  tasks: [
                    {
                      id: "shared-id",
                      title: "Buy milk",
                      status: "needsAction",
                      due: "2026-11-26T00:00:00.000Z",
                      notes: "Secret family note should never reach browser",
                    },
                    {
                      id: "deleted-task",
                      title: "Deleted item",
                      status: "needsAction",
                      due: "2026-11-26T00:00:00.000Z",
                      deleted: true,
                    },
                  ],
                  nextPageToken: "list-1-p2",
                },
                error: null,
              });
            }
            return mcpReply(frame.id, TASKS_LIST_TOOL, {
              successful: true,
              data: {
                tasks: [
                  {
                    id: "done-today-utc-yesterday",
                    title: "Evening tidy",
                    status: "completed",
                    due: "2026-11-26T00:00:00.000Z",
                    // 2026-11-25T23:30:00Z is 2026-11-26 00:30 in Berlin!
                    completed: "2026-11-25T23:30:00.000Z",
                  },
                  {
                    id: "done-yesterday-berlin",
                    title: "Completed yesterday",
                    status: "completed",
                    due: "2026-11-26T00:00:00.000Z",
                    // 2026-11-25T22:30:00Z is 2026-11-25 23:30 in Berlin -> excluded!
                    completed: "2026-11-25T22:30:00.000Z",
                  },
                  {
                    id: "due-tomorrow",
                    title: "Tomorrow task",
                    status: "needsAction",
                    due: "2026-11-27T00:00:00.000Z",
                  },
                ],
              },
              error: null,
            });
          }

          return mcpReply(frame.id, TASKS_LIST_TOOL, {
            successful: true,
            data: {
              tasks: [
                {
                  id: "shared-id",
                  title: "1.2M views · 40K likes | 15 min Core Flow",
                  status: "needsAction",
                  due: "2026-11-26T00:00:00.000Z",
                  hidden: true,
                  notes: [
                    "Day 3 of 14 · 08:30 Europe/Berlin · 15 min",
                    "Exercise video: https://private.example.test/video",
                    "[Family-OS challenge: " + "a".repeat(64) + "/2026-11-26]",
                  ].join("\n"),
                },
              ],
            },
            error: null,
          });
        }

        throw new Error(`Unexpected tool ${tool.tool_slug}`);
      },
    });

    const snapshot = await service.readTodayTasks({
      auth: { kind: "loopback", scopes: ["admin", "client"] },
    });

    expect(snapshot.accountId).toBe("acc-family");
    expect(snapshot.date).toBe("2026-11-26");
    expect(snapshot.lists).toEqual([
      {
        id: "list-1",
        title: "Household",
        items: [
          {
            id: "shared-id",
            listId: "list-1",
            title: "Buy milk",
            status: "needsAction",
            due: "2026-11-26T00:00:00.000Z",
            isChallenge: false,
          },
          {
            id: "done-today-utc-yesterday",
            listId: "list-1",
            title: "Evening tidy",
            status: "completed",
            due: "2026-11-26T00:00:00.000Z",
            completed: "2026-11-25T23:30:00.000Z",
            isChallenge: false,
          },
        ],
      },
      {
        id: "list-2",
        title: "Exercise",
        items: [
          {
            id: "shared-id",
            listId: "list-2",
            title: "15 min Core Flow",
            status: "needsAction",
            due: "2026-11-26T00:00:00.000Z",
            isChallenge: true,
            challengeTime: "08:30",
            challengeMinutes: 15,
          },
        ],
      },
    ]);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("Secret family note");
    expect(serialized).not.toContain("https://private.example.test/video");
    expect(serialized).not.toContain("a".repeat(64));

    expect(calls.every((call) => call.account === "acc-family")).toBe(true);
    const taskCalls = calls.filter((call) => call.slug === TASKS_LIST_TOOL);
    expect(taskCalls).toHaveLength(3);
    for (const call of taskCalls) {
      expect(call.args).toMatchObject({
        showCompleted: true,
        showDeleted: false,
        showHidden: true,
        showAssigned: true,
      });
    }
  });

  it("requires explicit selection when multiple accounts qualify and classifies write errors distinctly", async () => {
    let nextWriteResponse:
      | { kind: "ok" }
      | { kind: "missing" }
      | { kind: "scope" }
      | { kind: "transport" }
      | { kind: "timeout" } = { kind: "ok" };

    const service = createDashboardTasksService({
      getCfg: () => ({}) as AppConfig,
      readTimeoutMs: 40,
      configured: () => true,
      inventory: async () => ({
        complete: true,
        services: {
          googletasks: {
            connected: true,
            pending: false,
            status: "ACTIVE",
            accounts: [
              { id: "acc-1", alias: "Parents", status: "ACTIVE" },
              { id: "acc-2", alias: "Kids", status: "ACTIVE" },
            ],
          },
        },
      }),
      relay: async (_cfg, payload, _transport, signal) => {
        const frame = payload as { method: string; id: unknown; params?: { arguments?: { tools?: Array<{ account?: string; tool_slug: string }> } } };
        if (frame.method === "initialize") {
          return {
            status: 200,
            bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })),
          };
        }
        if (frame.method === "notifications/initialized") {
          return { status: 200, bytes: new Uint8Array() };
        }
        const tool = frame.params!.arguments!.tools![0]!;
        if (tool.tool_slug === TASK_PATCH_TOOL) {
          if (nextWriteResponse.kind === "timeout") {
            return await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          if (nextWriteResponse.kind === "transport") {
            return { status: 502, bytes: new Uint8Array() };
          }
          if (nextWriteResponse.kind === "missing") {
            return mcpReply(frame.id, TASK_PATCH_TOOL, { successful: false, data: null, error: "404 Requested entity was not found." });
          }
          if (nextWriteResponse.kind === "scope") {
            return mcpReply(frame.id, TASK_PATCH_TOOL, {
              successful: false,
              data: null,
              error: "403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: Request had insufficient authentication scopes.",
            });
          }
          return mcpReply(frame.id, TASK_PATCH_TOOL, {
            successful: true,
            data: { id: "t-1", status: "completed", completed: "2026-11-26T10:00:00.000Z" },
            error: null,
          });
        }
        return mcpReply(frame.id, tool.tool_slug, { successful: true, data: { items: [] }, error: null });
      },
    });

    await expect(
      service.readTodayTasks({ auth: { kind: "loopback", scopes: ["admin", "client"] } }),
    ).rejects.toMatchObject({
      code: "account_selection_required",
      status: 409,
      accounts: [
        { id: "acc-1", label: "Parents", status: "ACTIVE" },
        { id: "acc-2", label: "Kids", status: "ACTIVE" },
      ],
    });

    nextWriteResponse = { kind: "missing" };
    await expect(
      service.completeTask({ auth: { kind: "loopback", scopes: ["admin", "client"] }, accountId: "acc-1", listId: "l-1", taskId: "t-1" }),
    ).rejects.toMatchObject({ code: "task_not_found", status: 404 });

    nextWriteResponse = { kind: "scope" };
    await expect(
      service.completeTask({ auth: { kind: "loopback", scopes: ["admin", "client"] }, accountId: "acc-1", listId: "l-1", taskId: "t-1" }),
    ).rejects.toMatchObject({ code: "insufficient_write_scope", status: 403 });

    nextWriteResponse = { kind: "transport" };
    await expect(
      service.completeTask({ auth: { kind: "loopback", scopes: ["admin", "client"] }, accountId: "acc-1", listId: "l-1", taskId: "t-1" }),
    ).rejects.toMatchObject({ code: "provider_write_failed", status: 502 });

    nextWriteResponse = { kind: "timeout" };
    await expect(
      service.completeTask({ auth: { kind: "loopback", scopes: ["admin", "client"] }, accountId: "acc-1", listId: "l-1", taskId: "t-1" }),
    ).rejects.toBeInstanceOf(DashboardTasksError);
    await expect(
      service.completeTask({ auth: { kind: "loopback", scopes: ["admin", "client"] }, accountId: "acc-1", listId: "l-1", taskId: "t-1" }),
    ).rejects.toMatchObject({ code: "ambiguous_timeout", status: 504 });
  });
});
