import { createHash } from "node:crypto";
import { z } from "zod";

import type { TasksPreferencesStore } from "../dashboard/tasks-preferences.ts";
import { DashboardTasksError, type DashboardTasksService } from "../dashboard/tasks-service.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const TASK_ACTION_PATH = /^\/api\/dashboard\/tasks\/lists\/([^/]+)\/tasks\/([^/]+)\/(complete|reopen)$/;
const TASK_SEGMENT_PATTERN = /^[A-Za-z0-9@._:=+-]{1,256}$/;
const accountIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const selectAccountBodySchema = z.object({ accountId: accountIdSchema }).strict();
const completeBodySchema = z.object({ accountId: accountIdSchema }).strict();

function preferenceUserId(auth: RequestAuth): string | null {
  if (auth.kind === "loopback") return auth.trust === "service" ? null : "local-owner";
  const { session } = auth;
  if (session.moveIn) return null;
  if (session.userId && session.membershipAuthority !== "portal") return `user:${session.userId}`;
  const email = session.email?.trim().toLowerCase();
  if (email) return `email:${createHash("sha256").update(email).digest("hex")}`;
  return session.membershipAuthority ? null : "local-owner";
}

function decodeTaskSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === "." || decoded === ".." || !TASK_SEGMENT_PATTERN.test(decoded)) {
    return null;
  }
  return decoded;
}

export function createDashboardTasksRoute(deps: {
  service: Pick<DashboardTasksService, "readTodayTasks" | "verifySelection" | "completeTask" | "reopenTask">;
  preferences: TasksPreferencesStore;
  authorizeMember?: (auth: RequestAuth) => Promise<boolean> | boolean;
}): RouteHandler {
  async function authorizedUserId(auth: RequestAuth): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
    if (auth.kind === "loopback") {
      if (auth.trust === "service" || (!auth.scopes.includes("client") && !auth.scopes.includes("admin"))) {
        return { ok: false, error: "Family member access required" };
      }
    } else {
      if (auth.session.moveIn || (!auth.scopes.includes("client") && !auth.scopes.includes("admin"))) {
        return { ok: false, error: "Family member access required" };
      }
    }
    const userId = preferenceUserId(auth);
    if (!userId) {
      return { ok: false, error: "A stable family account identity is required" };
    }
    if (deps.authorizeMember && !(await deps.authorizeMember(auth))) {
      return { ok: false, error: "Family membership required" };
    }
    return { ok: true, userId };
  }

  function respondError(res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"], error: unknown) {
    if (error instanceof DashboardTasksError) {
      return json(res, error.status, {
        error: error.message,
        code: error.code,
        ...(error.accounts !== undefined ? { accounts: error.accounts } : {}),
      });
    }
    return json(res, 503, { error: "Google Tasks request failed", code: "provider_read_failed" });
  }

  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const actionMatch = TASK_ACTION_PATH.exec(path);
    if (path !== "/api/dashboard/tasks" && !actionMatch) return PASS;

    res.setHeader("cache-control", "no-store");

    const access = await authorizedUserId(auth);
    if (!access.ok) {
      return json(res, 403, { error: access.error, code: "forbidden" });
    }

    if (path === "/api/dashboard/tasks") {
      if (method === "GET") {
        const rawAccountId = url.searchParams.get("accountId");
        let requestedAccountId: string | undefined;
        if (rawAccountId !== null) {
          const parsedAccount = accountIdSchema.safeParse(rawAccountId);
          if (!parsedAccount.success) {
            return json(res, 400, { error: "Invalid account selection", code: "invalid_request" });
          }
          requestedAccountId = parsedAccount.data;
        }
        const savedAccountId = deps.preferences.selectedAccount(access.userId);
        try {
          const snapshot = await deps.service.readTodayTasks({
            auth,
            requestedAccountId,
            savedAccountId,
          });
          return json(res, 200, snapshot);
        } catch (error) {
          return respondError(res, json, error);
        }
      }

      if (method === "PUT") {
        const parsedBody = selectAccountBodySchema.safeParse(await readBody(req));
        if (!parsedBody.success) {
          return json(res, 400, { error: "Invalid account selection", code: "invalid_request" });
        }
        try {
          const verified = await deps.service.verifySelection({
            auth,
            accountId: parsedBody.data.accountId,
          });
          deps.preferences.saveAccount(access.userId, verified.accountId);
          return json(res, 200, verified);
        } catch (error) {
          return respondError(res, json, error);
        }
      }

      return json(res, 405, { error: "Method not allowed", code: "invalid_request" });
    }

    if (method !== "POST") {
      return json(res, 405, { error: "Method not allowed", code: "invalid_request" });
    }

    const listId = decodeTaskSegment(actionMatch![1]!);
    const taskId = decodeTaskSegment(actionMatch![2]!);
    const action = actionMatch![3]! as "complete" | "reopen";
    if (!listId || !taskId) {
      return json(res, 400, { error: "Invalid task or task list identifier", code: "invalid_request" });
    }

    const parsedBody = completeBodySchema.safeParse(await readBody(req));
    if (!parsedBody.success) {
      return json(res, 400, { error: "A valid accountId is required", code: "invalid_request" });
    }

    try {
      const updated =
        action === "complete"
          ? await deps.service.completeTask({
              auth,
              accountId: parsedBody.data.accountId,
              listId,
              taskId,
            })
          : await deps.service.reopenTask({
              auth,
              accountId: parsedBody.data.accountId,
              listId,
              taskId,
            });
      return json(res, 200, {
        status: updated.status,
        ...(updated.completed ? { completed: updated.completed } : {}),
      });
    } catch (error) {
      return respondError(res, json, error);
    }
  };
}
