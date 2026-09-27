import "server-only";

const API_URL = (process.env.API_INTERNAL_URL ?? "http://localhost:4100").replace(/\/+$/, "");

/**
 * Reads a public API endpoint from a Server Component on the public site: no
 * cookies, and never a redirect to sign-in. Returns null when the API can't
 * answer, so a page can fall back to built-in content.
 */
export async function publicApi<T>(path: string, revalidateSeconds = 300): Promise<T | null> {
  try {
    const response = await fetch(`${API_URL}/api${path}`, { next: { revalidate: revalidateSeconds }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
