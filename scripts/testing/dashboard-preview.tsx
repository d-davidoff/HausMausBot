import { useState } from "react";
import { createRoot } from "react-dom/client";
import DashboardPage from "../../src/components/dashboard/DashboardPage";
import { StoreContext, initialState } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Preview() {
  const [visit, setVisit] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  return <StoreContext.Provider value={{ state: { ...initialState, pluginsOpen }, dispatch: (action) => {
    if (action.type === "togglePlugins") setPluginsOpen(action.open ?? !pluginsOpen);
  }, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }}>
    <div className="flex h-dvh flex-col bg-app text-ink">
      <nav className="flex shrink-0 gap-2 p-2">
        <button className="ui-button ui-button-sm" onClick={() => setVisit((value) => value + 1)}>Reopen dashboard</button>
        <button className="ui-button ui-button-sm" onClick={() => applySkin("daylight")}>Daylight</button>
        <button className="ui-button ui-button-sm" onClick={() => applySkin("midnight")}>Midnight</button>
        {pluginsOpen && <button className="ui-button ui-button-sm" onClick={async () => { await fetch("/__fixture/connect", { method: "POST" }); setPluginsOpen(false); }}>Connect fixture accounts</button>}
      </nav>
      <div className="min-h-0 flex-1"><DashboardPage key={visit} /></div>
    </div>
  </StoreContext.Provider>;
}
setAnalyticsEnabled(false);
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<Preview />);
