import { uuidv7 } from "@financeos/core";
import { bigint, date, numeric, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const pk = () => uuid("id").primaryKey().$defaultFn(uuidv7);

/**
 * Money is stored as integer minor units (poisha, cents) in a bigint, never as
 * a float. `mode: "number"` is exact up to 2^53 minor units, far beyond any
 * realistic balance.
 */
export const money = (name: string) => bigint(name, { mode: "number" });

export const currency = (name = "currency") => varchar(name, { length: 5 });

/** A calendar day, as `YYYY-MM-DD`. Financial dates are days, not instants. */
export const day = (name: string) => date(name, { mode: "string" });

/** Exchange rates and percentages keep their exact decimal digits. */
export const decimal = (name: string, precision = 20, scale = 10) => numeric(name, { precision, scale });

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const ts = (name: string) => timestamp(name, { withTimezone: true });
