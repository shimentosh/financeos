"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clientApi } from "./api/client";
import type { Query } from "./api/shared";

type State<T> = { data: T | undefined; error: Error | null; loading: boolean };

// A tiny per-tab cache so reopening a dialog shows its lists instantly while
// they refresh in the background.
const cache = new Map<string, unknown>();

export function useApi<T>(path: string | null, query?: Query) {
  const key = path ? `${path}?${JSON.stringify(query ?? {})}` : null;
  const [state, setState] = useState<State<T>>(() => ({
    data: key ? (cache.get(key) as T | undefined) : undefined,
    error: null,
    loading: Boolean(key),
  }));
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async () => {
    if (!path || !key) return;
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await clientApi<T>(path, { query: queryRef.current });
      cache.set(key, data);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((current) => ({ ...current, error: error as Error, loading: false }));
    }
  }, [path, key]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}

export function invalidateApiCache(prefix?: string) {
  for (const key of cache.keys()) if (!prefix || key.startsWith(prefix)) cache.delete(key);
}
