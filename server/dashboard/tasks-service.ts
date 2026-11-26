import {
  berlinTaskDay,
  filterTasksForBerlinDay,
  type DashboardTaskAccount,
  type DashboardTaskCompletionResponse,
  type DashboardTaskItem,
  type DashboardTaskList,
  type DashboardTasksErrorCode,
  type DashboardTasksSnapshot,
} from "../../shared/dashboard-tasks.ts";
import * as composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import { createConnectedReads, SourceError, type GoogleTaskItem } from "../connected-reads.ts";
import type { RequestAuth } from "../request-auth.ts";

const CHALLENGE_MARKER = /^\[Family-OS challenge: ([a-f0-9]{64}\/\d{4}-\d{2}-\d{2})\]\r?$/m;
const CHALLENGE_TIMING = /^Day \d+ of \d+ · ((?:[01]\d|2[0-3]):[0-5]\d) Europe\/Berlin · (\d+) min\r?$/m;
const ENGAGEMENT_COUNT =
  /^\s*\d[\d.,\s]*(?:(?:[kmb]|t(?:sd)?\.|mio\.|mrd\.)\s*)?(?:views?|reactions?|likes?|aufrufe?|reaktionen?)\s*$/i;

export class DashboardTasksError extends Error {
  readonly code: DashboardTasksErrorCode;
  readonly status: number;
  readonly accounts?: DashboardTaskAccount[];

  constructor(
    code: DashboardTasksErrorCode,
    status: number,
    message: string,
    accounts?: DashboardTaskAccount[],
  ) {
    super(message);
    this.name = "DashboardTasksError";
    this.code = code;
    this.status = status;
    this.accounts = accounts;
  }
}

export function parseChallengeNotes(notes?: string | null): {
  isChallenge: boolean;
  challengeTime?: string;
  challengeMinutes?: number;
} {
  if (!notes || !CHALLENGE_MARKER.test(notes)) {
    return { isChallenge: false };
  }
  const timing = notes.match(CHALLENGE_TIMING);
  if (!timing) {
    return { isChallenge: true };
  }
  return {
    isChallenge: true,
    challengeTime: timing[1],
    challengeMinutes: Number(timing[2]),
  };
}

export function cleanChallengeTitle(title: string): string {
  const separator = title.indexOf("|");
  if (separator < 0) return title;
  const stats = title.slice(0, separator).trim().split(/[·•]/);
  const name = title.slice(separator + 1).trim();
  return name && stats.every((stat) => ENGAGEMENT_COUNT.test(stat)) ? name : title;
}

function toDashboardTaskItem(task: GoogleTaskItem): DashboardTaskItem {
  const challenge = parseChallengeNotes(task.notes);
  return {
    id: task.id,
    listId: task.listId,
    title: challenge.isChallenge ? cleanChallengeTitle(task.title) : task.title,
    status: task.status,
    ...(task.due ? { due: task.due } : {}),
    ...(task.completed ? { completed: task.completed } : {}),
    isChallenge: challenge.isChallenge,
    ...(challenge.challengeTime ? { challengeTime: challenge.challengeTime } : {}),
    ...(challenge.challengeMinutes !== undefined ? { challengeMinutes: challenge.challengeMinutes } : {}),
  };
}

function toAccountChoice(entry: composio.ConnectedAccountSummary): DashboardTaskAccount {
  return {
    id: entry.id,
    label: entry.alias?.trim() || entry.id,
    status: entry.status,
  };
}

