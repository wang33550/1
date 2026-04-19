import fs from "node:fs";
import path from "node:path";

import type {
  ActionFingerprint,
  AppendEventInput,
  ArtifactRef,
  CheckpointState,
  CreateSessionInput,
  EventRecord,
  SaveArtifactInput,
  SaveCheckpointInput,
  SaveFingerprintInput,
  SessionRecord
} from "./types";
import { generateId, nowIso } from "./utils";

interface StoreShape {
  sessions: SessionRecord[];
  events: EventRecord[];
  artifacts: ArtifactRef[];
  checkpoints: CheckpointState[];
  actionFingerprints: ActionFingerprint[];
}

function emptyStore(): StoreShape {
  return {
    sessions: [],
    events: [],
    artifacts: [],
    checkpoints: [],
    actionFingerprints: []
  };
}

export class RuntimeDatabase {
  private store: StoreShape;
  private readonly storePath: string;

  constructor(storePath = ".tmp/trr-store.json") {
    this.storePath = storePath;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    if (!fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, JSON.stringify(emptyStore(), null, 2));
    }
    this.store = this.readStore();
  }

  close(): void {
    this.flush();
  }

  initialize(): void {}

  private readStore(): StoreShape {
    const raw = fs.readFileSync(this.storePath, "utf8");
    return JSON.parse(raw) as StoreShape;
  }

  private flush(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const record: SessionRecord = {
      id: input.id ?? generateId("sess"),
      provider: input.provider,
      model: input.model,
      workspaceRoot: input.workspaceRoot,
      createdAt: nowIso()
    };
    this.store.sessions.push(record);
    this.flush();
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.sessions.find((session) => session.id === sessionId);
  }

  listSessions(): SessionRecord[] {
    return [...this.store.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  appendEvent(input: AppendEventInput): EventRecord {
    const seq = this.getLatestSeq(input.sessionId) + 1;
    const record: EventRecord = {
      id: input.id ?? generateId("evt"),
      sessionId: input.sessionId,
      seq,
      ts: input.ts ?? nowIso(),
      kind: input.kind,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      payload: input.payload,
      tokenEstimate: input.tokenEstimate
    };
    this.store.events.push(record);
    this.flush();
    return record;
  }

  listEvents(
    sessionId: string,
    options?: { fromSeq?: number; toSeq?: number; limit?: number }
  ): EventRecord[] {
    let rows = this.store.events
      .filter((event) => event.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
    if (options?.fromSeq !== undefined) {
      rows = rows.filter((event) => event.seq >= options.fromSeq!);
    }
    if (options?.toSeq !== undefined) {
      rows = rows.filter((event) => event.seq <= options.toSeq!);
    }
    if (options?.limit !== undefined) {
      rows = rows.slice(0, options.limit);
    }
    return rows;
  }

  getLatestSeq(sessionId: string): number {
    return this.store.events
      .filter((event) => event.sessionId === sessionId)
      .reduce((max, event) => Math.max(max, event.seq), 0);
  }

  saveArtifact(input: SaveArtifactInput): ArtifactRef {
    const artifact: ArtifactRef = {
      id: input.id ?? generateId("art"),
      sessionId: input.sessionId,
      type: input.type,
      title: input.title,
      uri: input.uri,
      contentHash: input.contentHash,
      summary: input.summary,
      sourceEventId: input.sourceEventId,
      metadata: input.metadata
    };
    this.store.artifacts.push(artifact);
    this.flush();
    return artifact;
  }

  listArtifacts(sessionId: string, sourceEventIds?: string[]): ArtifactRef[] {
    const sourceSet = sourceEventIds ? new Set(sourceEventIds) : undefined;
    return this.store.artifacts.filter(
      (artifact) =>
        artifact.sessionId === sessionId &&
        (!sourceSet || sourceSet.has(artifact.sourceEventId))
    );
  }

  saveCheckpoint(input: SaveCheckpointInput): CheckpointState {
    const checkpointId = input.id ?? input.state.checkpointId ?? generateId("chk");
    const createdAt = input.createdAt ?? input.state.createdAt ?? nowIso();
    const state: CheckpointState = {
      ...input.state,
      checkpointId,
      createdAt
    };
    this.store.checkpoints.push(state);
    this.flush();
    return state;
  }

  getLatestCheckpoint(sessionId: string): CheckpointState | undefined {
    return [...this.store.checkpoints]
      .filter((checkpoint) => checkpoint.sessionId === sessionId)
      .sort((a, b) => b.eventRange.toSeq - a.eventRange.toSeq || b.createdAt.localeCompare(a.createdAt))[0];
  }

  listCheckpoints(sessionId: string): CheckpointState[] {
    return this.store.checkpoints
      .filter((checkpoint) => checkpoint.sessionId === sessionId)
      .sort((a, b) => a.eventRange.toSeq - b.eventRange.toSeq);
  }

  saveFingerprint(input: SaveFingerprintInput): ActionFingerprint {
    const fingerprint: ActionFingerprint = {
      id: input.id ?? generateId("afp"),
      sessionId: input.sessionId,
      actionType: input.actionType,
      normalizedSignature: input.normalizedSignature,
      hash: input.hash,
      repeatPolicy: input.repeatPolicy,
      sourceEventId: input.sourceEventId,
      artifactIds: input.artifactIds,
      dependsOnPaths: input.dependsOnPaths,
      envDigest: input.envDigest,
      resourceDigests: input.resourceDigests,
      executedAt: input.executedAt ?? nowIso()
    };
    this.store.actionFingerprints.push(fingerprint);
    this.flush();
    return fingerprint;
  }

  findLatestFingerprint(sessionId: string, hash: string): ActionFingerprint | undefined {
    return [...this.store.actionFingerprints]
      .filter((fingerprint) => fingerprint.sessionId === sessionId && fingerprint.hash === hash)
      .sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0];
  }
}
