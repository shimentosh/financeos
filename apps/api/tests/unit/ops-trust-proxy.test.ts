import express from "express";
import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../../src/common/trust-proxy.js";

describe("TRUST_PROXY", () => {
  it("parses hop counts, booleans and address lists", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("TRUE")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("loopback, 10.0.0.0/8 ,172.16.0.1")).toEqual(["loopback", "10.0.0.0/8", "172.16.0.1"]);
  });

  it("defaults to one hop (the web server's /api proxy) when empty", () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy("")).toBe(1);
    expect(parseTrustProxy("   ")).toBe(1);
  });

  it("produces values Express accepts", () => {
    const app = express();
    for (const value of ["1", "true", "false", "loopback, 10.0.0.0/8"]) {
      expect(() => app.set("trust proxy", parseTrustProxy(value))).not.toThrow();
    }
    // A list compiles to a function that trusts exactly those addresses.
    app.set("trust proxy", parseTrustProxy("10.0.0.0/8"));
    const trust = app.get("trust proxy fn") as (address: string, hop: number) => boolean;
    expect(trust("10.1.2.3", 0)).toBe(true);
    expect(trust("203.0.113.9", 0)).toBe(false);
  });
});
