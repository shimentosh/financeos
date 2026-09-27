import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// The monorepo keeps one `.env` at its root. Walk up from this file (src/ in
// development, dist/ once built) until it is found. Real environment variables
// always win over the file.
let directory = dirname(fileURLToPath(import.meta.url));
for (let depth = 0; depth < 5; depth++) {
  const candidate = resolve(directory, ".env");
  if (existsSync(candidate)) {
    config({ path: candidate, quiet: true });
    break;
  }
  directory = resolve(directory, "..");
}
