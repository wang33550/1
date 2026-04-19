import { TaskRecoveryRuntime } from "../src/runtime";

const runtime = new TaskRecoveryRuntime({ dbPath: ".tmp/example-store.json", minTailEvents: 2 });

const session = runtime.createSession({
  provider: "custom",
  model: "demo-agent",
  workspaceRoot: process.cwd()
});

runtime.recordEvent({
  sessionId: session.id,
  kind: "user_message",
  payload: {
    text: "Refactor the auth service and keep all existing tests green."
  }
});

runtime.recordEvent({
  sessionId: session.id,
  kind: "plan_update",
  payload: {
    items: [
      { id: "inspect", text: "Inspect auth service dependencies", status: "done" },
      { id: "refactor", text: "Refactor token validation flow", status: "in_progress" },
      { id: "verify", text: "Run auth tests", status: "pending" }
    ],
    nextAction: "Refactor token validation flow"
  }
});

runtime.recordEvent({
  sessionId: session.id,
  kind: "file_write",
  payload: {
    path: "src/auth/service.ts",
    summary: "Extracted token validation into a dedicated helper."
  }
});

runtime.createCheckpoint(session.id, true);

const resume = runtime.buildResumePacket(session.id);
console.log(resume.packet);

runtime.close();
