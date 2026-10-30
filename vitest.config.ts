import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Poistka: testy nikdy nesmú siahnuť na skutočné konfigurácie Claude.
const sandbox = mkdtempSync(join(tmpdir(), "inbox-sandbox-"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30000,
    env: {
      CLAUDE_INBOX_SETTINGS: join(sandbox, "settings.json"),
      CLAUDE_INBOX_DESKTOP_CONFIG: join(sandbox, "desktop.json"),
      CLAUDE_INBOX_HOME: join(sandbox, "home"),
    },
  },
});
