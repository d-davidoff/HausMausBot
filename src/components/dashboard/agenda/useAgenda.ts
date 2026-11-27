import { useEffect, useState } from "react";
import type { DashboardAgendaDay } from "../../../../shared/dashboard-calendar";
import { api } from "@/state/api";
import { useDashboardCalendar } from "../calendar/CalendarController";

export function useAgenda() {
  const calendar = useDashboardCalendar();
  const [days, setDays] = useState<DashboardAgendaDay[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const ids = calendar.selection?.selectedCalendarIds.join("\0") ?? "";
  useEffect(() => {
    setDays([]);
    setUpdatedAt(null);
    setError(false);
    setLoading(false);
    if (calendar.connection !== "ready" || calendar.saving || calendar.saveError || !ids) return;
    let active = true;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (background = false) => {
      if (!active || pending || (background && document.visibilityState === "hidden")) return;
      clearTimeout(timer);
      pending = new AbortController();
      if (!background) setLoading(true);
      const query = new URLSearchParams();
      ids.split("\0").forEach((id) => query.append("calendarId", id));
      try {
        const result = await api<DashboardAgendaDay[]>(`/api/dashboard/calendar-agenda?${query}`, { background, signal: pending.signal });
        if (!active) return;
        setDays(result);
        setUpdatedAt(new Date());
        setError(false);
      } catch {
        if (active) setError(true);
      } finally {
        pending = null;
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void refresh(true), 300_000);
        }
      }
    };
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(true); };
    const onOnline = () => void refresh(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      active = false;
      pending?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [calendar.connection, calendar.revision, calendar.saving, calendar.saveError, ids, reload]);
  return { days, updatedAt, loading, error, retry: () => setReload((value) => value + 1) };
}
