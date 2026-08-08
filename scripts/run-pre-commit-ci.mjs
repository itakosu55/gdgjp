import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Run the CI script with this process's Node instead of going through
// `pnpm ci:full`. On Windows `pnpm` is a shell-script/`.cmd` shim that
// `spawnSync` cannot execute without a shell, so the hook died with ENOENT
// before any check ran. `pnpm ci:full` only forwards to this same script.
const result = spawnSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "run-ci.mjs"), "full", "--changed"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
