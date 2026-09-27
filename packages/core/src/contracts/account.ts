import { z } from "zod";

/**
 * Your own account: first-run setup, data export and deletion. Deleting an
 * account deletes the workspaces it owns alone; workspaces shared with other
 * people must be handed over first.
 */
export const onboardingInput = z.object({
  baseCurrency: z.string().trim().length(3).toUpperCase(),
  timezone: z.string().trim().min(1).max(64),
  /** Keep the business workspace created at sign-up, or remove it for a personal-only start. */
  keepBusiness: z.boolean().default(true),
  businessName: z.string().trim().min(1).max(80).nullish(),
});
export type OnboardingInput = z.input<typeof onboardingInput>;

export const deleteAccountInput = z.object({
  /** Type your email to confirm. */
  confirmEmail: z.email().transform((value) => value.trim().toLowerCase()),
});

export const SUPPORT_STATUSES = ["open", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const supportRequestInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(120).nullish(),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(10).max(5000),
  /** The page they were on, for context. */
  page: z.string().max(300).nullish(),
});
export type SupportRequestInput = z.input<typeof supportRequestInput>;
