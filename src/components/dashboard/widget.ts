import type { ComponentType } from "react";

export type DashboardView = "presentation" | "configuration";
export type WidgetSetup = "checking" | "needs-setup" | "ready" | "unavailable";
export interface DashboardWidgetProps {
  view: DashboardView;
  onSetupChange?: (status: WidgetSetup) => void;
}
export interface DashboardWidget {
  id: string;
  slot: "agenda" | "tasks" | "countdown";
  Component: ComponentType<DashboardWidgetProps>;
}
