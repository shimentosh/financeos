"use client";

import { formatMoney, type MoneyFormatOptions } from "@expensewise/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CurrentWorkspace, Me } from "@/lib/api/types";

type AppContextValue = {
  me: Me;
  workspace: CurrentWorkspace;
  isBusiness: boolean;
  canWrite: boolean;
  canManage: boolean;
  locale: string;
  /** Formats minor units in the user's number style; defaults to base currency. */
  money: (minor: number | null | undefined, currency?: string, options?: MoneyFormatOptions) => string;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ me, workspace, children }: { me: Me; workspace: CurrentWorkspace; children: ReactNode }) {
  const value = useMemo<AppContextValue>(() => {
    const locale = me.preferences.numberLocale ?? "en-IN";
    return {
      me,
      workspace,
      isBusiness: workspace.kind === "business",
      canWrite: workspace.role !== "viewer",
      canManage: workspace.role === "owner" || workspace.role === "admin",
      locale,
      money: (minor, currency, options) =>
        minor === null || minor === undefined ? "—" : formatMoney(minor, currency ?? workspace.baseCurrency, { locale, ...options }),
    };
  }, [me, workspace]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}
