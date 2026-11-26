// Holds the app open on a ready project for the by-hand Save As script (e2e/byhand/export/save-as.md), which is
// done with computer use. Runs only when named: `run.mjs byhand-hold`. The run's clean-up removes the project.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { root } from "../app.mjs";
import { projectWith } from "./01-dialog.mjs";

export const scenarios = [
  {
    name: "byhand-hold",
    group: "byhand",
    named: true,
    async run(t) {
      await projectWith(t, "by hand", [
        { file: t.fixtures.red(), at: 0 },
        { file: t.fixtures.blue(), at: 90 },
      ]);
      const folder = path.join(root, "reports", "qa", "export", "byhand");
      mkdirSync(folder, { recursive: true });
      const stop = path.join(folder, "stop");
      rmSync(stop, { force: true });
      console.log(`  the app (pid ${t.pid}) is ready on "sweep_qa-export by hand"; create ${stop} to end (15 min at most)`);
      const end = Date.now() + 15 * 60_000;
      while (Date.now() < end && !existsSync(stop) && t.app.running()) await t.sleep(1000);
      rmSync(stop, { force: true });
      t.note("held for the by-hand script; its results are recorded by whoever ran it");
    },
  },
];
