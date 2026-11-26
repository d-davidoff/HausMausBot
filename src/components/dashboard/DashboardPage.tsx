import { DateTimeDisplay } from "./clock/DateTimeDisplay";
import { GoogleCalendarConnection } from "./calendar/GoogleCalendarConnection";
import { CalendarAgenda } from "./agenda/CalendarAgenda";
import { CountdownList } from "./countdown/CountdownList";
import { TodayTasks } from "./tasks/TodayTasks";

export default function DashboardPage() {
  return (
    <div aria-label="Dashboard" className="relative z-1 grid min-h-dvh w-full grid-cols-1 gap-4 p-4 md:h-dvh md:grid-cols-[auto_minmax(0,1fr)_auto] md:grid-rows-[auto_1fr_auto] xl:grid-rows-[auto_1fr_auto]">
      <aside
        aria-label="Calendar agenda"
        className="flex min-h-0 min-w-0 flex-col gap-5 overflow-hidden rounded-xl border border-hairline bg-card p-5 md:col-start-1 md:row-span-3 md:row-start-1 md:w-fit md:max-w-[min(26rem,36vw)] md:overflow-y-auto md:overscroll-contain"
      >
        <GoogleCalendarConnection />
        <CalendarAgenda />
      </aside>

      <div className="col-start-1 row-start-1 flex min-w-0 flex-col items-end gap-3 md:col-start-3 md:row-start-1">
        <DateTimeDisplay />
      </div>

      <aside
        aria-label="Tasks"
        className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden rounded-xl border border-hairline bg-card p-5 md:col-start-3 md:row-start-2 md:w-fit md:max-w-[min(26rem,36vw)] md:justify-self-end md:max-h-full md:self-start md:overflow-y-auto md:overscroll-contain"
      >
        <TodayTasks />
      </aside>

      <div className="col-start-1 row-start-5 w-full min-w-0 md:col-start-2 md:col-span-2 md:row-start-3">
        <CountdownList />
      </div>
    </div>
  );
}
