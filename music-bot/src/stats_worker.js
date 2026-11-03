// Dashboard archive stats on a worker thread with a read-only connection:
// the counts walk whole tables (hundreds of thousands of rows), which takes
// tens of seconds on home's disk and would freeze the server.
import { parentPort, workerData } from "node:worker_threads";
import { Catalog } from "./catalog.js";

const { file, days, channels } = workerData;
const c = new Catalog(file, { readOnly: true });
try {
  parentPort.postMessage({
    ok: true,
    data: {
      ...c.stats(days),
      graph: c.graphStats(),
      videos: c.videoStats(),
      backups: c.backupStats(channels),
    },
  });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
} finally {
  c.db.close();
}
