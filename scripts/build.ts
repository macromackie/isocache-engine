import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/@typescript/native/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
