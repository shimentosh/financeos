import "../load-env.js";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, db } from "../db/index.js";
import { integrationConnections, platformSettings } from "../db/schema/index.js";
import { decryptionKeys, decryptWithKeys, encryptSecret } from "../modules/integrations/crypto.js";
import { credentialsAad, webhookAad } from "../modules/integrations/store.js";

/**
 * Re-seals every stored secret with the current ENCRYPTION_KEY.
 *
 *   1. Set ENCRYPTION_KEY to the new key and ENCRYPTION_KEY_PREVIOUS to the old
 *      one(s); deploy (the app reads both, so nothing breaks meanwhile).
 *   2. pnpm --filter @expensewise/api rotate-keys [--dry-run]
 *      (in a built image: node dist/scripts/rotate-keys.js [--dry-run])
 *   3. When it reports nothing left on an old key, remove ENCRYPTION_KEY_PREVIOUS.
 *
 * Where secrets live (every encryptSecret/encryptJson caller):
 * - integration_connection.credentials_encrypted  AAD integration:<id>:credentials
 * - integration_connection.webhook_secret_encrypted AAD integration:<id>:webhook
 * - platform_setting values, any field ending in "Encrypted":
 *     ai       primary/vision.apiKeyEncrypted   AAD platform:ai:<slot>
 *     storage  secretAccessKeyEncrypted         AAD platform:storage
 *     others (billing, …) found by the same naming rule; their AAD is
 *     recognised by trying the conventional forms (GCM rejects a wrong one).
 *
 * Idempotent: values already sealed with the current key are left alone.
 * Each update is conditional on the value not having changed meanwhile.
 * Exit code 1 when some secret opens with none of the keys.
 */

type Outcome = "current" | "rotated" | "unreadable";
type Summary = Record<string, Record<Outcome, number>>;

const dryRun = process.argv.includes("--dry-run");
const keys = decryptionKeys();
const summary: Summary = {};
const unreadable: string[] = [];

function count(scope: string, outcome: Outcome) {
  summary[scope] ??= { current: 0, rotated: 0, unreadable: 0 };
  summary[scope][outcome] += 1;
}

/** Which key opens a value, and with which of the candidate AADs. */
function open(payload: string, aads: Array<string | undefined>): { plaintext: string; keyIndex: number; aad: string | undefined } | null {
  for (const aad of aads) {
    try {
      return { ...decryptWithKeys(payload, keys, aad), aad };
    } catch {
      // Not this AAD (or no key opens it): try the next.
    }
  }
  return null;
}

/** The re-sealed value, or null when it is already current (or unreadable). */
function reseal(scope: string, label: string, payload: string, aads: Array<string | undefined>): string | null {
  const opened = open(payload, aads);
  if (!opened) {
    count(scope, "unreadable");
    unreadable.push(label);
    return null;
  }
  if (opened.keyIndex === 0) {
    count(scope, "current");
    return null;
  }
  count(scope, "rotated");
  return encryptSecret(opened.plaintext, { aad: opened.aad });
}

async function rotateConnections() {
  const rows = await db
    .select({
      id: integrationConnections.id,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      webhookSecretEncrypted: integrationConnections.webhookSecretEncrypted,
    })
    .from(integrationConnections);
  for (const row of rows) {
    if (row.credentialsEncrypted) {
      const next = reseal("integration credentials", `integration ${row.id} credentials`, row.credentialsEncrypted, [credentialsAad(row.id)]);
      if (next && !dryRun) {
        await db
          .update(integrationConnections)
          .set({ credentialsEncrypted: next })
          .where(and(eq(integrationConnections.id, row.id), eq(integrationConnections.credentialsEncrypted, row.credentialsEncrypted)));
      }
    }
    if (row.webhookSecretEncrypted) {
      const next = reseal("webhook secrets", `integration ${row.id} webhook secret`, row.webhookSecretEncrypted, [webhookAad(row.id)]);
      if (next && !dryRun) {
        await db
          .update(integrationConnections)
          .set({ webhookSecretEncrypted: next })
          .where(and(eq(integrationConnections.id, row.id), eq(integrationConnections.webhookSecretEncrypted, row.webhookSecretEncrypted)));
      }
    }
  }
}

/** The AADs a platform setting's field may be sealed with, most likely first; no AAD last. */
function settingAads(settingKey: string, path: string[]): Array<string | undefined> {
  const field = path.at(-1) ?? "";
  const parents = path.slice(0, -1);
  const bare = field.replace(/Encrypted$/, "");
  const base = `platform:${settingKey}`;
  const candidates = [
    ...(parents.length ? [`${base}:${parents.join(":")}`] : []),
    base,
    `${base}:${bare}`,
    `${base}:${[...parents, bare].join(":")}`,
    `${base}:${[...parents, bare].join(".")}`,
    `${base}:${path.join(".")}`,
  ];
  return [...new Set(candidates), undefined];
}

/** Walks a JSON value and re-seals every string field whose name ends in "Encrypted". */
function resealJson(settingKey: string, value: unknown, path: string[] = []): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item, index) => {
      const result = resealJson(settingKey, item, [...path, String(index)]);
      changed ||= result.changed;
      return result.value;
    });
    return { value: items, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith("Encrypted") && typeof item === "string" && item) {
        const next = reseal(
          `platform setting "${settingKey}"`,
          `platform setting ${settingKey}.${[...path, key].join(".")}`,
          item,
          settingAads(settingKey, [...path, key]),
        );
        out[key] = next ?? item;
        changed ||= next !== null;
      } else {
        const result = resealJson(settingKey, item, [...path, key]);
        out[key] = result.value;
        changed ||= result.changed;
      }
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

async function rotatePlatformSettings() {
  const rows = await db.select().from(platformSettings);
  for (const row of rows) {
    const result = resealJson(row.key, row.value);
    if (!result.changed || dryRun) continue;
    // Conditional on the value read: an admin saving the setting meanwhile wins, and a re-run picks it up.
    await db
      .update(platformSettings)
      .set({ value: result.value as Record<string, unknown>, updatedAt: row.updatedAt })
      .where(and(eq(platformSettings.key, row.key), sql`${platformSettings.value} = ${JSON.stringify(row.value)}::jsonb`));
  }
}

async function main() {
  console.log(`Re-sealing stored secrets with the current ENCRYPTION_KEY (${keys.length - 1} previous key(s) accepted)${dryRun ? " — dry run" : ""}`);
  await rotateConnections();
  await rotatePlatformSettings();
  const scopes = Object.entries(summary);
  if (!scopes.length) console.log("No stored secrets found.");
  for (const [scope, counts] of scopes) {
    console.log(
      `  ${scope.padEnd(36)} ${String(counts.rotated).padStart(4)} ${dryRun ? "to re-seal" : "re-sealed"}  ${String(counts.current).padStart(4)} current  ${String(counts.unreadable).padStart(4)} unreadable`,
    );
  }
  if (unreadable.length) {
    console.log("\nThese open with none of the keys (a key that is no longer listed, or tampering); reconnect or re-enter them:");
    for (const label of unreadable) console.log(`  - ${label}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
