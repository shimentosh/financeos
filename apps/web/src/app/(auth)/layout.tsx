import { Wallet } from "lucide-react";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Wallet className="size-5" />
        </span>
        <span className="text-lg font-semibold tracking-tight">Expense Wise</span>
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xs/5">{children}</div>
      <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
        Personal and business money in one place. Your ledger stays yours: AI suggests, you confirm.
      </p>
    </div>
  );
}
