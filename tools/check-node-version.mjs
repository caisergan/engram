import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredMajor = readFileSync(join(rootDir, ".nvmrc"), "utf8").trim();
const currentVersion = process.versions.node;
const currentMajor = currentVersion.split(".")[0];

if (currentMajor === requiredMajor) {
  process.exit(0);
}

console.error(
  [
    `Karakeep requires Node.js ${requiredMajor}.x for local development and verification.`,
    `Current Node.js: v${currentVersion}`,
    "",
    "Use the project runtime before installing dependencies or running tests:",
    `  nvm install ${requiredMajor}`,
    `  nvm use ${requiredMajor}`,
    "  pnpm install",
    "",
    "Native SQLite dependencies are Node-ABI sensitive. Running this project on a different Node major can produce misleading better-sqlite3/liteque failures.",
  ].join("\n"),
);

process.exit(1);
