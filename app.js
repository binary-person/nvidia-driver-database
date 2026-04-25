#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { createRuntimeControl, runCli } = require("./lib/nvidia-driver-db");

async function main() {
  const rootDir = path.resolve(__dirname);
  const runtimeControl = createRuntimeControl();
  const handleSigint = () => {
    runtimeControl.requestShutdown();
  };

  process.on("SIGINT", handleSigint);
  try {
    const exitCode = await runCli(process.argv.slice(2), {
      rootDir,
      fetchImpl: globalThis.fetch,
      stdout: process.stdout,
      stderr: process.stderr,
      runtimeControl,
    });
    process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", handleSigint);
  }
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
