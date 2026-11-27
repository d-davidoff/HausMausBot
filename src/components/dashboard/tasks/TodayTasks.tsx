import { useEffect } from "react";
import { Check, Clock, ExternalLink, Loader2 } from "lucide-react";
import { Select } from "@/components/Select";
import { t } from "@/lib/i18n";
import type { DashboardWidgetProps } from "../widget";
import { useTasksController } from "./useTasksController";

export function TodayTasks({ view = "presentation", onSetupChange }: Partial<DashboardWidgetProps>) {
  const {
    accountChoices, snapshot, selectedAccountId, savingAccount, handleSelectAccount, openGoogleTasks,
    needsSetup, accountSaveError, retryRead, externalError, completionError, connected, readError,
    inventoryReconnect, inventoryRefused, openApps, loading, visibleLists, pendingRows, unconfirmedRows,
    handleToggleTask, setup,
  } = useTasksController();
  useEffect(() => { onSetupChange?.(setup); }, [setup, onSetupChange]);
  return (
    <section aria-label={t("dashboard.tasks.title")} className="flex min-h-0 flex-col gap-3 text-end">
      <header className="flex flex-wrap items-center justify-between gap-2">
        {view === "configuration" && accountChoices.length > 1 && (
          <Select
            aria-label={t("dashboard.tasks.account")}
            disabled={savingAccount}
            variant="ghost"
            size="sm"
            value={snapshot?.accountId ?? selectedAccountId ?? ""}
            onChange={(event) => void handleSelectAccount(event.target.value)}
          >
            <option value="" disabled>
              {t("dashboard.tasks.selectAccount")}
            </option>
            {accountChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
        )}

        <h2 className="ms-auto min-w-0 truncate text-[17px] font-semibold text-ink">
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-2 rounded-sm outline-offset-4 hover:underline focus-visible:outline-2"
            onClick={openGoogleTasks}
          >
            <span className="truncate">{t("dashboard.tasks.title")}</span>
            <ExternalLink aria-hidden="true" size={16} className="shrink-0" />
            <span className="sr-only">{t("dashboard.tasks.openGoogleTasks")}</span>
          </button>
        </h2>
      </header>

      {view === "configuration" && snapshot && <p className="text-sm text-ink-secondary">{t("dashboard.tasks.connectedAccount", { name: accountChoices.find((entry) => entry.id === snapshot.accountId)?.label ?? "Google Tasks" })}</p>}
      {view === "presentation" && needsSetup && <p className="text-sm text-ink-secondary">{t("dashboard.tasks.configureHint")}</p>}
      {accountSaveError && <p role="alert">{t("dashboard.tasks.saveFailed")} <button className="ui-button ui-button-sm" onClick={retryRead}>{t("dashboard.retry")}</button></p>}
      {savingAccount && <p role="status">{t("dashboard.tasks.saving")}</p>}
      {externalError && (
        <p role="status" className="text-sm text-ink-secondary">
          {t("dashboard.tasks.openFailed")}
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
              ? t("dashboard.tasks.reconnect")
              : t("dashboard.tasks.disconnected")}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {view === "configuration" && !inventoryRefused && (
              <button type="button" className="ui-button ui-button-md ui-button-pill" onClick={openApps}>
                {t("dashboard.tasks.openApps")}
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
                ? t("dashboard.tasks.stale")
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
          {t("dashboard.tasks.loading")}
        </p>
      )}

      {view === "presentation" && connected !== false && snapshot && !readError && visibleLists.length === 0 && (
        <p className="text-sm text-ink-secondary">{t("dashboard.tasks.empty")}</p>
      )}

      {view === "presentation" && snapshot && visibleLists.length > 0 && (
        <div className="flex flex-col gap-4">
          {visibleLists.map((list) => (
            <div key={list.id} className="flex flex-col gap-2">
              <h3 className="truncate text-end text-sm font-medium text-ink-secondary" title={list.title}>
                {list.title}
              </h3>
              <ul aria-label={list.title} className="flex flex-col gap-1.5">
                {list.items.map((item) => {
                  const key = `${snapshot.accountId}\0${list.id}\0${item.id}`;
                  const isPending = pendingRows.has(key);
                  const isUnconfirmed = unconfirmedRows.has(key);
                  const isCompleted = item.status === "completed";
                  return (
                    <li key={`${list.id}:${item.id}`} data-task-row={`${list.id}:${item.id}`}>
                      <button
                        type="button"
                        aria-label={isCompleted ? t("dashboard.tasks.markIncomplete", { title: item.title }) : t("dashboard.tasks.complete", { title: item.title })}
                        aria-pressed={isCompleted}
                        title={isUnconfirmed ? t("dashboard.tasks.confirmHint") : item.title}
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
                            title={t("dashboard.tasks.preferredTime")}
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
                          aria-label={isCompleted ? t("dashboard.tasks.completed") : undefined}
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
