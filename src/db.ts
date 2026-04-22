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

function sleepMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class RuntimeDatabase {
  private store: StoreShape;
  private readonly storePath: string;
  private readonly lockPath: string;

  constructor(storePath = ".tmp/trr-store.json") {
    this.storePath = storePath;
    this.lockPath = `${storePath}.lock`;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    if (!fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, JSON.stringify(emptyStore(), null, 2));
    }
    this.store = this.readStore();
  }

  close(): void {
    // Writes are flushed eagerly in each mutating method. Avoid flushing stale in-memory
    // state here because shell shims may have updated the same store concurrently.
  }

  initialize(): void {}

  private readStore(): StoreShape {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const raw = fs.readFileSync(this.storePath, "utf8");
        if (!raw.trim()) {
          throw new Error("store file is temporarily empty");
        }
        return JSON.parse(raw) as StoreShape;
      } catch (error) {
        lastError = error;
        if (attempt === 5) break;
        sleepMs(10);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private reload(): void {
    this.store = this.readStore();
  }

  private flush(): void {
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.store, null, 2));
    try {
      fs.renameSync(tempPath, this.storePath);
    } catch {
      fs.rmSync(this.storePath, { force: true });
      fs.renameSync(tempPath, this.storePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  private withWriteLock<T>(operation: () => T): T {
    let lockFd: number | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        lockFd = fs.openSync(this.lockPath, "wx");
        fs.writeFileSync(lockFd, `${process.pid}\n${Date.now()}\n`);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        try {
          const raw = fs.readFileSync(this.lockPath, "utf8");
          const [pidLine] = raw.split(/\r?\n/, 1);
          const pid = Number(pidLine);
          const stats = fs.statSync(this.lockPath);
          if ((Number.isFinite(pid) && pid > 0 && !isProcessAlive(pid)) || Date.now() - stats.mtimeMs > 30_000) {
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (attempt === 399) {
          throw new Error(`timed out waiting for store lock: ${this.lockPath}`);
        }
        sleepMs(25);
      }
    }

    try {
      return operation();
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
      }
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    return this.withWriteLock(() => {
      this.reload();
      const record: SessionRecord = {
        id: input.id ?? generateId("sess"),
        provider: input.provider,
        model: input.model,
        host: input.host,
        workspaceRoot: input.workspaceRoot,
        createdAt: nowIso()
      };
      this.store.sessions.push(record);
      this.flush();
      return record;
    });
  }

  getSession(sessionId: string): SessionRecord | undefined {
    this.reload();
    return this.store.sessions.find((session) => session.id === sessionId);
  }

  listSessions(): SessionRecord[] {
    this.reload();
    return [...this.store.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  appendEvent(input: AppendEventInput): EventRecord {
    return this.withWriteLock(() => {
      this.reload();
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
    });
  }

  listEvents(
    sessionId: string,
    options?: { fromSeq?: number; toSeq?: number; limit?: number }
  ): EventRecord[] {
    this.reload();
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
    return this.withWriteLock(() => {
      this.reload();
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
    });
  }

  listArtifacts(sessionId: string, sourceEventIds?: string[]): ArtifactRef[] {
    this.reload();
    const sourceSet = sourceEventIds ? new Set(sourceEventIds) : undefined;
    return this.store.artifacts.filter(
      (artifact) =>
        artifact.sessionId === sessionId &&
        (!sourceSet || sourceSet.has(artifact.sourceEventId))
    );
  }

  saveCheckpoint(input: SaveCheckpointInput): CheckpointState {
    return this.withWriteLock(() => {
      this.reload();
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
    });
  }

  getLatestCheckpoint(sessionId: string): CheckpointState | undefined {
    this.reload();
    return [...this.store.checkpoints]
      .filter((checkpoint) => checkpoint.sessionId === sessionId)
      .sort((a, b) => b.eventRange.toSeq - a.eventRange.toSeq || b.createdAt.localeCompare(a.createdAt))[0];
  }

  listCheckpoints(sessionId: string): CheckpointState[] {
    this.reload();
    return this.store.checkpoints
      .filter((checkpoint) => checkpoint.sessionId === sessionId)
      .sort((a, b) => a.eventRange.toSeq - b.eventRange.toSeq);
  }

  saveFingerprint(input: SaveFingerprintInput): ActionFingerprint {
    return this.withWriteLock(() => {
      this.reload();
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
    });
  }

  findLatestFingerprint(sessionId: string, hash: string): ActionFingerprint | undefined {
    this.reload();
    return [...this.store.actionFingerprints]
      .filter((fingerprint) => fingerprint.sessionId === sessionId && fingerprint.hash === hash)
      .sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0];
  }
}
