"use client";

import type { ReactNode } from "react";
import { PageShell } from "@/components/app/page-shell";

/** A settings page: the shell in its Settings frame, a title, and a narrow content column. */
export function SettingsPage({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <PageShell title={title} frame="settings">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="max-w-3xl space-y-4">{children}</div>
    </PageShell>
  );
}

/** A settings card: title, description, body, optional footer actions. */
export function SettingsCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
      {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
    </section>
  );
}
