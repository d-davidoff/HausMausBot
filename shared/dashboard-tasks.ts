export const TASKS_TIME_ZONE = "Europe/Berlin";

export type DashboardTaskStatus = "needsAction" | "completed";

export interface DashboardTaskAccount {
  id: string;
  label: string;
  status: string;
}

export interface DashboardTaskItem {
  id: string;
  listId: string;
  title: string;
  status: DashboardTaskStatus;
  due?: string;
  completed?: string;
  isChallenge: boolean;
  challengeTime?: string;
  challengeMinutes?: number;
}

export interface DashboardTaskList {
  id: string;
  title: string;
  items: DashboardTaskItem[];
}

export interface DashboardTasksSnapshot {
  accountId: string;
  accounts?: DashboardTaskAccount[];
  date: string;
  lists: DashboardTaskList[];
  updatedAt: string;
  source: "google";
}

export interface DashboardTaskCompletionResponse {
  status: DashboardTaskStatus;
  completed?: string;
}

export type DashboardTasksErrorCode =
  | "invalid_request"
  | "forbidden"
  | "connection_access_denied"
  | "not_connected"
  | "reconnect_required"
  | "account_selection_required"
  | "stale_account_selection"
  | "task_not_found"
  | "insufficient_write_scope"
  | "ambiguous_timeout"
  | "response_too_large"
  | "provider_read_failed"
  | "provider_write_failed"
  | "tasks_unavailable";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TASKS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const offsetFormat = new Intl.DateTimeFormat("en", {
  timeZone: TASKS_TIME_ZONE,
  timeZoneName: "longOffset",
});

export function berlinTaskDay(date: Date): string {
  const parts = dayFormat.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addTaskDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function berlinTaskMidnight(day: string): string {
  const midnightUtc = new Date(`${day}T00:00:00Z`);
  const zone = offsetFormat.formatToParts(midnightUtc).find(({ type }) => type === "timeZoneName")?.value;
  const offset = zone?.replace(/^GMT/, "");
  if (!offset) throw new Error("Berlin offset unavailable");
  return `${day}T00:00:00${offset}`;
}

export function isSameBerlinTaskDay(timestamp: string | undefined, day: string): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  return berlinTaskDay(new Date(parsed)) === day;
}

export function filterTasksForBerlinDay(lists: readonly DashboardTaskList[], day: string): DashboardTaskList[] {
  const visible: DashboardTaskList[] = [];
  for (const list of lists) {
    const items = list.items.filter(
      (item) =>
        item.due?.slice(0, 10) === day &&
        (item.status !== "completed" || isSameBerlinTaskDay(item.completed, day)),
    );
    if (items.length > 0) {
      visible.push({ id: list.id, title: list.title, items });
    }
  }
  return visible;
}
