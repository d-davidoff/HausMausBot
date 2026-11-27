import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardCalendarChoice } from "../../../../shared/dashboard-calendar";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { hasActiveConnection } from "@/lib/connector-status";
import { api } from "@/state/api";
import { useStoreSelector } from "@/state/store-select";
import type { WidgetSetup } from "../widget";

type CalendarSelection = { calendars: DashboardCalendarChoice[]; selectedCalendarIds: string[] };

function useCalendarController() {
  const pluginsOpen = useStoreSelector((state) => state.pluginsOpen);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [connection, setConnection] = useState<WidgetSetup>("checking");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const draft = useRef<string[]>([]);
  const generation = useRef(0);
  const saveRevision = useRef(0);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    const epoch = ++generation.current;
    const controller = new AbortController();
    setConnection("checking");
    setSelection(null);
    setSelectedIds([]);
    draft.current = [];
    setSaving(false);
    setSaveError(false);
    void (async () => {
      try {
        const inventory = await preloadConnectedApps(true);
        if (controller.signal.aborted) return;
        if (!inventory.authoritative || inventory.refused) {
          setConnection("unavailable");
          return;
        }
        if (!hasActiveConnection(inventory.services.googlecalendar)) {
          setConnection("needs-setup");
          return;
        }
        const result = await api<CalendarSelection>("/api/dashboard/calendar-agenda", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSelection(result);
        draft.current = result.selectedCalendarIds;
        setSelectedIds(result.selectedCalendarIds);
        setConnection("ready");
        setRevision((value) => value + 1);
      } catch {
        if (!controller.signal.aborted) setConnection("unavailable");
      }
    })();
    return () => {
      controller.abort();
      if (generation.current === epoch) generation.current++;
    };
  }, [pluginsOpen, reload]);

  const persist = (next: string[]) => {
    const epoch = generation.current;
    const version = ++saveRevision.current;
    setSaving(true);
    setSaveError(false);
    queue.current = queue.current.then(async () => {
      if (generation.current !== epoch) return;
      try {
        await api("/api/dashboard/calendar-agenda", { method: "PUT", body: JSON.stringify({ calendarIds: next }) });
        if (generation.current !== epoch || saveRevision.current !== version) return;
        setSelection((current) => current && { ...current, selectedCalendarIds: next });
        setRevision((value) => value + 1);
      } catch {
        if (generation.current === epoch && saveRevision.current === version) setSaveError(true);
      } finally {
        if (generation.current === epoch && saveRevision.current === version) setSaving(false);
      }
    });
  };
  const toggle = (id: string) => {
    const next = draft.current.includes(id) ? draft.current.filter((value) => value !== id) : [...draft.current, id];
    draft.current = next;
    setSelectedIds(next);
    persist(next);
  };
  const setup: WidgetSetup = connection !== "ready" ? connection
    : saving ? "checking" : saveError ? "unavailable"
    : selection?.selectedCalendarIds.length ? "ready" : "needs-setup";
  return { selection, selectedIds, connection, setup, saving, saveError, revision, toggle,
    retrySave: () => persist(draft.current), retry: () => setReload((value) => value + 1) };
}

const CalendarContext = createContext<ReturnType<typeof useCalendarController> | null>(null);

export function CalendarProvider({ children }: { children: ReactNode }) {
  const controller = useCalendarController();
  return <CalendarContext.Provider value={controller}>{children}</CalendarContext.Provider>;
}

export function useDashboardCalendar() {
  const controller = useContext(CalendarContext);
  if (!controller) throw new Error("Calendar widgets require CalendarProvider");
  return controller;
}
