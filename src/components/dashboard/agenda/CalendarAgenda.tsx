import { useEffect } from "react";
import { t } from "@/lib/i18n";
import { AgendaDayItem } from "./AgendaDayItem";
import { AgendaEventItem } from "./AgendaEventItem";
import { AgendaHeader } from "./AgendaHeader";
import { CalendarConfig } from "../calendar/CalendarConfig";
import { GoogleCalendarConnection } from "../calendar/GoogleCalendarConnection";
import { useDashboardCalendar } from "../calendar/CalendarController";
import type { DashboardWidgetProps } from "../widget";
import { useAgenda } from "./useAgenda";

export function CalendarAgenda({ view = "presentation", onSetupChange }: Partial<DashboardWidgetProps>) {
  const calendar = useDashboardCalendar();
  const agenda = useAgenda();
  useEffect(() => { onSetupChange?.(calendar.setup); }, [calendar.setup, onSetupChange]);
  const configuring = view === "configuration";
  return <section aria-label={t("dashboard.agenda.title")} className="flex min-h-0 flex-col gap-4">
    {configuring && <GoogleCalendarConnection />}
    {calendar.connection === "checking" && <p role="status">{t("dashboard.calendar.loading")}</p>}
    {calendar.connection === "unavailable" && <p role="alert">{t("dashboard.calendar.unavailable")} <button className="ui-button ui-button-sm" onClick={calendar.retry}>{t("dashboard.retry")}</button></p>}
    {!configuring && calendar.connection === "needs-setup" && <p className="text-sm text-ink-secondary">{t("dashboard.calendar.connectHint")}</p>}
    {calendar.saveError && !configuring && <p role="alert">{t("dashboard.calendar.saveFailed")} <button className="ui-button ui-button-sm" onClick={calendar.retrySave}>{t("dashboard.retry")}</button></p>}
    {calendar.saving && <p role="status">{t("dashboard.calendar.saving")}</p>}
    {configuring && calendar.selection && <>
      <p className="text-sm text-ink-secondary">{t("dashboard.calendar.choose")}</p>
      <CalendarConfig calendars={calendar.selection.calendars} selectedIds={calendar.selectedIds} saving={calendar.saving} error={calendar.saveError} onToggle={calendar.toggle} onRetry={calendar.retrySave} />
    </>}
    {!configuring && calendar.connection === "ready" && !calendar.saving && !calendar.saveError && <>
      {agenda.loading && <p role="status">{t("dashboard.agenda.loading")}</p>}
      {agenda.error && <p role="alert">{t("dashboard.agenda.unavailable")} <button className="ui-button ui-button-sm" onClick={agenda.retry}>{t("dashboard.retry")}</button></p>}
      {calendar.setup === "needs-setup" && <p className="text-sm text-ink-secondary">{t("dashboard.agenda.chooseHint")}</p>}
      {!agenda.loading && !agenda.error && calendar.setup === "ready" && <>
        {agenda.days[0] && <AgendaHeader date={agenda.days[0].date} updatedAt={agenda.updatedAt} />}
        {agenda.days.every((day) => day.events.length === 0) && <p className="text-sm text-ink-secondary">{t("dashboard.agenda.empty")}</p>}
        <div className="flex flex-col divide-y divide-hairline/60">
          {agenda.days.map((day) => <AgendaDayItem key={day.date} date={day.date}>
            {day.events.length === 0 ? <p className="text-sm text-ink-secondary">{t("dashboard.agenda.emptyDay")}</p>
              : day.events.map((event) => <AgendaEventItem key={event.id} event={event} calendarName={calendar.selection?.calendars.find((entry) => entry.id === event.calendarId)?.name ?? event.calendarId} />)}
          </AgendaDayItem>)}
        </div>
      </>}
    </>}
  </section>;
}
