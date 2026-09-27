import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

// ENCRYPTION_KEY_PREVIOUS is read when crypto.ts first needs it, so it is set
// before the module (and env.ts) load: every import below is dynamic.
const previousKey = randomBytes(32);
const olderKey = randomBytes(32);
process.env.ENCRYPTION_KEY_PREVIOUS = ` ${previousKey.toString("base64")} , ${olderKey.toString("base64")}`;

const crypto = await import("../../src/modules/integrations/crypto.js");

describe("encryption key rotation", () => {
  it("parses the previous-key list and rejects keys of the wrong size", () => {
    expect(crypto.parseKeyList(undefined)).toEqual([]);
    expect(crypto.parseKeyList(" , ")).toEqual([]);
    expect(crypto.parseKeyList(`${previousKey.toString("base64")},${olderKey.toString("base64")}`).map((key) => key.toString("hex"))).toEqual([
      previousKey.toString("hex"),
      olderKey.toString("hex"),
    ]);
    expect(() => crypto.parseKeyList(`${previousKey.toString("base64")},c2hvcnQ=`)).toThrow(/entry 2/);
  });

  it("tries the current key first, then each previous key", () => {
    const keys = crypto.decryptionKeys();
    expect(keys).toHaveLength(3);
    expect(keys[1]?.equals(previousKey)).toBe(true);
    expect(keys[2]?.equals(olderKey)).toBe(true);
  });

  it("still opens values sealed with a previous key, and says which key opened them", () => {
    const aad = "integration:conn-1:credentials";
    const sealedOld = crypto.encryptSecret("sk_live_old", { aad, key: olderKey });
    expect(crypto.decryptSecret(sealedOld, { aad })).toBe("sk_live_old");
    expect(crypto.decryptWithKeys(sealedOld, crypto.decryptionKeys(), aad)).toEqual({ plaintext: "sk_live_old", keyIndex: 2 });

    const sealedNow = crypto.encryptSecret("sk_live_new", { aad });
    expect(crypto.decryptWithKeys(sealedNow, crypto.decryptionKeys(), aad)).toEqual({ plaintext: "sk_live_new", keyIndex: 0 });
    expect(crypto.decryptJson(crypto.encryptJson({ apiKey: "k" }, { aad, key: previousKey }), { aad })).toEqual({ apiKey: "k" });
  });

  it("re-sealing moves a value onto the current key (what rotate-keys does)", () => {
    const aad = "platform:storage";
    const sealedOld = crypto.encryptSecret("secret-access-key", { aad, key: previousKey });
    const opened = crypto.decryptWithKeys(sealedOld, crypto.decryptionKeys(), aad);
    expect(opened.keyIndex).toBe(1);
    const resealed = crypto.encryptSecret(opened.plaintext, { aad });
    expect(crypto.decryptWithKeys(resealed, crypto.decryptionKeys(), aad).keyIndex).toBe(0);
    // Once the old key is dropped from the list, only the re-sealed value opens.
    const currentOnly = [crypto.decryptionKeys()[0] as Buffer];
    expect(crypto.decryptWithKeys(resealed, currentOnly, aad).plaintext).toBe("secret-access-key");
    expect(() => crypto.decryptWithKeys(sealedOld, currentOnly, aad)).toThrow(crypto.SecretDecryptionError);
  });

  it("still binds a value to its AAD and rejects unknown keys and an explicit wrong key", () => {
    const sealed = crypto.encryptSecret("x", { aad: "integration:a:webhook", key: previousKey });
    expect(() => crypto.decryptSecret(sealed, { aad: "integration:b:webhook" })).toThrow(crypto.SecretDecryptionError);
    const stranger = crypto.encryptSecret("x", { key: randomBytes(32) });
    expect(() => crypto.decryptSecret(stranger)).toThrow(crypto.SecretDecryptionError);
    // An explicit key means exactly that key: no fallback.
    expect(() => crypto.decryptSecret(sealed, { aad: "integration:a:webhook", key: olderKey })).toThrow(crypto.SecretDecryptionError);
  });
});
