import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { CONFIG_FILE_NAME, defaultConfig, loadConfig, writeDefaultConfig } from "../src/config";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("config", () => {
  test("writes and loads default config", () => {
    const workspace = tempDir("config");
    const configPath = writeDefaultConfig(workspace);
    const config = loadConfig(workspace);

    expect(path.basename(configPath)).toBe(CONFIG_FILE_NAME);
    expect(config.defaultHost).toBe("codex");
    expect(config.workspaceRoot).toBe(workspace);
    expect(config.guardPolicy.hardBlockCommandPrefixes).toContain("git push");
  });

  test("default config uses expected host profiles", () => {
    const workspace = tempDir("config-default");
    const config = defaultConfig(workspace);
    expect(config.hostProfiles.codex.command).toBe("codex");
    expect(config.hostProfiles.claude.command).toBe("claude");
    expect(config.hostProfiles["generic-pty"].command).toBe("");
  });

  test("loadConfig anchors workspaceRoot to the config directory", () => {
    const workspace = tempDir("config-anchor");
    fs.writeFileSync(
      path.join(workspace, CONFIG_FILE_NAME),
      JSON.stringify({
        workspaceRoot: "/mnt/c/some/other/place",
        storePath: ".trr/custom-store.json"
      })
    );

    const config = loadConfig(workspace);
    expect(config.workspaceRoot).toBe(workspace);
    expect(config.storePath).toBe(".trr/custom-store.json");
  });

  test("loadConfig deep merges host profile detection settings", () => {
    const workspace = tempDir("config-host-merge");
    fs.writeFileSync(
      path.join(workspace, CONFIG_FILE_NAME),
      JSON.stringify({
        hostProfiles: {
          codex: {
            command: "codex-beta",
            detection: {
              compactionPatterns: ["silent compacted"]
            }
          }
        }
      })
    );

    const config = loadConfig(workspace);
    expect(config.hostProfiles.codex.command).toBe("codex-beta");
    expect(config.hostProfiles.codex.model).toBe("codex");
    expect(config.hostProfiles.codex.args).toEqual([]);
    expect(config.hostProfiles.codex.detection.compactionPatterns).toContain("silent compacted");
    expect(config.hostProfiles.codex.detection.resumeNeedPatterns).toEqual([]);
  });
});
