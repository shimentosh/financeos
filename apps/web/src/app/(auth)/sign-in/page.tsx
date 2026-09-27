import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "../auth-form";
import { getAuthOptions } from "../auth-options";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const options = await getAuthOptions();
  return (
    <Suspense>
      <AuthForm mode="sign-in" options={options} />
    </Suspense>
  );
}
