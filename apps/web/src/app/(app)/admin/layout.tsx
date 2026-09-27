import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api/server";
import type { Me } from "@/lib/api/types";

// Hidden from anyone who is not a platform admin; the API checks again.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await api<Me>("/me");
  if (!me.user.isAdmin) notFound();
  return children;
}
