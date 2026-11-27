// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardShell } from "./DashboardPage";
import type { DashboardWidget, DashboardWidgetProps, WidgetSetup } from "./widget";

vi.mock("./clock/DateTimeDisplay", () => ({ DateTimeDisplay: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; });

async function fixture(initial: WidgetSetup[]) {
  let mounts = 0;
  const reports: Array<(status: WidgetSetup) => void> = [];
  const registry: DashboardWidget[] = initial.map((status, index) => ({
    id: String(index), slot: "agenda", Component: function Widget({ view, onSetupChange }: DashboardWidgetProps) {
      useEffect(() => { mounts++; reports[index] = onSetupChange!; onSetupChange!(status); }, [onSetupChange]);
      return createElement("p", null, `${index}: ${view}`);
    },
  }));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(DashboardShell, { registry })));
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Configure dashboard"]')!;
  expect(toggle.className).toContain("absolute");
  expect(toggle.className).toContain("bottom-3");
  expect(toggle.className).toContain("end-3");
  expect(toggle.textContent).toBe("");
  return { container, toggle, reports, mounts: () => mounts };
}
it("opens configuration when every configurable widget needs setup", async () => {
  const { toggle } = await fixture(["needs-setup", "needs-setup", "needs-setup"]);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
});
it.each(["needs-setup", "unavailable", "checking"] as WidgetSetup[])("opens presentation for ready-but-empty widgets alongside %s", async (status) => {
  const { toggle } = await fixture(["ready", status]);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});
it("keeps a manual view choice across delayed reads and outages without remounting widgets", async () => {
  const { toggle, reports, mounts } = await fixture(["checking", "checking"]);
  await act(async () => toggle.click());
  toggle.focus();
  await act(async () => { reports[0]!("ready"); reports[1]!("unavailable"); });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(toggle);
  expect(mounts()).toBe(2);
  await act(async () => toggle.click());
  await act(async () => reports[0]!("needs-setup"));
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});
it("shows configuration on lookup failures and recomputes entry after a fresh visit", async () => {
  const { toggle } = await fixture(["unavailable", "needs-setup"]);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await act(async () => root.unmount());
  const next = await fixture(["ready", "ready"]);
  expect(next.toggle.getAttribute("aria-pressed")).toBe("false");
});
