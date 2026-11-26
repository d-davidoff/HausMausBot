import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, ExternalLink, Loader2 } from "lucide-react";

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
import { Select } from "@/components/Select";
import { openExternalLink } from "@/lib/app-links";
import { connectorStatusMemory, preloadConnectedApps } from "@/lib/connected-apps";
import { accountToReconnect, hasActiveConnection } from "@/lib/connector-status";
import { t } from "@/lib/i18n";
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

function loadCachedSnapshot(day: string): DashboardTasksSnapshot | null {
  try {
    const raw = sessionStorage.getItem(TASKS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DashboardTasksSnapshot> | null;
    if (
      !parsed ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.date !== "string" ||
      parsed.date !== day ||
      !Array.isArray(parsed.lists)
    ) {
      return null;
    }
    return parsed as DashboardTasksSnapshot;
  } catch {
    return null;
  }
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

export function TodayTasks() {
  useActiveLocale();
  const dispatch = useStoreDispatch();
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const initialConn = useMemo(initialConnectionState, []);

  const [today, setToday] = useState(() => berlinTaskDay(new Date()));
  const [connected, setConnected] = useState<boolean | null>(initialConn.connected);
  const [inventoryReconnect, setInventoryReconnect] = useState(initialConn.reconnect);
  const [inventoryRefused, setInventoryRefused] = useState(initialConn.refused);
  const [initialCache] = useState<DashboardTasksSnapshot | null>(() =>
    initialConn.connected === false ? null : loadCachedSnapshot(today),
  );

  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(() =>
    initialCache?.accounts && initialCache.accounts.length > 1 ? initialCache.accountId : undefined,
  );
  const [availableAccounts, setAvailableAccounts] = useState<DashboardTaskAccount[]>(() => initialCache?.accounts ?? []);
  const [snapshot, setSnapshot] = useState<DashboardTasksSnapshot | null>(initialCache);
  const [loading, setLoading] = useState(() => initialConn.connected !== false && initialCache === null);
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
      if (!mountedRef.current || controller.signal.aborted) return null;
      if (!options.ignorePendingMutation && (mutationRef.current.pending > 0 || mutationRef.current.revision !== revisionAtStart)) {
        return null;
      }
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
      if (!mountedRef.current || controller.signal.aborted) return null;
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
      if (mountedRef.current && !background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    void preloadConnectedApps(true).then(({ services, authoritative, refused }) => {
      if (!active) return;
      const isRefused = Boolean(refused);
      setInventoryRefused(isRefused);
      if (authoritative && !isRefused) {
        const service = services.googletasks;
        const isConnected = hasActiveConnection(service);
        const needsReconnect = !isConnected && Boolean(accountToReconnect(service));
        setConnected(isConnected);
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
    if (!nextAccountId) return;
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
    } catch (error) {
      if (!mountedRef.current) return;
      setReadError(parseApiError(error, "stale_account_selection", "Couldn’t switch Google Tasks account."));
      setLoading(false);
      return;
    }
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
      if (!mountedRef.current) return;
      const parsed = parseApiError(
        error,
        "provider_write_failed",
        targetStatus === "completed" ? "Couldn’t complete that task." : "Couldn’t reopen that task.",
      );

      if (parsed.code === "ambiguous_timeout") {
        setCompletionError("Confirmation timed out. Checking Google Tasks…");
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

  return (
    <section aria-label={t("dashboard.tasks.title")} className="flex min-h-0 flex-col gap-3 text-end">
      <header className="flex flex-wrap items-center justify-between gap-2">
        {accountChoices.length > 1 && (
          <Select
            aria-label="Google Tasks account"
            variant="ghost"
            size="sm"
            value={snapshot?.accountId ?? selectedAccountId ?? ""}
            onChange={(event) => void handleSelectAccount(event.target.value)}
          >
            <option value="" disabled>
              Select account…
            </option>
            {accountChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
        )}

        <h2 className="ms-auto min-w-0 truncate text-xl font-semibold tracking-[-0.01em] text-ink">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-sm outline-offset-4 hover:underline focus-visible:outline-2"
            onClick={openGoogleTasks}
          >
            <span className="truncate">{t("dashboard.tasks.title")}</span>
            <ExternalLink aria-hidden="true" size={16} className="shrink-0" />
            <span className="sr-only">{t("dashboard.tasks.openGoogleTasks")}</span>
          </button>
        </h2>
      </header>

      {externalError && (
        <p role="status" className="text-sm text-ink-secondary">
          Couldn’t open Google Tasks.
        </p>
      )}

      {completionError && (
        <p role="alert" className="text-sm text-danger">
          {completionError}
        </p>
      )}

      {(connected === false || readError?.code === "not_connected" || readError?.code === "reconnect_required") && (
        <div role="status" className="flex flex-col items-end gap-2 text-sm text-ink-secondary">
          <p>
            {inventoryReconnect || readError?.code === "reconnect_required"
              ? "Google Tasks needs to be reconnected."
              : "Google Tasks isn’t connected."}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!inventoryRefused && (
              <button type="button" className="ui-button ui-button-md ui-button-pill" onClick={openApps}>
                Open Apps
              </button>
            )}
            <button
              type="button"
              className="ui-button ui-button-md ui-button-pill"
              onClick={retryRead}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {connected !== false &&
        readError &&
        (readError.code === "account_selection_required" || readError.code === "stale_account_selection") && (
          <div role="status" className="flex flex-col items-end gap-2 text-sm text-ink-secondary">
            <p>{readError.message}</p>
          </div>
        )}

      {connected !== false &&
        readError &&
        (readError.code === "connection_access_denied" || readError.code === "forbidden") && (
          <p role="alert" className="text-sm text-danger">
            {readError.message}
          </p>
        )}

      {connected !== false &&
        readError &&
        readError.code !== "not_connected" &&
        readError.code !== "reconnect_required" &&
        readError.code !== "account_selection_required" &&
        readError.code !== "stale_account_selection" &&
        readError.code !== "connection_access_denied" &&
        readError.code !== "forbidden" && (
          <div role={snapshot ? "status" : "alert"} className="flex flex-wrap items-center justify-end gap-2 text-sm text-ink-secondary">
            <span>
              {snapshot
                ? "Couldn’t refresh tasks. Showing previously loaded tasks."
                : readError.message}
            </span>
            <button
              type="button"
              className="underline hover:text-ink"
              onClick={retryRead}
            >
              Try again
            </button>
          </div>
        )}

      {connected !== false && loading && !snapshot && !readError && (
        <p role="status" className="text-sm text-ink-secondary">
          Loading tasks…
        </p>
      )}

      {connected !== false && snapshot && !readError && visibleLists.length === 0 && (
        <p className="text-sm text-ink-secondary">No tasks due today</p>
      )}

      {snapshot && visibleLists.length > 0 && (
        <div className="flex flex-col gap-4">
          {visibleLists.map((list) => (
            <div key={list.id} className="flex flex-col gap-2">
              <h3 className="truncate text-end text-sm font-medium text-ink-secondary" title={list.title}>
                {list.title}
              </h3>
              <ul aria-label={list.title} className="flex flex-col gap-1.5">
                {list.items.map((item) => {
                  const key = rowPendingKey(snapshot.accountId, list.id, item.id);
                  const isPending = pendingRows.has(key);
                  const isUnconfirmed = unconfirmedRows.has(key);
                  const isCompleted = item.status === "completed";
                  return (
                    <li key={`${list.id}:${item.id}`} data-task-row={`${list.id}:${item.id}`}>
                      <button
                        type="button"
                        aria-label={isCompleted ? `Mark ${item.title} incomplete` : `Complete ${item.title}`}
                        aria-pressed={isCompleted}
                        title={isUnconfirmed ? "Refresh tasks to confirm status before retrying" : item.title}
                        disabled={isPending || isUnconfirmed}
                        aria-busy={isPending}
                        onClick={() =>
                          void handleToggleTask(
                            list.id,
                            item.id,
                            snapshot.accountId,
                            isCompleted ? "needsAction" : "completed",
                          )
                        }
                        className="group flex min-h-9 touch:min-h-11 w-full items-center justify-end gap-3 rounded-lg px-2.5 py-1.5 text-end transition-colors duration-[120ms] hover:bg-ink/[0.04] active:bg-ink/[0.06] disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none"
                      >
                        {item.challengeTime && (
                          <time
                            dateTime={item.challengeTime}
                            title="Preferred time (Berlin)"
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-[13px] font-medium leading-[18px] text-ink-secondary tabular-nums"
                          >
                            <Clock aria-hidden="true" size={14} />
                            <span>{item.challengeTime}</span>
                            {item.challengeMinutes !== undefined && <span>· {item.challengeMinutes}m</span>}
                          </time>
                        )}

                        <span
                          className={
                            "min-w-0 flex-1 truncate text-end text-[15px] leading-[22px] " +
                            (isCompleted ? "font-normal text-ink-tertiary line-through" : "font-medium text-ink")
                          }
                        >
                          {item.title}
                        </span>

                        <span
                          aria-label={isCompleted ? "Completed" : undefined}
                          aria-hidden={isCompleted ? undefined : true}
                          className={
                            "flex size-7 shrink-0 items-center justify-center rounded-lg border border-hairline transition-colors duration-[120ms] motion-reduce:transition-none " +
                            (isCompleted
                              ? "bg-ink/[0.06] text-success group-hover:bg-ink/[0.1]"
                              : "bg-inset text-ink group-hover:bg-ink/[0.06] group-active:bg-ink/[0.08]")
                          }
                        >
                          {isPending ? (
                            <Loader2 aria-hidden="true" size={16} className="animate-spin motion-reduce:animate-none" />
                          ) : isCompleted ? (
                            <Check aria-hidden="true" size={16} />
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