function classifyProviderFailure(error: unknown, mode: "read" | "write", accounts?: DashboardTaskAccount[]): DashboardTasksError {
  if (error instanceof DashboardTasksError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const sourceError = error instanceof SourceError ? error : null;

  if (sourceError?.timedOut) {
    return mode === "write"
      ? new DashboardTasksError(
          "ambiguous_timeout",
          504,
          "Google Tasks timed out before confirming completion. Refresh tasks before trying again.",
        )
      : new DashboardTasksError("provider_read_failed", 504, "Google Tasks timed out while loading tasks.");
  }

  if (mode === "write" && sourceError?.toolError) {
    if (/access_token_scope_insufficient|insufficient authentication scopes|insufficientpermissions|insufficient scope|tasks\.readonly|403|forbidden/.test(message)) {
      return new DashboardTasksError(
        "insufficient_write_scope",
        403,
        "Google Tasks does not have permission to complete tasks. Reconnect Google Tasks with write access.",
      );
    }
    if (/invalid[_ ]grant|unauthori[sz]ed|unauthenticated|expired|401|reconnect/.test(message)) {
      return new DashboardTasksError(
        "reconnect_required",
        503,
        "Google Tasks needs to be reconnected.",
      );
    }
    if (/404|not found|requested entity/.test(message)) {
      return new DashboardTasksError(
        "task_not_found",
        404,
        "This task or task list was not found in Google Tasks.",
      );
    }
  }

  if (/invalid[_ ]grant|unauthori[sz]ed|unauthenticated|expired|401|reconnect/.test(message)) {
    return new DashboardTasksError("reconnect_required", 503, "Google Tasks needs to be reconnected.");
  }
  if (/403|forbidden|permission|access denied|insufficient/.test(message)) {
    return mode === "write"
      ? new DashboardTasksError(
          "insufficient_write_scope",
          403,
          "Google Tasks does not have permission to complete tasks. Reconnect Google Tasks with write access.",
        )
      : new DashboardTasksError("connection_access_denied", 503, "Google Tasks access was denied.");
  }
  if (/shortened|too large|size limit/.test(message)) {
    return new DashboardTasksError("response_too_large", 503, "Google Tasks returned more data than supported.");
  }
  if (/multiple .* accounts connected/i.test(message) || (sourceError?.severalAccounts && (accounts?.length ?? 0) > 1)) {
    return new DashboardTasksError(
      "account_selection_required",
      409,
      "Select a Google Tasks account.",
      accounts,
    );
  }
  if (mode === "write") {
    return new DashboardTasksError(
      "provider_write_failed",
      sourceError?.transport ? 502 : 503,
      "Could not reach Google Tasks to complete this task.",
    );
  }
  return new DashboardTasksError("provider_read_failed", 503, "Google Tasks could not be read.");
}

export interface DashboardTasksServiceDeps {
  getCfg: () => AppConfig;
  now?: () => Date;
  readTimeoutMs?: number;
  canAccessConnection?: (input: {
    auth: RequestAuth;
    accountId: string;
    mode: "read" | "write";
  }) => Promise<boolean> | boolean;
  inventory?: (cfg: AppConfig) => Promise<composio.ConnectedServicesInventory>;
  relay?: (
    cfg: AppConfig,
    payload: unknown,
    transportSessionId: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
  configured?: (cfg: AppConfig) => boolean;
}

export function createDashboardTasksService(deps: DashboardTasksServiceDeps) {
  const getNow = deps.now ?? (() => new Date());
  const isConfigured = deps.configured ?? ((cfg: AppConfig) => composio.configured(cfg));
  const loadInventory = deps.inventory ?? ((cfg: AppConfig) => composio.sharedConnectedInventory(cfg, { fresh: true }));
  const relayMcp = deps.relay ?? ((cfg: AppConfig, payload: unknown, transportSessionId: string | undefined, signal: AbortSignal) =>
    composio.relayMcp(cfg, payload as never, transportSessionId, undefined, signal));

  async function resolveConnection(input: {
    auth: RequestAuth;
    requestedAccountId?: string;
    savedAccountId?: string;
    mode: "read" | "write";
  }) {
    const cfg = deps.getCfg();
    if (!isConfigured(cfg)) {
      throw new DashboardTasksError("tasks_unavailable", 503, "Google Tasks is unavailable.");
    }
    let services: composio.ConnectedServicesInventory["services"];
    try {
      ({ services } = await loadInventory(cfg));
    } catch (error) {
      throw classifyProviderFailure(error, input.mode);
    }
    const service = services.googletasks;
    if (!service?.connected) {
      const needsReconnect = (service?.accounts ?? []).some(
        (entry) => !/^active$/i.test(entry.status) && !/^(initiated|initializing|pending)$/i.test(entry.status),
      );
      if (needsReconnect || (service?.status && /^(expired|failed|revoked)$/i.test(service.status))) {
        throw new DashboardTasksError("reconnect_required", 503, "Google Tasks needs to be reconnected.");
      }
      throw new DashboardTasksError("not_connected", 503, "Google Tasks is not connected.");
    }

    const rawAccounts = service.accounts ?? [];
    const activeAccounts = rawAccounts.filter((entry) => /^active$/i.test(entry.status));
    if (rawAccounts.length > 0 && activeAccounts.length === 0) {
      throw new DashboardTasksError("reconnect_required", 503, "Google Tasks has no active account.");
    }

    const qualifyingAccounts: composio.ConnectedAccountSummary[] = [];
    for (const entry of activeAccounts) {
      const allowed = deps.canAccessConnection
        ? await deps.canAccessConnection({ auth: input.auth, accountId: entry.id, mode: input.mode })
        : true;
      if (allowed) qualifyingAccounts.push(entry);
    }

    if (activeAccounts.length > 0 && qualifyingAccounts.length === 0) {
      throw new DashboardTasksError(
        "connection_access_denied",
        403,
        "You do not have access to this Google Tasks connection.",
      );
    }

    const choices = qualifyingAccounts.map(toAccountChoice);
    let selectedAccount: string | undefined;
    let selectedAccountId: string;

    if (qualifyingAccounts.length === 0) {
      const allowed = deps.canAccessConnection
        ? await deps.canAccessConnection({ auth: input.auth, accountId: "default", mode: input.mode })
        : true;
      if (!allowed) {
        throw new DashboardTasksError(
          "connection_access_denied",
          403,
          "You do not have access to this Google Tasks connection.",
        );
      }
      if (input.requestedAccountId !== undefined && input.requestedAccountId !== "default") {
        throw new DashboardTasksError(
          "stale_account_selection",
          409,
          "The selected Google Tasks account is no longer available.",
          choices,
        );
      }
      selectedAccount = undefined;
      selectedAccountId = "default";
    } else if (qualifyingAccounts.length === 1) {
      const only = qualifyingAccounts[0]!;
      if (input.requestedAccountId !== undefined && input.requestedAccountId !== only.id) {
        throw new DashboardTasksError(
          "stale_account_selection",
          409,
          "The selected Google Tasks account is no longer available.",
          choices,
        );
      }
      selectedAccount = only.id;
      selectedAccountId = only.id;
    } else {
      const candidate = input.requestedAccountId ?? input.savedAccountId;
      if (!candidate) {
        throw new DashboardTasksError(
          "account_selection_required",
          409,
          "Choose a Google Tasks account.",
          choices,
        );
      }
      const matched = qualifyingAccounts.find((entry) => entry.id === candidate);
      if (!matched) {
        throw new DashboardTasksError(
          "stale_account_selection",
          409,
          "The selected Google Tasks account is no longer available.",
          choices,
        );
      }
      selectedAccount = matched.id;
      selectedAccountId = matched.id;
    }

    const reads = createConnectedReads({
      connected: async () => ({ googletasks: true }),
      relay: (payload, transportSessionId, signal) => relayMcp(cfg, payload, transportSessionId, signal),
      ...(deps.readTimeoutMs !== undefined ? { readTimeoutMs: deps.readTimeoutMs } : {}),
    }).session();

    return {
      reads,
      account: selectedAccount,
      accountId: selectedAccountId,
      accounts: choices,
    };
  }

  async function patchTaskStatus(input: {
    auth: RequestAuth;
    accountId: string;
    listId: string;
    taskId: string;
    status: "completed" | "needsAction";
  }): Promise<DashboardTaskCompletionResponse> {
    const resolved = await resolveConnection({
      auth: input.auth,
      requestedAccountId: input.accountId,
      mode: "write",
    });

    try {
      const result = await resolved.reads.completeTask({
        account: resolved.account,
        listId: input.listId,
        taskId: input.taskId,
        status: input.status,
      });
      if (input.status === "completed") {
        return {
          status: "completed",
          completed: result.completed ?? getNow().toISOString(),
        };
      }
      return { status: "needsAction" };
    } catch (error) {
      throw classifyProviderFailure(error, "write", resolved.accounts);
    }
  }

  return {
    async verifySelection(input: { auth: RequestAuth; accountId: string }): Promise<{ accountId: string; accounts: DashboardTaskAccount[] }> {
      const resolved = await resolveConnection({
        auth: input.auth,
        requestedAccountId: input.accountId,
        mode: "read",
      });
      return { accountId: resolved.accountId, accounts: resolved.accounts };
    },

    async readTodayTasks(input: {
      auth: RequestAuth;
      requestedAccountId?: string;
      savedAccountId?: string;
    }): Promise<DashboardTasksSnapshot> {
      const resolved = await resolveConnection({
        auth: input.auth,
        requestedAccountId: input.requestedAccountId,
        savedAccountId: input.savedAccountId,
        mode: "read",
      });

      let rawLists: Awaited<ReturnType<typeof resolved.reads.allTasks>>;
      try {
        rawLists = await resolved.reads.allTasks(resolved.account);
      } catch (error) {
        throw classifyProviderFailure(error, "read", resolved.accounts);
      }

      const now = getNow();
      const today = berlinTaskDay(now);
      const lists: DashboardTaskList[] = rawLists.map(({ list, items }) => ({
        id: list.id,
        title: list.title,
        items: items.map(toDashboardTaskItem),
      }));

      return {
        accountId: resolved.accountId,
        ...(resolved.accounts.length > 1 ? { accounts: resolved.accounts } : {}),
        date: today,
        lists: filterTasksForBerlinDay(lists, today),
        updatedAt: now.toISOString(),
        source: "google",
      };
    },

    async completeTask(input: {
      auth: RequestAuth;
      accountId: string;
      listId: string;
      taskId: string;
    }): Promise<DashboardTaskCompletionResponse> {
      return patchTaskStatus({ ...input, status: "completed" });
    },

    async reopenTask(input: {
      auth: RequestAuth;
      accountId: string;
      listId: string;
      taskId: string;
    }): Promise<DashboardTaskCompletionResponse> {
      return patchTaskStatus({ ...input, status: "needsAction" });
    },
  };
}

export type DashboardTasksService = ReturnType<typeof createDashboardTasksService>;
