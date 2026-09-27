import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyEmailView } from "./verify-email-view";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailView />
    </Suspense>
  );
}
