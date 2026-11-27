import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchVerificationServer } from "../control-omb.ts";
import { startFakeConnectedApps } from "../../server/testing/fake-connected-apps.ts";
import { berlinTaskDay } from "../../shared/dashboard-tasks.ts";
import { mountPreview } from "./preview-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";

const output = resolve(".omb-scratch/verify-evidence/dashboard");
await mkdir(output, { recursive: true });
const apps = await startFakeConnectedApps();
apps.connected = {};
apps.accounts = {};
apps.calendars = [{ id: "primary", summary: "Home", primary: true, accessRole: "owner" }, { id: "school", summary: "School", accessRole: "owner" }];
const today = berlinTaskDay(new Date());
apps.events = [{ id: "trip", summary: "Family trip", description: "#countdown", start: { date: today }, end: { date: berlinTaskDay(new Date(Date.now() + 86400000)) } }];
apps.tasksByAccount = Object.fromEntries(["parents", "kids"].map((id) => [id, { taskLists: [{ id: "list", title: "Today" }], tasksByList: { list: [{ id: "chore", title: `${id} chore`, status: "needsAction", due: `${today}T00:00:00Z` }] } }]));
const fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token });
const preview = await mountPreview(fixture, {
  entry: "/scripts/testing/dashboard-preview.tsx", route: "/__dashboard.html", title: "Isolated dashboard verification",
  extraRoutes: [{ path: "/__fixture/connect", method: "POST", handler: (_req, res) => {
    apps.connected = { googlecalendar: true, googletasks: true };
    apps.accounts = { googlecalendar: [{ id: "calendar", status: "ACTIVE" }], googletasks: [{ id: "parents", alias: "Parents", status: "ACTIVE" }, { id: "kids", alias: "Kids", status: "ACTIVE" }] };
    res.end("ok");
  } }],
});
const browser = await ensureUiBrowser(process.env, console.error);
const env = sessionEnv({ home: fixture.info.dataDir, session: `dashboard-${new URL(fixture.info.url).port}`, chrome: browser.chrome });
const socketDir = await mkdtemp("/tmp/omb-db-");
env.AGENT_BROWSER_SOCKET_DIR = socketDir;
const run = (args: string[]) => { console.log(args.slice(0, 3).join(" ")); return agentBrowser(browser.binary, env, args, 60_000); };
const evaluate = (js: string) => run(["eval", js]);
const wait = (js: string) => run(["wait", "--fn", js]);
const click = (label: string) => run(["find", "role", "button", "click", "--name", label, "--exact"]);
try {
  console.log(JSON.stringify({ ...fixture.info, previewUrl: preview.previewUrl }));
  await run(["open", preview.previewUrl]);
  await run(["set", "viewport", "1440", "900"]);
  await wait(String.raw`document.querySelector("[aria-label=\"Configure dashboard\"]")?.getAttribute("aria-pressed") === "true"`);
  await run(["screenshot", `${output}/empty-midnight.png`]);
  await writeFile(`${output}/empty.json`, JSON.stringify(await run(["snapshot"]), null, 2));
  await click("Open Apps");
  await click("Connect fixture accounts");
  await wait(String.raw`document.querySelectorAll("input[type=checkbox]").length === 2`);
  await run(["find", "label", "Home", "check"]);
  await wait(String.raw`!document.body.textContent.includes("Saving calendar selection")`);
  await click("Configure dashboard");
  await wait(String.raw`document.querySelector("[aria-label=Agenda]")?.textContent.includes("Family trip")`);
  await click("Reopen dashboard");
  await wait(String.raw`document.querySelector("[aria-label=\"Configure dashboard\"]")?.getAttribute("aria-pressed") === "false" && document.querySelector("[aria-label=Agenda]")?.textContent.includes("Family trip")`);
  await run(["screenshot", `${output}/presentation-midnight.png`]);
  const desktopLayout = await evaluate(String.raw`JSON.stringify({ width: innerWidth, height: innerHeight, agenda: document.querySelector("[aria-label=Agenda]").parentElement.getBoundingClientRect().toJSON(), countdown: document.querySelector("[aria-label=Countdowns] ul")?.getBoundingClientRect().toJSON() })`);
  await writeFile(`${output}/desktop-layout.json`, JSON.stringify(desktopLayout, null, 2));
  await click("Configure dashboard");
  await run(["find", "label", "School", "check"]);
  await evaluate(String.raw`document.querySelector("input[type=checkbox]").click(); true`);
  await wait(String.raw`document.body.textContent.includes("Calendar source: School")`);
  await evaluate(String.raw`document.querySelector("select[aria-label=\"Google Tasks account\"]").value = "parents"; document.querySelector("select[aria-label=\"Google Tasks account\"]").dispatchEvent(new Event("change", { bubbles: true })); true`);
  await wait(String.raw`document.body.textContent.includes("Connected to Parents")`);
  await click("Configure dashboard");
  await wait(String.raw`document.body.textContent.includes("parents chore")`);
  await click("Configure dashboard");
  await evaluate(String.raw`document.querySelector("select[aria-label=\"Google Tasks account\"]").value = "kids"; document.querySelector("select[aria-label=\"Google Tasks account\"]").dispatchEvent(new Event("change", { bubbles: true })); true`);
  await wait(String.raw`document.body.textContent.includes("Connected to Kids")`);
  await click("Configure dashboard");
  await wait(String.raw`document.body.textContent.includes("kids chore") && !document.body.textContent.includes("parents chore")`);
  await evaluate(String.raw`document.documentElement.dataset.skin = "daylight"; true`);
  await run(["screenshot", `${output}/presentation-daylight.png`]);
  await click("Configure dashboard");
  await run(["screenshot", `${output}/configuration-daylight.png`]);
  await run(["set", "viewport", "390", "844"]);
  await evaluate(String.raw`document.querySelector("[aria-label=\"Configure dashboard\"]").focus(); true`);
  await run(["press", "Tab"]);
  await run(["press", "Shift+Tab"]);
  await wait(String.raw`document.activeElement?.getAttribute("aria-label") === "Configure dashboard"`);
  await run(["press", "Enter"]);
  await wait(String.raw`document.querySelector("[aria-label=\"Configure dashboard\"]").getAttribute("aria-pressed") === "false"`);
  await run(["screenshot", `${output}/narrow-daylight.png`]);
  const layout = await evaluate(String.raw`JSON.stringify({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, toggle: document.querySelector("[aria-label=\"Configure dashboard\"]").getBoundingClientRect().toJSON(), focus: getComputedStyle(document.activeElement).outlineStyle })`);
  await writeFile(`${output}/layout.json`, JSON.stringify(layout, null, 2));
  await writeFile(`${output}/console.json`, JSON.stringify(await run(["console"]), null, 2));
  await writeFile(`${output}/final.json`, JSON.stringify(await run(["snapshot"]), null, 2));
  await writeFile(`${output}/requests.json`, JSON.stringify(apps.calls, null, 2));
  console.log(`Verified dashboard flow; evidence: ${output}`);
} catch (error) {
  console.error(JSON.stringify(await run(["snapshot"])));
  console.error(JSON.stringify(await run(["console"])));
  await run(["screenshot", `${output}/failure.png`]);
  throw error;
} finally {
  await run(["close"]).catch(() => {});
  await preview.close();
  await fixture.close();
  await apps.close();
  await rm(socketDir, { recursive: true, force: true });
}
