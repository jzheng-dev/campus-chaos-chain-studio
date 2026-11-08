import { spawn } from "node:child_process";
// Accept both Next.js and common preview-host flags.
const args = process.argv
  .slice(2)
  .filter((v) => v !== "--strictPort")
  .map((v) => (v === "--host" ? "--hostname" : v));
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", ...args],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
