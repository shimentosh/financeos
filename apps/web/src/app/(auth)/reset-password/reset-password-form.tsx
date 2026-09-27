"use client";

import { CircleCheck, Clock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { AuthHeader, AuthNotice, authErrorMessage } from "../auth-form";

function ExpiredLink() {
  return (
    <div className="space-y-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-warning/10 text-warning-foreground">
        <Clock className="size-5" />
      </span>
      <AuthHeader title="This link has expired" description="Reset links work once and only for an hour. Ask for a new one and use it straight away." />
      <Button className="w-full" render={<Link href="/forgot-password" />}>
        Send a new link
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export function ResetPasswordForm() {
  const id = useId();
  const params = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"form" | "expired" | "done">(!token || params.has("error") ? "expired" : "form");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return setState("expired");
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (result.error) {
      if (result.error.code === "INVALID_TOKEN") return setState("expired");
      return setError(authErrorMessage(result.error, "Could not change the password. Try again."));
    }
    setState("done");
  };

  if (state === "expired") return <ExpiredLink />;

  if (state === "done") {
    return (
      <div className="space-y-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-success/10 text-success-foreground">
          <CircleCheck className="size-5" />
        </span>
        <AuthHeader title="Password changed" description="For your security, every device that was signed in has been signed out." />
        {/* ?expired clears any old session cookie before showing the sign-in form. */}
        <Button className="w-full" render={<a href="/sign-in?expired=1&reset=1" />}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthHeader title="Choose a new password" description="At least 10 characters. Every device signed in to your account will be signed out." />
      <div className="space-y-1">
        <Label htmlFor={`${id}-password`}>New password</Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-confirm`}>Repeat it</Label>
        <Input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      <Button type="submit" className="w-full" loading={busy}>
        Change password
      </Button>
    </form>
  );
}
