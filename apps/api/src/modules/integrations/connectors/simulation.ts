import { addDays, type Day, today } from "@financeos/core";
import { z } from "zod";

// Deterministic feeds for the demo connectors. Everything is derived from a
// seed (the connection id) and the day, so a record's id and content never
// change between syncs and idempotency can be demonstrated for real.

/** FNV-1a, 32-bit. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast, well-distributed PRNG. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

export function between(rng: () => number, min: number, max: number): number {
  return Math.round(min + rng() * (max - min));
}

export function compactDay(day: Day): string {
  return day.replaceAll("-", "");
}

const simulationCursor = z.object({
  /** The last day already revealed. */
  through: z.string(),
  /** While a sync is paging: the day it is revealing up to, and how far it got. */
  target: z.string().optional(),
  offset: z.number().int().min(0).optional(),
});
export type SimulationCursor = z.infer<typeof simulationCursor>;

export type SimulationClock = {
  /** First day of the feed. */
  start: Day;
  /** Reveal records dated after `through` up to and including `target`. */
  through: Day;
  target: Day;
  offset: number;
};

/**
 * The simulated clock. The feed begins `historyDays` before the connection
 * was created; the first sync reveals it up to `initialLagDays` before then,
 * and every later sync moves the clock `stepDays` forward — never past today.
 */
export function simulationClock(input: {
  cursor: unknown;
  createdAt: Date;
  now: Date;
  timeZone: string;
  historyDays: number;
  initialLagDays: number;
  stepDays: number;
}): SimulationClock {
  const createdDay = today(input.timeZone, input.createdAt);
  const todayDay = today(input.timeZone, input.now);
  const start = addDays(createdDay, -input.historyDays);
  const parsed = simulationCursor.safeParse(input.cursor);
  if (parsed.success && parsed.data.target) {
    return { start, through: parsed.data.through, target: parsed.data.target, offset: parsed.data.offset ?? 0 };
  }
  if (parsed.success) {
    const through = parsed.data.through;
    const next = addDays(through, input.stepDays);
    return { start, through, target: next < todayDay ? next : todayDay > through ? todayDay : through, offset: 0 };
  }
  const initial = addDays(createdDay, -input.initialLagDays);
  return { start, through: addDays(start, -1), target: initial < todayDay ? initial : todayDay, offset: 0 };
}

/** Every day in (through, target]. */
export function revealedDays(clock: Pick<SimulationClock, "through" | "target">): Day[] {
  const days: Day[] = [];
  let cursor = addDays(clock.through, 1);
  while (cursor <= clock.target && days.length < 400) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Slices one page and says where the next begins. */
export function pageOf<T>(items: T[], clock: SimulationClock, pageSize: number): { page: T[]; nextCursor: SimulationCursor; hasMore: boolean } {
  const page = items.slice(clock.offset, clock.offset + pageSize);
  const consumed = clock.offset + page.length;
  if (consumed < items.length) {
    return { page, nextCursor: { through: clock.through, target: clock.target, offset: consumed }, hasMore: true };
  }
  return { page, nextCursor: { through: clock.target > clock.through ? clock.target : clock.through }, hasMore: false };
}
