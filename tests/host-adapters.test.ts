import { describe, expect, test } from "vitest";

import { defaultConfig } from "../src/config";
import { adapterForHost, CodexHostAdapter, GenericPtyHostAdapter } from "../src/host-adapters";

describe("host adapters", () => {
  test("detect compaction and resume needs", () => {
    expect(CodexHostAdapter.detectCompaction("Context window full. Compacting conversation...").matched).toBe(true);
    expect(CodexHostAdapter.detectNeedResume("Need runtime recovery packet to continue.").matched).toBe(true);
  });

  test("extract plan hints from structured line", () => {
    const hint = GenericPtyHostAdapter.extractPlanHints(
      'TRR_PLAN {"items":[{"id":"patch","text":"Patch token refresh logic","status":"in_progress"}],"nextAction":"Patch token refresh logic"}'
    );
    expect(hint?.nextAction).toBe("Patch token refresh logic");
    expect(hint?.items).toHaveLength(1);
  });

  test("merges configured detection patterns for host-specific variants", () => {
    const config = defaultConfig("/tmp/trr-host-adapter");
    config.hostProfiles.codex.detection.sessionStartPatterns = ["agent online"];
    config.hostProfiles.codex.detection.compactionPatterns = ["silent compacted"];
    config.hostProfiles.codex.detection.resumeNeedPatterns = ["recover my state"];

    const adapter = adapterForHost("codex", config.hostProfiles.codex);

    expect(adapter.detectSessionStart("agent online")).toBe(true);
    expect(adapter.detectCompaction("silent compacted by provider").matched).toBe(true);
    expect(adapter.detectNeedResume("recover my state before continuing").matched).toBe(true);
  });
});
