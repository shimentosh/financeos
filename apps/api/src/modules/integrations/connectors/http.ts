import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ConnectorError } from "./types.js";

export type HttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Whole-request deadline. Default 15 s. */
  timeoutMs?: number;
  /** Largest response accepted. Default 5 MB. */
  maxBytes?: number;
  /** Allow loopback/private targets (development only; see `privateNetworkAllowed`). */
  allowPrivateNetwork?: boolean;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
};

/**
 * The only way connectors reach the network. Injectable, so tests exercise a
 * connector's paging and mapping against fixtures without a network.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class SsrfError extends ConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0] ?? "";
  // A trailing dotted IPv4 (::ffff:10.0.0.1) becomes two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const v4 = ipv4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined && left.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right].map((g) => Number.parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, and their IPv6 forms. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
  if (allZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    return isPrivateAddress(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return isPrivateAddress(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

const BLOCKED_HOSTNAMES =
  /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|metadata\.google\.internal|metadata)$|\.(localhost|local|internal|intranet|lan|home|corp)$/i;

/**
 * Checks a URL before any request: http(s) only, no credentials in the URL,
 * no loopback/private IP literals or internal hostnames. DNS answers are
 * checked again at connect time by the default client (no rebinding).
 */
export function assertSafeUrl(raw: string, options: { allowPrivateNetwork?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SsrfError(`Only http and https URLs are allowed, not ${url.protocol}`);
  if (url.username || url.password) throw new SsrfError("Put credentials in the connection's credential fields, not in the URL");
  if (options.allowPrivateNetwork) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("The URL has no host");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SsrfError(`Requests to private or loopback addresses (${host}) are not allowed`);
    return url;
  }
  if (BLOCKED_HOSTNAMES.test(host) || !host.includes(".")) throw new SsrfError(`Requests to internal hosts (${host}) are not allowed`);
  return url;
}

/** Private targets: never in production; elsewhere only when the connection opts in. */
export function privateNetworkAllowed(config: { allowPrivateNetwork?: unknown }, nodeEnv: string): boolean {
  return nodeEnv !== "production" && config.allowPrivateNetwork === true;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup that refuses private answers, so a public name cannot rebind to an internal address. */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback) => {
    const wantsAll = typeof options === "object" && options.all === true;
    const family = typeof options === "number" ? options : options.family;
    dnsLookup(hostname, { all: true, family: family ?? 0 }, (error, addresses) => {
      if (error) return callback(error, wantsAll ? [] : "");
      const list = addresses as LookupAddress[];
      if (!allowPrivate) {
        const blocked = list.find((entry) => isPrivateAddress(entry.address));
        if (blocked)
          return callback(new SsrfError(`${hostname} resolves to a private address (${blocked.address})`) as NodeJS.ErrnoException, wantsAll ? [] : "");
      }
      if (!list.length) return callback(new Error(`${hostname} did not resolve`) as NodeJS.ErrnoException, wantsAll ? [] : "");
      if (wantsAll) return callback(null, list);
      const first = list[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  };
}

/** Node's http(s) client with a hard deadline, a size cap, no redirects and the guarded lookup. */
export const defaultHttpClient: HttpClient = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = assertSafeUrl(request.url, { allowPrivateNetwork: request.allowPrivateNetwork });
    } catch (error) {
      reject(error);
      return;
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: request.method,
        headers: { "user-agent": "ExpenseWise-Integrations/1.0", ...(request.headers ?? {}) },
        lookup: guardedLookup(Boolean(request.allowPrivateNetwork)) as never,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new ConnectorError(`The response was larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString("utf8");
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body,
            json<T>() {
              try {
                return JSON.parse(body) as T;
              } catch {
                throw new ConnectorError(`Expected JSON from ${url.host}, got ${body.slice(0, 80) || "an empty body"}`);
              }
            },
          });
        });
        response.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new ConnectorError(`${url.host} did not answer within ${Math.round(timeoutMs / 1000)} s`, { retryable: true }));
    }, timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof ConnectorError ? error : new ConnectorError(`Could not reach ${url.host}: ${error.message}`, { retryable: true }));
    });
    if (request.body) req.write(request.body);
    req.end();
  });

/** Wraps a parsed JSON body as an HttpResponse (fixtures and in-process calls). */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: text,
    json<T>() {
      return JSON.parse(text) as T;
    },
  };
}
