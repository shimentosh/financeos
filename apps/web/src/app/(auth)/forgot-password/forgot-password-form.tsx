"use client";

import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { AuthHeader, AuthNotice, authErrorMessage } from "../auth-form";

export function ForgotPasswordForm() {
  const id = useId();
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (result.error) return setError(authErrorMessage(result.error, "Could not send the email. Try again shortly."));
    setSentTo(email);
  };

  if (sentTo) {
    return (
      <div className="space-y-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-info/10 text-info-foreground">
          <MailCheck className="size-5" />
        </span>
        <AuthHeader
          title="Check your inbox"
          description={
            <>
              If an account exists for <span className="font-medium text-foreground">{sentTo}</span>, we sent it a link to choose a new password. The link works
              once and expires in 1 hour.
            </>
          }
        />
        <p className="text-xs text-muted-foreground">Nothing after a few minutes? Check spam, or try another address you might have used.</p>
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => {
              setSentTo(null);
            }}
          >
            Try another email
          </button>
          <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthHeader title="Forgot your password?" description="Enter the email you sign in with and we will send you a link to choose a new one." />
      <div className="space-y-1">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input id={`${id}-email`} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      <Button type="submit" className="w-full" loading={busy}>
        Send reset link
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
