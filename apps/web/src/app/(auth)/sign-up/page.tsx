import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "../auth-form";
import { getAuthOptions } from "../auth-options";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage() {
  const options = await getAuthOptions();
  return (
    <Suspense>
      <AuthForm mode="sign-up" options={options} />
    </Suspense>
  );
}
