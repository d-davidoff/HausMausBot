import { useEffect, useState } from "react";
import type { CountdownSnapshot } from "../../../../shared/dashboard-countdowns";
import { connectorStatusMemory, preloadConnectedApps } from "@/lib/connected-apps";
import { hasActiveConnection } from "@/lib/connector-status";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";

const REFRESH_MS = 5 * 60 * 1000;
const SNAPSHOT_STORAGE_KEY = "openmausbot.dashboard.countdowns";

const updateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function loadCachedSnapshot(): CountdownSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveCachedSnapshot(snapshot: CountdownSnapshot): void {
  try {
    sessionStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore
  }
}

function connectedNow(): boolean | null {
  const inventory = connectorStatusMemory();
  return inventory?.authoritative ? hasActiveConnection(inventory.services.googlecalendar) : null;
}

export function CountdownList() {
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const [connected, setConnected] = useState(connectedNow);
  const [snapshot, setSnapshot] = useState<CountdownSnapshot | null>(loadCachedSnapshot);
  const [loading, setLoading] = useState(() => loadCachedSnapshot() === null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    void preloadConnectedApps(true).then(({ services, authoritative, refused }) => {
      if (!current) return;
      const isConnected = authoritative && !refused && hasActiveConnection(services.googlecalendar);
      setConnected(isConnected);
      if (!isConnected) {
        setSnapshot(null);
        setLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [pluginsOpen]);

  useEffect(() => {
    if (connected === false) {
      setLoading(false);
      return;
    }

    let active = true;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh(background = false) {
      if (!active || (background && document.visibilityState !== "visible") || pending) return;
      clearTimeout(timer);
      const request = new AbortController();
      pending = request;

      if (!background && !snapshot) {
        setLoading(true);
      }

      try {
        const result = await api<CountdownSnapshot>("/api/dashboard/countdowns?windowDays=30", {
          background,
          signal: request.signal,
        });
        if (!active) return;
        setSnapshot(result);
        saveCachedSnapshot(result);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      } finally {
        pending = null;
        if (active) {
          setLoading(false);
          timer = setTimeout(() => refresh(true), REFRESH_MS);
        }
      }
    }

    function showOffline() {
      setFailed(true);
    }

    void refresh(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const onOnline = () => void refresh(true);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", showOffline);

    return () => {
      active = false;
      pending?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", showOffline);
    };
  }, [connected, reload]);

  const retry = () => {
    setLoading(true);
    setFailed(false);
    setReload((v) => v + 1);
  };

  return (
    <CountdownContent
      snapshot={snapshot}
      loading={loading}
      failed={failed}
      connected={connected}
      onRetry={retry}
    />
  );
}

export function CountdownContent({
  snapshot,
  loading = false,
  failed = false,
  connected = true,
  onRetry,
}: {
  snapshot: CountdownSnapshot | null;
  loading?: boolean;
  failed?: boolean;
  connected?: boolean | null;
  onRetry?: () => void;
}) {
  if (connected === false) {
    return (
      <div role="status" className="rounded-xl border border-hairline bg-card p-3 text-sm text-ink-secondary">
        Google Calendar is disconnected. Connect in Settings to view countdowns.
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div aria-label="Loading countdowns" className="flex w-full min-w-0 gap-2.5 overflow-x-auto pb-1.5">
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className="flex w-28 sm:w-32 shrink-0 flex-col justify-between rounded-xl border border-hairline bg-card p-3 min-h-[5.25rem] animate-pulse motion-reduce:animate-none"
          >
            <div className="h-3.5 w-3/4 rounded-full bg-ink/[0.1]" />
            <div className="mt-2">
              <div className="h-6 w-8 rounded bg-ink/[0.1]" />
              <div className="mt-0.5 h-2.5 w-6 rounded-full bg-ink/[0.07]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (failed && !snapshot) {
    return (
      <div role="alert" className="rounded-xl border border-hairline bg-card p-3 text-sm text-ink-secondary">
        Countdowns unavailable.
        {onRetry && (
          <button type="button" className="ml-2 underline hover:text-ink" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (!snapshot || snapshot.items.length === 0) {
    return (
      <div role="status" className="rounded-xl border border-hairline bg-card p-3 text-sm text-ink-secondary">
        No upcoming countdowns.
      </div>
    );
  }

  return (
    <div>
      {failed && (
        <p role="status" className="mb-2 text-xs text-ink-secondary">
          Countdowns unavailable. Showing the last update from {updateTime.format(new Date(snapshot.updatedAt))} (Berlin).
          {onRetry && (
            <button type="button" className="ml-1.5 underline hover:text-ink" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}
      <ul aria-label="Countdowns" className="flex w-full min-w-0 gap-2.5 overflow-x-auto pb-1.5">
        {snapshot.items.map((item) => (
          <li
            key={item.id}
            title={`${item.title} · ${item.targetDate}`}
            className="group relative flex w-32 sm:w-28 shrink-0 flex-col justify-between rounded-xl border border-hairline bg-card p-3 shadow-sm transition-colors"
          >
            <p className="line-clamp-1 text-xs sm:text-sm font-medium leading-tight text-ink">
              {item.title}
            </p>
            <div className="mt-2">
              <p className="text-2xl sm:text-3xl font-semibold leading-none tabular-nums text-ink">
                {item.daysRemaining === 0 ? "Today" : item.daysRemaining}
              </p>
              {item.daysRemaining > 0 && (
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-secondary">
                  {item.daysRemaining === 1 ? "day" : "days"}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
