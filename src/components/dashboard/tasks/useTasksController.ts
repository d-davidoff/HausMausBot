import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WidgetSetup } from "../widget";

import {
  addTaskDays,
  berlinTaskDay,
  berlinTaskMidnight,
  filterTasksForBerlinDay,
  type DashboardTaskAccount,
  type DashboardTaskCompletionResponse,
  type DashboardTasksErrorCode,
  type DashboardTasksSnapshot,
} from "../../../../shared/dashboard-tasks";
import { openExternalLink } from "@/lib/app-links";
import { connectorStatusMemory, preloadConnectedApps } from "@/lib/connected-apps";
import { accountToReconnect, hasActiveConnection } from "@/lib/connector-status";
import { useActiveLocale } from "@/lib/use-active-locale";
import { ApiError, api } from "@/state/api";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";

const REFRESH_MS = 5 * 60 * 1000;
const TASKS_STORAGE_KEY = "openmausbot.dashboard.tasks";

interface TasksReadErrorState {
  code: DashboardTasksErrorCode;
  message: string;
  accounts?: DashboardTaskAccount[];
}

function saveCachedSnapshot(snapshot: DashboardTasksSnapshot): void {
  try {
    sessionStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
  }
}

function clearCachedSnapshot(): void {
  try {
    sessionStorage.removeItem(TASKS_STORAGE_KEY);
  } catch {
  }
}

function isErrorCode(value: unknown): value is DashboardTasksErrorCode {
  return typeof value === "string";
}

