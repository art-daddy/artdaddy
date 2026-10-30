// A copy of a project (Duplicate, Save As) is a copy of its FILES, and two of them are a claim on something that is not in the folder:
// the job record names the orders the server is making for this project, and the catalog shows the placeholders waiting for them.
// Left as they were, the copy would be a second owner of the original's work. Opened, it would ask the server for those orders,
// collect their results into the copy, and CONFIRM them, which deletes them from the server, so the original, which paid for them,
// would never get its result. A copy therefore starts with none of the original's running work: it is recorded as cut short, no order
// is named, and its placeholders say where the result will arrive.
import {
  atomicWriteText,
  INTERNAL_DIR,
  joinPath,
  readJsonOrRecover,
  type FsLike,
} from "../tools/store";
import { jobsPath, type JobRecord } from "./jobLedger";

export const COPIED_WHILE_RUNNING =
  "this was still being made when the project was copied, and it arrives in the project it was started in, not in this copy";

interface JobsFile {
  version?: number;
  jobs?: JobRecord[];
}

interface CatalogFile {
  clips?: Record<string, unknown>[];
}

/** Make the copy in ``projectDir`` hold none of the original's running work. Only the copy is written; nothing is invented for a
 *  project that has no job record or catalog. Throws when the copy cannot be written, and the caller must then not hand out a copy
 *  that could still adopt the original's order. */
export async function releaseCopiedWork(fs: FsLike, projectDir: string): Promise<void> {
  const jobsFile = jobsPath(projectDir);
  const ledger = await readJsonOrRecover<JobsFile | null>(fs, jobsFile, null);
  if (ledger && Array.isArray(ledger.jobs)) {
    let changed = false;
    for (const job of ledger.jobs) {
      if ("order_id" in job) {
        delete job.order_id;
        changed = true;
      }
      if (job.status === "running") {
        job.status = "interrupted";
        job.ended_at = Date.now();
        job.error = COPIED_WHILE_RUNNING;
        changed = true;
      }
    }
    if (changed) await atomicWriteText(fs, jobsFile, JSON.stringify(ledger, null, 2));
  }

  const catalogFile = joinPath(projectDir, INTERNAL_DIR, "library.json");
  const catalog = await readJsonOrRecover<CatalogFile | null>(fs, catalogFile, null);
  if (catalog && Array.isArray(catalog.clips)) {
    let changed = false;
    for (const row of catalog.clips) {
      if (row && row.status === "generating" && row.added_by === "generation") {
        row.status = "failed";
        row.error = COPIED_WHILE_RUNNING;
        changed = true;
      }
    }
    if (changed) await atomicWriteText(fs, catalogFile, JSON.stringify(catalog, null, 2));
  }
}
