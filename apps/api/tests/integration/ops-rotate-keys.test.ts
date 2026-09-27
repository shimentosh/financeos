import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { integrationConnections, platformSettings } from "../../src/db/schema/index.js";
import { decryptionKeys, decryptWithKeys, encryptJson, encryptSecret } from "../../src/modules/integrations/crypto.js";
import { credentialsAad, webhookAad } from "../../src/modules/integrations/store.js";
import { createUser, resetDatabase, shutdown } from "./harness.js";

// Runs the real `rotate-keys` script (as `pnpm rotate-keys` does) against
// secrets sealed with an old key, the current key, and a key nobody has.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const oldKey = randomBytes(32);

function rotate(...args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [tsxCli, "src/scripts/rotate-keys.ts", ...args],
      { cwd: apiDir, env: { ...process.env, ENCRYPTION_KEY_PREVIOUS: oldKey.toString("base64") }, timeout: 60_000 },
      (error, stdout, stderr) => done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: `${stdout}${stderr}` }),
    );
  });
}

const current = () => [decryptionKeys()[0] as Buffer];
const onCurrentKey = (payload: string | null | undefined, aad: string) => {
  if (!payload) return false;
  try {
    return decryptWithKeys(payload, current(), aad).keyIndex === 0;
  } catch {
    return false;
  }
};

let oldConnection: string;
let currentConnection: string;

beforeAll(async () => {
  await resetDatabase();
  const user = await createUser("Key Rotator");
  oldConnection = randomUUID();
  currentConnection = randomUUID();
  await db.insert(integrationConnections).values([
    {
      id: oldConnection,
      workspaceId: user.business.workspaceId,
      provider: "generic_rest",
      name: "Shop (old key)",
      credentialsEncrypted: encryptJson({ apiKey: "shop-key" }, { aad: credentialsAad(oldConnection), key: oldKey }),
      webhookSecretEncrypted: encryptSecret("whsec_old", { aad: webhookAad(oldConnection), key: oldKey }),
    },
    {
      id: currentConnection,
      workspaceId: user.business.workspaceId,
      provider: "generic_rest",
      name: "Shop (current key)",
      credentialsEncrypted: encryptJson({ apiKey: "other" }, { aad: credentialsAad(currentConnection) }),
    },
  ]);
  await db.insert(platformSettings).values([
    {
      key: "ai",
      value: {
        primary: { provider: "anthropic", model: "claude", apiKeyEncrypted: encryptSecret("sk-ant", { aad: "platform:ai:primary", key: oldKey }) },
        vision: null,
      },
    },
    {
      key: "storage",
      value: { provider: "r2", bucket: "files", secretAccessKeyEncrypted: encryptSecret("r2-secret", { aad: "platform:storage" }) },
    },
    {
      key: "billing",
      value: {
        providers: {
          stripe: { enabled: true, secretKeyEncrypted: encryptSecret("sk_live_x", { aad: "platform:billing", key: oldKey }), webhookSecretEncrypted: null },
          sslcommerz: {
            enabled: false,
            storeId: "store",
            storePasswordEncrypted: encryptSecret("pw", { aad: "platform:billing", key: oldKey }),
            sandbox: true,
          },
        },
      },
    },
    { key: "lost", value: { tokenEncrypted: encryptSecret("gone", { key: randomBytes(32) }) } },
  ]);
});

afterAll(async () => {
  await shutdown();
});

type Settings = {
  ai?: { primary: { apiKeyEncrypted: string } };
  storage?: { secretAccessKeyEncrypted: string };
  billing?: {
    providers: { stripe: { enabled: boolean; secretKeyEncrypted: string }; sslcommerz: { storeId: string; storePasswordEncrypted: string } };
  };
};

async function snapshot() {
  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, oldConnection));
  const settings = Object.fromEntries((await db.select().from(platformSettings)).map((row) => [row.key, row.value])) as Settings;
  return { connection, settings };
}

describe("rotate-keys", () => {
  it("dry run reports what it would re-seal and changes nothing", async () => {
    const before = await snapshot();
    const result = await rotate("--dry-run");
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toMatch(/integration credentials\s+1 to re-seal\s+1 current/);
    expect(result.stdout).toMatch(/platform setting "billing"\s+2 to re-seal/);
    expect(result.stdout).toContain("platform setting lost.tokenEncrypted");
    expect(result.code).toBe(1); // one secret opens with no key
    expect(await snapshot()).toEqual(before);
  }, 90_000);

  it("re-seals every secret on an old key with the current key, keeping the plaintext and the AAD", async () => {
    const result = await rotate();
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/webhook secrets\s+1 re-sealed/);
    const { connection, settings } = await snapshot();
    expect(onCurrentKey(connection?.credentialsEncrypted, credentialsAad(oldConnection))).toBe(true);
    expect(onCurrentKey(connection?.webhookSecretEncrypted, webhookAad(oldConnection))).toBe(true);
    expect(decryptWithKeys(connection?.credentialsEncrypted as string, current(), credentialsAad(oldConnection)).plaintext).toBe('{"apiKey":"shop-key"}');
    expect(onCurrentKey(settings.ai?.primary.apiKeyEncrypted, "platform:ai:primary")).toBe(true);
    expect(decryptWithKeys(settings.billing?.providers.stripe.secretKeyEncrypted ?? "", current(), "platform:billing").plaintext).toBe("sk_live_x");
    expect(onCurrentKey(settings.billing?.providers.sslcommerz.storePasswordEncrypted, "platform:billing")).toBe(true);
    expect(settings.billing?.providers.stripe.enabled).toBe(true);
    expect(settings.billing?.providers.sslcommerz.storeId).toBe("store");
    expect(onCurrentKey(settings.storage?.secretAccessKeyEncrypted, "platform:storage")).toBe(true);
  }, 90_000);

  it("is idempotent: a second run finds nothing left on an old key", async () => {
    await db.delete(platformSettings).where(eq(platformSettings.key, "lost"));
    const before = await snapshot();
    const result = await rotate();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/[1-9]\d* re-sealed/);
    expect(await snapshot()).toEqual(before);
  }, 90_000);
});
