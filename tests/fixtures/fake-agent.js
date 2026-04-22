#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const mode = process.env.FAKE_AGENT_MODE || "compaction";
const restartCount = Number(process.env.TRR_AUTO_RESTART_COUNT || "0");
const expectedNextAction = "Patch token refresh logic";

process.stdin.setEncoding("utf8");

function waitForResume(successMarker) {
  let buffer = "";
  const timeout = setTimeout(() => {
    console.error("resume packet not received");
    process.exit(2);
  }, 1500);

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes("[TRR_RESUME_PACKET_BEGIN")) return;
    if (buffer.includes(expectedNextAction)) {
      clearTimeout(timeout);
      console.log(successMarker);
      process.exit(0);
    }
  });
}

function runShellCommand(command) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { stdio: "inherit" });
  }
  return spawnSync(process.env.SHELL || "bash", ["-lc", command], { stdio: "inherit" });
}

if (mode === "compaction") {
  console.log("READY>");
  console.log(
    `TRR_PLAN ${JSON.stringify({
      items: [
        { id: "inspect", text: "Inspect flaky auth test", status: "done" },
        { id: "patch", text: expectedNextAction, status: "in_progress" }
      ],
      nextAction: expectedNextAction
    })}`
  );
  setTimeout(() => console.log("Context window full. Compacting conversation..."), 40);
  setTimeout(() => console.log("Need runtime recovery packet to continue."), 80);
  waitForResume("RESUME_OK");
}

if (mode === "compaction_twice") {
  console.log("READY>");
  console.log(
    `TRR_PLAN ${JSON.stringify({
      items: [
        { id: "inspect", text: "Inspect flaky auth test", status: "done" },
        { id: "patch", text: expectedNextAction, status: "in_progress" }
      ],
      nextAction: expectedNextAction
    })}`
  );
  setTimeout(() => console.log("Context window full. Compacting conversation..."), 40);
  setTimeout(() => console.log("Need runtime recovery packet to continue."), 60);
  setTimeout(() => console.log("Context window full. Compacting conversation..."), 80);
  setTimeout(() => console.log("Need runtime recovery packet to continue."), 100);
  waitForResume("RESUME_OK");
}

if (mode === "guard") {
  console.log("READY>");
  console.log(
    `TRR_PLAN ${JSON.stringify({
      items: [{ id: "patch", text: expectedNextAction, status: "in_progress" }],
      nextAction: expectedNextAction
    })}`
  );
  runShellCommand("dangerous-cmd deploy");
  runShellCommand("dangerous-cmd deploy");
  runShellCommand("vitest sample");
  runShellCommand("vitest sample");
  console.log("GUARD_DONE");
  process.exit(0);
}

if (mode === "restart") {
  if (restartCount === 0) {
    console.log("READY>");
    console.log(
      `TRR_PLAN ${JSON.stringify({
        items: [{ id: "patch", text: expectedNextAction, status: "in_progress" }],
        nextAction: expectedNextAction
      })}`
    );
    console.error("simulated crash");
    process.exit(12);
  }
  console.log("READY>");
  setTimeout(() => console.log("Need runtime recovery packet to continue."), 50);
  waitForResume("RESTART_RESUME_OK");
}

if (mode === "stdin_eof") {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\u0004") || buffer.includes("\u001a")) {
      if (buffer.includes("EOF_PROBE")) {
        console.log("EOF_OK");
        process.exit(0);
      }
      console.error("missing probe content");
      process.exit(3);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.includes("EOF_PROBE")) {
      console.log("EOF_OK");
      process.exit(0);
    }
    console.error("missing probe content");
    process.exit(3);
  });
}
