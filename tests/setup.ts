import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSaltCache } from "../src/state.js";

process.env.KEYMAP_HOME = mkdtempSync(join(tmpdir(), "keymap-home-"));
delete process.env.KEYMAP_ALLOW_TRACKED_ENV;
resetSaltCache();
