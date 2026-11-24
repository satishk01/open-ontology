// Records the no-LLM demo: a fresh workspace goes through setup with no AI
// provider — open datasets upload, the deterministic ontology suggestion is
// confirmed, the build runs as code, and the published graph + Ossie export
// are shown. Run with the dev stack up (pnpm dev):
//   tsx scripts/demo-video.ts
// Output: demo-video/<random>.webm
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.DEMO_BASE_URL || "http://127.0.0.1:5173";
const OUT = resolve("demo-video");
const FILES = [
  "customers.csv",
  "orders.csv",
  "order_details.csv",
  "products.csv",
  "Telco-Customer-Churn.csv",
  "rfc2616.txt",
].map((name) => ({
  name,
  mimeType: name.endsWith(".csv") ? "text/csv" : "text/plain",
  buffer: readFileSync(resolve(process.env.DEMO_DATA || "/tmp/demo-data", name)),
}));

const api = async (page: any, path: string, data?: unknown) => {
  const r =
    data === undefined
      ? await page.request.get(BASE + "/api/v1" + path)
      : await page.request.post(BASE + "/api/v1" + path, { data });
  if (!r.ok()) throw new Error(`${path}: ${r.status()} ${await r.text()}`);
  return r.json();
};

// A caption bar pinned to the bottom of the viewport. Injected once per page
// load (SPA navigations keep it); title() swaps the text.
async function caption(page: any, text: string) {
  await page.evaluate((t) => {
    let bar = document.getElementById("demo-caption");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "demo-caption";
      bar.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;" +
        "z-index:2147483647;background:rgba(17,20,28,.92);color:#fff;" +
        "padding:10px 22px;border-radius:8px;font:600 15px/1.3 system-ui;" +
        "letter-spacing:.2px;box-shadow:0 4px 24px rgba(0,0,0,.35);" +
        "pointer-events:none;max-width:80%;text-align:center;";
      document.body.appendChild(bar);
    }
    bar.textContent = t;
  }, text);
}
const beat = (page: any, ms = 2800) => page.waitForTimeout(ms);
const state = (page: any, ws: string) =>
  api(page, `/workspaces/${ws}/onboarding`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
mkdirSync(OUT, { recursive: true });

// A fresh workspace so the video shows the whole journey, not the result.
await page.goto(BASE + "/");
await page.waitForFunction(() =>
  localStorage.getItem("foundry.workspace"),
);
const workspace = await api(page, "/workspaces", {
  name: "Customer 360 — no-LLM demo",
});
const ws = workspace.id as string;
await page.evaluate(
  (id) => localStorage.setItem("foundry.workspace", id),
  ws,
);

// 1 — AI step: continuing without choosing a provider is the no-LLM path.
await page.goto(BASE + "/onboarding");
await page.waitForSelector(".provider-setup");
await caption(page, "Helix Foundry — building a customer ontology with no LLM");
await beat(page);
await caption(page, "Step 1 — AI: we simply continue without one");
await beat(page);
await page
  .locator(".provider-setup button:has-text('Continue')")
  .first()
  .click();

// 2 — Data step: the open datasets upload; the list refreshes by polling.
await page.waitForSelector(".sample-option");
await caption(
  page,
  "Step 2 — Data: six open datasets upload (Northwind, IBM telco churn, an RFC)",
);
await beat(page);
for (const f of FILES)
  await page.request.post(BASE + `/api/v1/workspaces/${ws}/upload`, {
    multipart: { file: f },
  });
await page.waitForFunction(
  async (w) => {
    const s = await (
      await fetch(`/api/v1/workspaces/${w}/onboarding`)
    ).json();
    return s.datasets.length >= 6 && s.inputsReady;
  },
  ws,
  { timeout: 60000 },
);
await caption(
  page,
  "customers · orders · order_details · products · Telco churn · rfc2616 — ingested and profiled",
);
await beat(page, 4000);
await page.locator("button.primary:has-text('Continue')").click();

// 3 — Ontology step: the suggestion is computed deterministically; the UI
// fetches it itself. Wait for the entity cards to render.
await page.waitForSelector(".so-confirm", { timeout: 90000 });
await caption(
  page,
  "Step 3 — Ontology: entities and links suggested from the data, no model involved",
);
await beat(page, 5000);
await page.evaluate(() => window.scrollTo(0, 0));
await caption(
  page,
  "Order → Customer matched on customerID (830/830 rows); junction and unlinked tables reported honestly",
);
await beat(page, 5000);

// 4 — Confirm: the build is code from here — records, links, dashboard.
await page
  .locator("button.primary:has-text('build my workspace')")
  .click();
await page.waitForSelector(".build-scene", { timeout: 15000 }).catch(() => {});
await caption(
  page,
  "Confirmed — the build runs as code: records, relationships, validation, publish",
);
await page.waitForURL(BASE + "/", { timeout: 180000 });
await beat(page);

// 5 — Published workspace: Home counts and the computed Overview dashboard.
await caption(
  page,
  "Published: 14,952 records across 5 object types — computed Overview dashboard",
);
await beat(page, 4000);
await page.evaluate(() =>
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
);
await beat(page, 4000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await beat(page);

// 6 — The record graph: 830 “billed to” edges materialized in HelixDB.
await page.goto(BASE + "/ontology/explore");
await page.waitForTimeout(6000);
await caption(
  page,
  "The record graph — Orders joined to Customers through the confirmed link type",
);
await beat(page, 6000);

// 7 — A Customer record with its orders as neighbors.
const graph = await api(page, `/workspaces/${ws}/graph?limit=1000`);
const customer = graph.nodes.find(
  (n: any) => n.type === "Customer" && n.degree > 0,
);
if (customer) {
  await page.goto(BASE + `/records/${customer.id}`);
  await page.waitForTimeout(4000);
  await caption(
    page,
    `A Customer record — fields plus linked Orders as graph neighbors`,
  );
  await beat(page, 6000);
}

// 8 — The Ossie (Apache) ontology export: the open interchange NVIDIA Auto
// Ontology and other Ossie-aware tools speak.
await page.goto(BASE + `/api/v1/workspaces/${ws}/ontology/export`);
await caption(
  page,
  "GET /ontology/export — the workspace ontology as an Apache Ossie document",
);
await beat(page, 6000);
await caption(page, "Done — every step ran with zero LLM calls");
await beat(page, 5000);

await context.close();
await browser.close();
console.log(`Video written under ${OUT}`);
