import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { DomainError } from "./errors.js";

/**
 * Validates and coerces a request body, query or param with a Zod schema from
 * @expensewise/core. Usage: `@Body(zod(transactionInput)) input`.
 */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new DomainError(
        400,
        result.error.issues[0]?.message ?? "Invalid request",
        "validation_failed",
        result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    return result.data;
  }
}

export const zod = <T extends z.ZodType>(schema: T) => new ZodPipe(schema);
