import { useCallback, useEffect, useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { useActiveLocale } from "@/lib/use-active-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { DateTimeDisplay } from "./clock/DateTimeDisplay";
import { CalendarProvider } from "./calendar/CalendarController";
import { CalendarAgenda } from "./agenda/CalendarAgenda";
import { CountdownList } from "./countdown/CountdownList";
import { TodayTasks } from "./tasks/TodayTasks";
import type { DashboardView, DashboardWidget, WidgetSetup } from "./widget";

const widgets: readonly DashboardWidget[] = [
  { id: "agenda", slot: "agenda", Component: CalendarAgenda },
  { id: "tasks", slot: "tasks", Component: TodayTasks },
  { id: "countdown", slot: "countdown", Component: CountdownList },
];
const slots = {
  agenda: "md:col-start-1 md:row-start-1 md:row-span-3 md:w-fit md:max-w-[min(26rem,36vw)] md:overflow-y-auto md:overscroll-contain",
  tasks: "md:col-start-3 md:row-start-2 md:w-fit md:max-w-[min(26rem,36vw)] md:justify-self-end md:self-start md:overflow-y-auto md:overscroll-contain",
  countdown: "md:col-start-2 md:col-span-2 md:row-start-3",
};

export function DashboardShell({ registry = widgets }: { registry?: readonly DashboardWidget[] }) {
  useActiveLocale();
  const [view, setView] = useState<DashboardView | null>(null);
  const [statuses, setStatuses] = useState<Record<string, WidgetSetup>>({});
  const report = useCallback((id: string, status: WidgetSetup) => {
    setStatuses((current) => current[id] === status ? current : { ...current, [id]: status });
  }, []);
  const reporters = useMemo(() => Object.fromEntries(registry.map(({ id }) => [id, (status: WidgetSetup) => report(id, status)])), [registry, report]);
  useEffect(() => {
    if (view !== null) return;
    const values = registry.map(({ id }) => statuses[id] ?? "checking");
    if (values.includes("ready")) setView("presentation");
    else if (values.every((status) => status !== "checking")) setView("configuration");
  }, [registry, statuses, view]);
  const currentView = view ?? "presentation";
  return <div aria-label={t("dashboard.title")} className="relative flex h-full min-h-0 w-full flex-col">
    <div className={cn("min-h-0 flex-1 p-4 pt-16", currentView === "presentation" ? "overflow-hidden" : "overflow-y-auto overscroll-contain")}>
      {view === null && <p role="status" className="mb-4 text-sm text-ink-secondary">{t("dashboard.checking")}</p>}
      {currentView === "configuration" && <h1 className="mb-4 truncate text-xl font-semibold tracking-[-0.01em] text-ink">{t("dashboard.configuration")}</h1>}
      <div className={cn("grid min-w-0 grid-cols-1 gap-4", currentView === "presentation" ? "h-full md:grid-cols-[auto_minmax(0,1fr)_auto] md:grid-rows-[auto_minmax(0,1fr)_auto]" : "items-start lg:grid-cols-2")}>
        <div className={cn("min-w-0", currentView === "presentation" ? "md:col-start-3 md:row-start-1" : "hidden")}><DateTimeDisplay /></div>
        {registry.map(({ id, slot, Component }) => <div key={id} className={cn(
          "min-h-0 min-w-0",
          slot === "countdown" ? "p-0" : "rounded-xl border border-hairline p-4",
          currentView === "presentation" && slots[slot],
          currentView === "presentation" && slot !== "countdown" && "w-full",
          currentView === "presentation" && slot === "tasks" && "md:w-fit",
          currentView === "presentation" && slot === "countdown" && "w-fit max-w-full justify-self-start",
        )}>
          <Component view={currentView} onSetupChange={reporters[id]} />
        </div>)}
      </div>
    </div>
    <button type="button" aria-label={t("dashboard.configure")} aria-pressed={currentView === "configuration"} title={t("dashboard.configure")} className="ui-icon-button absolute bottom-3 end-3 z-10 size-10 rounded-full bg-card" onClick={() => setView(currentView === "configuration" ? "presentation" : "configuration")}>
      <Settings aria-hidden="true" size={18} />
    </button>
  </div>;
}

export default function DashboardPage() {
  return <CalendarProvider><DashboardShell /></CalendarProvider>;
}
