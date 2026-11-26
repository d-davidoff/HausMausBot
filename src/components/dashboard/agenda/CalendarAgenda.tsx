import { useEffect, useId, useRef, useState } from "react";
import { Settings } from "lucide-react";
import type { DashboardAgendaDay, DashboardCalendarChoice } from "../../../../shared/dashboard-calendar";
import { hasActiveConnection } from "@/lib/connector-status";
import { connectorStatusMemory, preloadConnectedApps } from "@/lib/connected-apps";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";
import { AgendaDayItem } from "./AgendaDayItem";
import { AgendaEventItem } from "./AgendaEventItem";
import { AgendaHeader } from "./AgendaHeader";
import { CalendarConfig } from "../calendar/CalendarConfig";

const REFRESH_MS = 5 * 60 * 1000;
const AGENDA_STORAGE_KEY = "openmausbot.dashboard.agenda";

interface CachedAgendaState {
  calendars: DashboardCalendarChoice[];
  selectedCalendarIds: string[];
  days: DashboardAgendaDay[];
  updatedAt: string;
}

function loadCachedAgenda(): CachedAgendaState | null {
  try {
    const raw = sessionStorage.getItem(AGENDA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.calendars) && Array.isArray(parsed.days)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedAgenda(data: Partial<CachedAgendaState>): void {
  try {
    const existing = loadCachedAgenda() ?? { calendars: [], selectedCalendarIds: [], days: [], updatedAt: "" };
    sessionStorage.setItem(AGENDA_STORAGE_KEY, JSON.stringify({ ...existing, ...data }));
  } catch {
    // Ignore storage quota or disabled errors
  }
}

function connectedNow(): boolean | null {
  const inventory = connectorStatusMemory();
  return inventory?.authoritative ? hasActiveConnection(inventory.services.googlecalendar) : null;
}

function getCalendarData<T>(calendarIds?: readonly string[], options?: { background?: boolean; signal?: AbortSignal }): Promise<T> {
  const query = new URLSearchParams();
  for (const id of calendarIds ?? []) query.append("calendarId", id);
  const suffix = query.size ? `?${query}` : "";
  return api<T>(`/api/dashboard/calendar-agenda${suffix}`, options);
}

async function saveCalendarSelection(calendarIds: readonly string[]): Promise<void> {
  await api("/api/dashboard/calendar-agenda", {
    method: "PUT",
    body: JSON.stringify({ calendarIds }),
  });
}

export function CalendarAgenda() {
  const configId = useId();
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const initialCache = loadCachedAgenda();
  const [connected, setConnected] = useState(connectedNow);
  const [calendars, setCalendars] = useState<DashboardCalendarChoice[] | null>(() => initialCache?.calendars ?? null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => initialCache?.selectedCalendarIds ?? []);
  const [configOpen, setConfigOpen] = useState(false);
  const [days, setDays] = useState<DashboardAgendaDay[]>(() => initialCache?.days ?? []);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(() => (initialCache?.updatedAt ? new Date(initialCache.updatedAt) : null));
  const [loading, setLoading] = useState(() => initialCache === null || (initialCache.days.length === 0 && initialCache.selectedCalendarIds.length > 0));
  const [error, setError] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const selectedIdsRef = useRef<string[]>(initialCache?.selectedCalendarIds ?? []);
  const loadedKeyRef = useRef((initialCache?.selectedCalendarIds ?? []).join("\u0000"));
  const selectionQueue = useRef(Promise.resolve());
  const selectionRevision = useRef(0);
  const selectedKey = selectedIds.join("\u0000");

  useEffect(() => {
    let current = true;
    void preloadConnectedApps(true).then(({ services, authoritative, refused }) => {
      if (!current) return;
      const isConnected = authoritative && !refused && hasActiveConnection(services.googlecalendar);
      setConnected(isConnected);
      if (!isConnected) {
        selectedIdsRef.current = [];
        loadedKeyRef.current = "";
        setSelectedIds([]);
        setConfigOpen(false);
        setCalendars(null);
        setDays([]);
        setUpdatedAt(null);
        try { sessionStorage.removeItem(AGENDA_STORAGE_KEY); } catch {}
      }
    });
    return () => { current = false; };
  }, [pluginsOpen]);

  useEffect(() => {
    if (connected !== true) return;
    if (calendars !== null && (configOpen || selectedIds.length === 0)) {
      setLoading(false);
      setError(false);
      if (selectedIds.length === 0) {
        loadedKeyRef.current = "";
        setDays([]);
        setUpdatedAt(null);
        saveCachedAgenda({ days: [], updatedAt: "" });
      }
      return;
    }

    let current = true;
    let inFlight: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loadCalendars = () => {
      const controller = new AbortController();
      inFlight = controller;
      if (!initialCache) setLoading(true);
      setError(false);
      void getCalendarData<{ calendars: DashboardCalendarChoice[]; selectedCalendarIds: string[] }>(undefined, { signal: controller.signal })
        .then((calendarList) => {
          if (!current) return;
          setCalendars(calendarList.calendars);
          selectedIdsRef.current = calendarList.selectedCalendarIds;
          setSelectedIds(calendarList.selectedCalendarIds);
          setConfigOpen(calendarList.selectedCalendarIds.length === 0);
          saveCachedAgenda({
            calendars: calendarList.calendars,
            selectedCalendarIds: calendarList.selectedCalendarIds,
          });
        })
        .catch(() => { if (current) setError(true); })
        .finally(() => {
          inFlight = null;
          if (current) setLoading(false);
        });
    };

    const loadEvents = (background: boolean) => {
      if (!current || inFlight || (background && document.visibilityState === "hidden")) return;
      clearTimeout(timer);
      const controller = new AbortController();
      inFlight = controller;
      if (!background && days.length === 0) {
        setLoading(true);
        setError(false);
      }
      void getCalendarData<DashboardAgendaDay[]>(selectedIds, { background, signal: controller.signal })
        .then((result) => {
          if (!current) return;
          loadedKeyRef.current = selectedKey;
          setDays(result);
          const now = new Date();
          setUpdatedAt(now);
          setError(false);
          saveCachedAgenda({ days: result, updatedAt: now.toISOString() });
        })
        .catch(() => {
          if (current && !background) setError(true);
        })
        .finally(() => {
          inFlight = null;
          if (current) {
            if (!background) setLoading(false);
            timer = setTimeout(() => loadEvents(true), REFRESH_MS);
          }
        });
    };

    if (calendars === null) {
      loadCalendars();
      return () => {
        current = false;
        inFlight?.abort();
      };
    }

    loadEvents(false);
    const onVisible = () => {
      if (document.visibilityState === "visible" && loadedKeyRef.current === selectedKey) loadEvents(true);
    };
    const onOnline = () => {
      if (loadedKeyRef.current === selectedKey) loadEvents(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      current = false;
      inFlight?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [connected, configOpen, selectedKey, reload, calendars]);

  if (connected !== true) return null;
  const retry = () => setReload((value) => value + 1);
  const persistSelection = (next: readonly string[]) => {
    setSelectionError(false);
    setSelectionSaving(true);
    const revision = ++selectionRevision.current;
    selectionQueue.current = selectionQueue.current.catch(() => undefined).then(async () => {
      try {
        await saveCalendarSelection(next);
        if (revision === selectionRevision.current) {
          setSelectionError(false);
          saveCachedAgenda({ selectedCalendarIds: [...next] });
        }
      } catch {
        if (revision === selectionRevision.current) setSelectionError(true);
      } finally {
        if (revision === selectionRevision.current) setSelectionSaving(false);
      }
    });
  };
  const toggleCalendar = (id: string) => {
    const selected = selectedIdsRef.current;
    const next = selected.includes(id)
      ? selected.filter((calendarId) => calendarId !== id)
      : [...selected, id];
    selectedIdsRef.current = next;
    setSelectedIds(next);
    if (next.length === 0) setConfigOpen(true);
    persistSelection(next);
  };
  const retrySelection = () => persistSelection(selectedIdsRef.current);
  const calendarName = (id: string) => calendars?.find((calendar) => calendar.id === id)?.name ?? id;
  const toggleConfig = () => {
    if (!selectionSaving) setConfigOpen((open) => !open);
  };

  return <section aria-label="Agenda" className="flex min-h-0 flex-col gap-4">
    <header className="flex items-center gap-2">
      <button type="button" aria-label="Calendar settings" aria-expanded={configOpen} aria-controls={configId} disabled={calendars === null || selectionSaving} className="ui-icon-button" onClick={toggleConfig}>
        <Settings aria-hidden="true" size={16} className="shrink-0" />
      </button>
    </header>
    {loading && <div aria-label={calendars === null ? "Loading calendars" : "Loading agenda"} className="flex w-full flex-col gap-3 md:w-56 md:max-w-full">{[0, 1, 2, 3, 4].map((n) => <div key={n} className="h-8 animate-pulse rounded-lg bg-ink/[0.07] motion-reduce:animate-none" />)}</div>}
    {error && <div role="alert" className="text-sm text-ink-secondary">{calendars === null ? "Couldn’t load calendars." : "Couldn’t load calendar events."} <button type="button" className="underline" onClick={retry}>Try again</button></div>}
    {!loading && !error && configOpen && calendars && <CalendarConfig
      id={configId}
      calendars={calendars}
      selectedIds={selectedIds}
      saving={selectionSaving}
      error={selectionError}
      onToggle={toggleCalendar}
      onRetry={retrySelection}
    />}
    {!loading && !error && !configOpen && selectedIds.length === 0 && <p className="text-sm text-ink-secondary">Choose calendars in settings to show your agenda.</p>}
    {!loading && !error && !configOpen && selectedIds.length > 0 && <>
      {days[0] && <AgendaHeader date={days[0].date} updatedAt={updatedAt} />}
      {days.every((day) => day.events.length === 0) && <p className="text-sm text-ink-secondary">No upcoming events.</p>}
      <div className="flex flex-col divide-y divide-hairline/60">
        {days.map((day) => <AgendaDayItem key={day.date} date={day.date}>
          {day.events.length === 0
            ? <p className="text-sm text-ink-secondary">No events today</p>
            : day.events.map((event) => <AgendaEventItem key={event.id} event={event} calendarName={calendarName(event.calendarId)} />)}
        </AgendaDayItem>)}
      </div>
    </>}
  </section>;
}
