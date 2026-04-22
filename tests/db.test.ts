import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { RuntimeDatabase } from "../src/db";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `trr-${name}-`));
}

describe("runtime database", () => {
  test("reclaims a dead-owner lock before timing out", () => {
    const workspace = tempDir("db-lock");
    const storePath = path.join(workspace, "store.json");
    const lockPath = `${storePath}.lock`;

    const db = new RuntimeDatabase(storePath);
    db.close();

    fs.writeFileSync(lockPath, `999999\n${Date.now()}\n`);

    const reopened = new RuntimeDatabase(storePath);
    const session = reopened.createSession({
      provider: "custom",
      model: "lock-test",
      workspaceRoot: workspace
    });

    expect(session.id).toBeTruthy();
    expect(fs.existsSync(lockPath)).toBe(false);
    reopened.close();
  });
});
