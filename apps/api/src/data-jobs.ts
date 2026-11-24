// Data Connection job handlers (upload, sync), dispatched by the worker in jobs.ts.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Resource } from "../../../packages/shared/src/index.js";
import { jobProgress } from "./setup-jobs.js";
import { prepareSourceSync } from "./source-sync.js";
import { transaction, now, type Store } from "./store.js";
import { importSource } from "./connectors.js";
import { ingestFile } from "./datasets.js";
import { unseal } from "./security.js";
import { config } from "./config.js";
import { extractEntities, isDocumentFile } from "./extract.js";
import { providerSettings, recordUsage } from "./assistant.js";
import { Provider } from "./providers.js";

export async function runUploadJob(store: Store, scope: string, job: Resource) {
  await jobProgress(store, scope, job.id, {
    message: "Importing and profiling complete file",
  });
  await ingestFile(
    store,
    scope,
    job.name,
    job.data.file,
    undefined,
    job.data.datasetId,
    job.id,
    undefined,
    job.id,
  );
  if (job.data.entities && isDocumentFile(job.data.file)) {
    const report = async (step: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        await jobProgress(store, scope, job.id, {
          message: `Document imported; ${step} failed`,
        });
      }
    };
    await report("entity extraction", () =>
      extractEntitiesDataset(
        store,
        scope,
        job.name,
        job.data.file,
        job.id,
        job.data.datasetId,
        (message) => jobProgress(store, scope, job.id, { message }),
      ),
    );
  }
}

// Reads the {page,text} JSONL that ingestFile derived from a document.
async function readDocumentRows(scope: string, file: string) {
  const rowsFile = file.replace(/\.[^.]+$/, ".jsonl"),
    rows: { page: number; text: string }[] = [];
  try {
    for (const line of (
      await readFile(
        resolve(config.dataDir, "incoming", scope, rowsFile),
        "utf8",
      )
    ).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.page === "number" && typeof r.text === "string" && r.text)
          rows.push(r);
      } catch {
        // Skip a malformed line rather than aborting extraction.
      }
    }
  } catch {
    // The derived rows file is missing (not a document, or cleaned up).
  }
  return rows;
}

// Turns a document's extracted {page,text} rows into a companion
// "<name> — entities" dataset via the workspace's AI provider. Entities give
// the ontology joinable columns, so documents connect to each other (shared
// entities) and to structured data through ordinary link types. idBase makes
// the dataset and version ids deterministic so job retries stay idempotent.
export async function extractEntitiesDataset(
  store: Store,
  scope: string,
  name: string,
  file: string,
  idBase: string,
  parentId?: string,
  progress?: (message: string) => Promise<unknown>,
) {
  const rows = await readDocumentRows(scope, file);
  if (!rows.length) return;
  await progress?.("Extracting entities and topics with AI");
  const { entities, tokens } = await extractEntities(
    rows,
    new Provider(await providerSettings(store, scope)),
  );
  // Derivation calls count toward the workspace's daily AI budget.
  await recordUsage(store, scope, tokens);
  if (!entities.length) return;
  const entitiesFile = file.replace(/\.[^.]+$/, "_entities.jsonl");
  await writeFile(
    resolve(config.dataDir, "incoming", scope, entitiesFile),
    entities.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await progress?.(`Importing ${entities.length} entities`);
  const ds = await ingestFile(
    store,
    scope,
    `${name} — entities`,
    entitiesFile,
    undefined,
    `entities_${idBase}`,
    `version_${idBase}_entities`,
  );
  if (parentId)
    await transaction(store, scope, async (tx) => {
      const d = await tx.get(ds.id);
      if (d) tx.update(d, { ...d.data, entitiesOf: parentId });
    });
  await progress?.(
    `Extracted ${entities.length} entities — see "${name} — entities"`,
  );
}

export async function runSyncJob(store: Store, scope: string, job: Resource) {
  let source = await store.get(scope, job.data.sourceId);
  if (!source) throw new Error("Source missing");
  source = await prepareSourceSync(store, scope, source);
  const changeCounter = Number(source.data.sync?.changes || 0);
  const imported = await importSource(
    scope,
    source.data.kind,
    unseal(source.data.secret),
    (p) => jobProgress(store, scope, job.id, p),
  );
  const ds = await ingestFile(
    store,
    scope,
    source.name,
    imported.file,
    source.id,
    source.data.datasetId || "source_" + source.id,
    job.id,
    imported.schema,
    job.id,
  );
  await transaction(store, scope, async (tx) => {
    const s = await tx.get(source.id);
    if (s && s.data.secret === source.data.secret)
      tx.update(s, {
        ...s.data,
        datasetId: ds.id,
        lastSync: now(),
        lastError: null,
        sync: s.data.sync
          ? { ...s.data.sync, applied: changeCounter }
          : undefined,
      });
  });
}
