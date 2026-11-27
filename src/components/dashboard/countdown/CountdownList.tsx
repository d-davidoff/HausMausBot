import { useEffect, useState } from "react";
import type { CountdownSnapshot } from "../../../../shared/dashboard-countdowns";
import { api } from "@/state/api";
import { t } from "@/lib/i18n";
import { useDashboardCalendar } from "../calendar/CalendarController";
import type { DashboardWidgetProps, WidgetSetup } from "../widget";

const updateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function CountdownList({ view = "presentation", onSetupChange }: Partial<DashboardWidgetProps>) {
  const calendar = useDashboardCalendar();
  const [snapshot, setSnapshot] = useState<CountdownSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setLoading(calendar.connection === "checking" || calendar.saving);
    if (calendar.connection !== "ready" || calendar.saving || calendar.saveError) return;
    let active = true;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(background = false) {
      if (!active || pending || (background && document.visibilityState === "hidden")) return;
      clearTimeout(timer);
      pending = new AbortController();
      if (!background) setLoading(true);
      try {
        const result = await api<CountdownSnapshot>("/api/dashboard/countdowns?windowDays=30", { background, signal: pending.signal });
        if (!active) return;
        setSnapshot(result);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      } finally {
        pending = null;
        if (active) {
          setLoading(false);
          timer = setTimeout(() => void refresh(true), 300_000);
        }
      }
    }
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
  }, [calendar.connection, calendar.revision, calendar.saving, calendar.saveError, reload]);
  const status: WidgetSetup = calendar.connection !== "ready" ? calendar.connection
    : calendar.saving || loading ? "checking" : calendar.saveError || failed ? "unavailable"
    : snapshot?.calendars?.length === 0 ? "needs-setup" : snapshot ? "ready" : "checking";
  useEffect(() => { onSetupChange?.(status); }, [status, onSetupChange]);
  const retry = () => calendar.connection === "unavailable" ? calendar.retry() : setReload((value) => value + 1);
  return <section aria-label={t("dashboard.countdown.title")} className="flex w-fit min-w-0 max-w-full flex-col gap-3">
    {view === "configuration" && <>
      <h2 className="truncate text-[17px] font-semibold text-ink">{t("dashboard.countdown.title")}</h2>
      <p className="text-sm text-ink-secondary">{t("dashboard.countdown.sourceHint")}</p>
      {snapshot?.calendars && <p className="text-sm text-ink">{t("dashboard.countdown.source", { names: snapshot.calendars.map((entry) => entry.name).join(", ") || t("dashboard.calendar.none") })}</p>}
      <p className="text-sm text-ink-secondary">{t("dashboard.countdown.window")}</p>
    </>}
    {calendar.saveError ? <p role="alert">{t("dashboard.calendar.saveFailed")} <button className="ui-button ui-button-sm" onClick={calendar.retrySave}>{t("dashboard.retry")}</button></p>
      : <CountdownContent snapshot={snapshot} loading={loading} failed={failed || calendar.connection === "unavailable"} connected={calendar.connection !== "needs-setup"} onRetry={retry} />}
  </section>;
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
      <div role="status" className="text-sm text-ink-secondary">
        {t("dashboard.calendar.connectHint")}
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div aria-label={t("dashboard.countdown.loading")} className="flex w-fit max-w-full min-w-0 gap-2.5 overflow-x-auto overscroll-x-contain pb-1.5">
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className="flex w-28 sm:w-32 shrink-0 flex-col justify-between rounded-xl border border-hairline p-3 min-h-[5.25rem] animate-pulse motion-reduce:animate-none"
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
      <div role="alert" className="text-sm text-ink-secondary">
        {t("dashboard.countdown.unavailable")}
        {onRetry && (
          <button type="button" className="ms-2 underline hover:text-ink" onClick={onRetry}>
            {t("dashboard.retry")}
          </button>
        )}
      </div>
    );
  }

  if (!snapshot || snapshot.items.length === 0) {
    return (
      <div role="status" className="text-sm text-ink-secondary">
        {t("dashboard.countdown.empty")}
      </div>
    );
  }

  return (
    <div>
      {failed && (
        <p role="status" className="mb-2 text-xs text-ink-secondary">
          {t("dashboard.countdown.stale", { time: updateTime.format(new Date(snapshot.updatedAt)) })}
          {onRetry && (
            <button type="button" className="ms-1.5 underline hover:text-ink" onClick={onRetry}>
              {t("dashboard.retry")}
            </button>
          )}
        </p>
      )}
      <ul aria-label={t("dashboard.countdown.title")} className="flex w-fit max-w-full min-w-0 gap-2.5 overflow-x-auto overscroll-x-contain pb-1.5">
        {snapshot.items.map((item) => (
          <li
            key={item.id}
            title={`${item.title} · ${item.targetDate}`}
            className="group relative flex w-32 sm:w-28 shrink-0 flex-col justify-between rounded-xl border border-hairline p-3"
          >
            <p className="line-clamp-1 text-xs sm:text-sm font-medium leading-tight text-ink">
              {item.title}
            </p>
            <div className="mt-2">
              <p className="text-2xl sm:text-3xl font-semibold leading-none tabular-nums text-ink">
                {item.daysRemaining === 0 ? t("dashboard.countdown.today") : item.daysRemaining}
              </p>
              {item.daysRemaining > 0 && (
                <p className="mt-0.5 text-xs text-ink-secondary">
                  {item.daysRemaining === 1 ? t("dashboard.countdown.day") : t("dashboard.countdown.days")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