function parseApiError(error: unknown, fallbackCode: DashboardTasksErrorCode, fallbackMessage: string): TasksReadErrorState {
  if (error instanceof ApiError) {
    const body = error.body;
    const code = isErrorCode(body?.code) ? body.code : fallbackCode;
    const accounts = Array.isArray(body?.accounts)
      ? (body.accounts as DashboardTaskAccount[]).filter(
          (entry) => entry && typeof entry.id === "string" && typeof entry.label === "string",
        )
      : undefined;
    const message = typeof body?.error === "string" && body.error.trim() ? body.error : error.message || fallbackMessage;
    return { code, message, ...(accounts ? { accounts } : {}) };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return {
      code: fallbackCode === "provider_write_failed" ? "ambiguous_timeout" : fallbackCode,
      message: fallbackCode === "provider_write_failed"
        ? "Google Tasks timed out before confirming completion."
        : fallbackMessage,
    };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function initialConnectionState(): { connected: boolean | null; reconnect: boolean; refused: boolean } {
  const inventory = connectorStatusMemory();
  if (!inventory?.authoritative) return { connected: null, reconnect: false, refused: false };
  const service = inventory.services.googletasks;
  return {
    connected: hasActiveConnection(service),
    reconnect: Boolean(accountToReconnect(service)),
    refused: false,
  };
}

function rowPendingKey(accountId: string, listId: string, taskId: string): string {
  return `${accountId}\0${listId}\0${taskId}`;
}

export function useTasksController() {
  useActiveLocale();
  const dispatch = useStoreDispatch();
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const initialConn = useMemo(initialConnectionState, []);
  const [verified, setVerified] = useState(false);
  const [accountSaveError, setAccountSaveError] = useState<string | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const savingAccountRef = useRef(false);
  const failedAccountRef = useRef(false);
  const accountEpoch = useRef(0);

  const [today, setToday] = useState(() => berlinTaskDay(new Date()));
  const [connected, setConnected] = useState<boolean | null>(initialConn.connected);
  const [inventoryReconnect, setInventoryReconnect] = useState(initialConn.reconnect);
  const [inventoryRefused, setInventoryRefused] = useState(initialConn.refused);
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  const [availableAccounts, setAvailableAccounts] = useState<DashboardTaskAccount[]>([]);
  const [snapshot, setSnapshot] = useState<DashboardTasksSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<TasksReadErrorState | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [pendingRows, setPendingRows] = useState<ReadonlySet<string>>(() => new Set());
  const [unconfirmedRows, setUnconfirmedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [externalError, setExternalError] = useState(false);

  const mountedRef = useRef(true);
  const inFlightReadRef = useRef<AbortController | null>(null);
  const mutationRef = useRef({ revision: 0, pending: 0 });
  const selectedAccountRef = useRef<string | undefined>(undefined);
  const snapshotRef = useRef<DashboardTasksSnapshot | null>(null);
  const todayRef = useRef(today);

  selectedAccountRef.current = selectedAccountId;
  snapshotRef.current = snapshot;
  todayRef.current = today;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightReadRef.current?.abort();
    };
  }, []);

  const fetchTasks = useCallback(async (options: {
    background?: boolean;
    accountId?: string;
    ignorePendingMutation?: boolean;
  } = {}): Promise<DashboardTasksSnapshot | null> => {
    if (savingAccountRef.current || failedAccountRef.current) return null;
    const epoch = accountEpoch.current;
    const background = options.background === true;
    const requestedAccount = options.accountId ?? selectedAccountRef.current;

    if (background && document.visibilityState === "hidden") return null;
    if (!options.ignorePendingMutation && mutationRef.current.pending > 0) return null;

    if (!background) {
      inFlightReadRef.current?.abort();
    } else if (inFlightReadRef.current) {
      return null;
    }

    const controller = new AbortController();
    inFlightReadRef.current = controller;
    if (!background && !snapshotRef.current) {
      setLoading(true);
    }

    const revisionAtStart = mutationRef.current.revision;
    const query = requestedAccount ? `?accountId=${encodeURIComponent(requestedAccount)}` : "";

    try {
      const result = await api<DashboardTasksSnapshot>(`/api/dashboard/tasks${query}`, {
        background,
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted || epoch !== accountEpoch.current) return null;
      if (!options.ignorePendingMutation && (mutationRef.current.pending > 0 || mutationRef.current.revision !== revisionAtStart)) {
        return null;
      }
      setVerified(true);
      setSnapshot(result);
      saveCachedSnapshot(result);
      todayRef.current = result.date;
      setToday(result.date);
      setAvailableAccounts(result.accounts ?? []);
      setSelectedAccountId(result.accounts && result.accounts.length > 1 ? result.accountId : undefined);
      setReadError(null);
      setConnected(true);
      setInventoryReconnect(false);
      setUnconfirmedRows((current) => {
        const prefix = `${result.accountId}\0`;
        let changed = false;
        const next = new Set<string>();
        for (const entry of current) {
          if (entry.startsWith(prefix)) {
            changed = true;
          } else {
            next.add(entry);
          }
        }
        if (changed) {
          setCompletionError(null);
        }
        return changed ? next : current;
      });
      return result;
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || epoch !== accountEpoch.current) return null;
      const parsed = parseApiError(error, "provider_read_failed", "Couldn’t load tasks.");
      if (parsed.accounts) {
        setAvailableAccounts(parsed.accounts);
      }
      if (
        parsed.code === "not_connected" ||
        parsed.code === "reconnect_required" ||
        parsed.code === "connection_access_denied" ||
        parsed.code === "forbidden" ||
        parsed.code === "account_selection_required" ||
        parsed.code === "stale_account_selection"
      ) {
        setSnapshot(null);
        clearCachedSnapshot();
        if (parsed.code === "stale_account_selection") {
          setSelectedAccountId(undefined);
        }
        if (parsed.code === "not_connected" || parsed.code === "reconnect_required") {
          setConnected(false);
          setAvailableAccounts([]);
          setInventoryReconnect(parsed.code === "reconnect_required");
        }
      }
      setReadError(parsed);
      return null;
    } finally {
      if (inFlightReadRef.current === controller) {
        inFlightReadRef.current = null;
      }
      if (mountedRef.current && !background && !controller.signal.aborted && epoch === accountEpoch.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    accountEpoch.current++;
    inFlightReadRef.current?.abort();
    setVerified(false);
    setSnapshot(null);
    snapshotRef.current = null;
    selectedAccountRef.current = undefined;
    setSelectedAccountId(undefined);
    clearCachedSnapshot();
    void preloadConnectedApps(true).then(({ services, authoritative, refused }) => {
      if (!active) return;
      const isRefused = Boolean(refused);
      setInventoryRefused(isRefused);
      if (authoritative && !isRefused) {
        const service = services.googletasks;
        const isConnected = hasActiveConnection(service);
        const needsReconnect = !isConnected && Boolean(accountToReconnect(service));
        setConnected(isConnected);
        if (!isConnected) setVerified(true);
        setInventoryReconnect(needsReconnect);
        if (!isConnected) {
          setSnapshot(null);
          setAvailableAccounts([]);
          setSelectedAccountId(undefined);
          clearCachedSnapshot();
          setLoading(false);
          setReadError(null);
          return;
        }
      } else {
        setConnected(null);
        setInventoryReconnect(false);
      }
      void fetchTasks({ background: false });
    });
    return () => {
      active = false;
    };
  }, [pluginsOpen, fetchTasks]);

  useEffect(() => {
    if (connected === false) return;

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleBackgroundRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void fetchTasks({ background: true }).finally(scheduleBackgroundRefresh);
      }, REFRESH_MS);
    };

    const scheduleMidnight = () => {
      clearTimeout(midnightTimer);
      const now = new Date();
      const currentDay = berlinTaskDay(now);
      if (todayRef.current !== currentDay) {
        todayRef.current = currentDay;
        setToday(currentDay);
        setSnapshot(null);
        clearCachedSnapshot();
        void fetchTasks({ background: false });
      }
      const nextMidnightMs = Date.parse(berlinTaskMidnight(addTaskDays(currentDay, 1))) - now.getTime();
      midnightTimer = setTimeout(scheduleMidnight, Math.max(1000, nextMidnightMs));
    };

    scheduleBackgroundRefresh();
    scheduleMidnight();

    const onVisible = () => {
      scheduleMidnight();
      if (document.visibilityState === "visible") {
        void fetchTasks({ background: true });
      }
    };
    const onOnline = () => {
      void fetchTasks({ background: true });
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(refreshTimer);
      clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [connected, fetchTasks]);

  const setRowPending = (key: string, pending: boolean) => {
    setPendingRows((current) => {
      const next = new Set(current);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleSelectAccount = async (nextAccountId: string) => {
    if (!nextAccountId || savingAccountRef.current) return;
    const epoch = ++accountEpoch.current;
    inFlightReadRef.current?.abort();
    savingAccountRef.current = true;
    setSavingAccount(true);
    setAccountSaveError(null);
    failedAccountRef.current = false;
    setVerified(false);
    selectedAccountRef.current = nextAccountId;
    snapshotRef.current = null;
    setCompletionError(null);
    setReadError(null);
    setSelectedAccountId(nextAccountId);
    setSnapshot(null);
    clearCachedSnapshot();
    setLoading(true);
    try {
      await api("/api/dashboard/tasks", {
        method: "PUT",
        body: JSON.stringify({ accountId: nextAccountId }),
      });
    } catch {
      if (!mountedRef.current || epoch !== accountEpoch.current) return;
      failedAccountRef.current = true;
      setAccountSaveError(nextAccountId);
      setLoading(false);
      return;
    } finally {
      savingAccountRef.current = false;
      if (mountedRef.current) setSavingAccount(false);
    }
    if (!mountedRef.current || epoch !== accountEpoch.current) return;
    await fetchTasks({ background: false, accountId: nextAccountId, ignorePendingMutation: true });
  };

  const handleToggleTask = async (
    listId: string,
    taskId: string,
    rowAccountId: string,
    targetStatus: "completed" | "needsAction",
  ) => {
    const key = rowPendingKey(rowAccountId, listId, taskId);
    if (pendingRows.has(key) || unconfirmedRows.has(key)) return;

    mutationRef.current.pending += 1;
    mutationRef.current.revision += 1;
    setRowPending(key, true);
    setCompletionError(null);

    const action = targetStatus === "completed" ? "complete" : "reopen";

    try {
      const result = await api<DashboardTaskCompletionResponse>(
        `/api/dashboard/tasks/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ accountId: rowAccountId }),
        },
      );
      if (!mountedRef.current) return;
      setSnapshot((current) => {
        if (!current || current.accountId !== rowAccountId) return current;
        const next: DashboardTasksSnapshot = {
          ...current,
          lists: current.lists.map((list) =>
            list.id !== listId
              ? list
              : {
                  ...list,
                  items: list.items.map((item) => {
                    if (item.id !== taskId) return item;
                    const { completed: _prevCompleted, ...base } = item;
                    return {
                      ...base,
                      status: result.status,
                      ...(result.completed ? { completed: result.completed } : {}),
                    };
                  }),
                },
          ),
        };
        saveCachedSnapshot(next);
        return next;
      });
    } catch (error) {
      if (!mountedRef.current || (selectedAccountRef.current && selectedAccountRef.current !== rowAccountId)) return;
      const parsed = parseApiError(
        error,
        "provider_write_failed",
        targetStatus === "completed" ? "Couldn’t complete that task." : "Couldn’t reopen that task.",
      );

      if (parsed.code === "ambiguous_timeout") {
        setCompletionError("Confirmation timed out. Checking Google Tasks…");
        if (selectedAccountRef.current && selectedAccountRef.current !== rowAccountId) return;
        const refreshed = await fetchTasks({
          background: false,
          accountId: rowAccountId,
          ignorePendingMutation: true,
        });
        if (!mountedRef.current) return;
        if (!refreshed) {
          setUnconfirmedRows((current) => new Set(current).add(key));
          setCompletionError("Confirmation timed out and task status couldn’t be refreshed. Refresh tasks before trying again.");
        } else {
          const confirmed = refreshed.lists
            .find((list) => list.id === listId)
            ?.items.find((item) => item.id === taskId)?.status === targetStatus;
          setCompletionError(
            confirmed
              ? null
              : "Confirmation timed out. Verify the task status and try again if needed.",
          );
        }
      } else if (parsed.code === "stale_account_selection" || parsed.code === "account_selection_required") {
        setSnapshot(null);
        clearCachedSnapshot();
        setSelectedAccountId(undefined);
        setReadError(parsed);
      } else if (parsed.code === "reconnect_required" || parsed.code === "not_connected") {
        setSnapshot(null);
        clearCachedSnapshot();
        setConnected(false);
        setInventoryReconnect(parsed.code === "reconnect_required");
        setReadError(parsed);
      } else if (parsed.code === "connection_access_denied" || parsed.code === "forbidden") {
        setSnapshot(null);
        clearCachedSnapshot();
        setReadError(parsed);
      } else {
        setCompletionError(parsed.message);
      }
    } finally {
      mutationRef.current.revision += 1;
      mutationRef.current.pending = Math.max(0, mutationRef.current.pending - 1);
      if (mountedRef.current) {
        setRowPending(key, false);
      }
    }
  };

  const visibleLists = useMemo(
    () => (snapshot ? filterTasksForBerlinDay(snapshot.lists, today) : []),
    [snapshot, today],
  );

  const accountChoices = availableAccounts.length > 0 ? availableAccounts : (snapshot?.accounts ?? readError?.accounts ?? []);
  const retryRead = () => {
    if (accountSaveError) { void handleSelectAccount(accountSaveError); return; }
    setReadError(null);
    setConnected((current) => (current === false ? null : current));
    void fetchTasks({ background: false });
  };

  const openApps = () => dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  const openGoogleTasks = () => {
    void openExternalLink("https://calendar.google.com/calendar/u/0/r/tasks")
      .then(() => setExternalError(false))
      .catch(() => setExternalError(true));
  };

  const needsSetup = connected === false || ["not_connected", "reconnect_required", "account_selection_required", "stale_account_selection"].includes(readError?.code ?? "");
  const setup: WidgetSetup = savingAccount ? "checking" : accountSaveError ? "unavailable"
    : needsSetup && (verified || readError) ? "needs-setup" : readError ? "unavailable"
    : verified && snapshot ? "ready" : "checking";


  return { accountChoices, snapshot, selectedAccountId, savingAccount, handleSelectAccount, openGoogleTasks, needsSetup, accountSaveError, retryRead, externalError, completionError, connected, readError, inventoryReconnect, inventoryRefused, openApps, loading, visibleLists, pendingRows, unconfirmedRows, handleToggleTask, setup };
}
