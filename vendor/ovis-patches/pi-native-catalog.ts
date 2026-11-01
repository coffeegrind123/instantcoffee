/**
 * instantcoffee: pi's live command list for Ovis (see pi-native-catalog-rows.ts
 * and .pi/extensions/ovis-bridge.ts). Copied into Ovis's server/ and imported
 * from server/index.ts by scripts/ovis_patch.py.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCatalogSource } from "./catalog-sources.ts";
import { piCatalogRows } from "./pi-native-catalog-rows.ts";

const DIR = process.env.OVIS_PI_CATALOG_DIR || "/tmp/ovis/catalog";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

registerCatalogSource({
  agent: "pi",
  // pi's own list: every extension, prompt and skill command it loaded
  owns: ["commands", "skills"],
  async rows(pane) {
    let catalog: unknown;
    try {
      catalog = JSON.parse(readFileSync(join(DIR, `${pane.pane_id}.json`), "utf8"));
    } catch {
      return null;
    }
    return piCatalogRows(catalog, pane as never, alive);
  },
});
