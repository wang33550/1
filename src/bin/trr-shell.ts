#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

async function main(): Promise<void> {
  const originalShell =
    process.env.TRR_ORIGINAL_SHELL || process.env.SHELL || "/bin/bash";
  const args = process.argv.slice(2);
  const child = spawn(originalShell, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
