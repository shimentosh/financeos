"use client";

import { KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, safeNext } from "@/lib/auth-client";
import { AuthHeader, AuthNotice, authErrorMessage } from "../auth-form";

type Failure = { message: string; restart: boolean };

function failureFor(error: { code?: string; message?: string; status?: number }, mode: "totp" | "backup"): Failure {
  switch (error.code) {
    case "INVALID_CODE":
      return { message: "That code did not match. Codes change every 30 seconds; check the time on your phone is set automatically.", restart: false };
    case "INVALID_BACKUP_CODE":
      return { message: "That backup code is not valid or was already used. Each one works once.", restart: false };
    case "INVALID_TWO_FACTOR_COOKIE":
      return { message: "This sign-in timed out. Sign in again to get a new chance.", restart: true };
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return { message: "Too many wrong codes for this sign-in. Sign in again to try once more.", restart: true };
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return { message: "Too many failed attempts. Your account is locked for 15 minutes; try again after that.", restart: true };
    default:
      return {
        message: authErrorMessage(error, mode === "totp" ? "Could not check the code. Try again." : "Could not check the backup code. Try again."),
        restart: false,
      };
  }
}

/** The second step of signing in: a code from the authenticator app, or a backup code. */
export function TwoFactorForm() {
  const id = useId();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    const value = code.trim();
    const result =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: value.replace(/\s/g, ""), trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code: value, trustDevice });
    if (result.error) {
      setBusy(false);
      setFailure(failureFor(result.error, mode));
      return;
    }
    // A full page load, so the app renders with the new session.
    window.location.assign(next);
  };

  const switchMode = () => {
    setMode(mode === "totp" ? "backup" : "totp");
    setCode("");
    setFailure(null);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-info/10 text-info-foreground">
        {mode === "totp" ? <ShieldCheck className="size-5" /> : <KeyRound className="size-5" />}
      </span>
      <AuthHeader
        title="Two-step verification"
        description={
          mode === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of the backup codes you saved when you turned on two-step verification. Each works once."
        }
      />
      <div className="space-y-1">
        <Label htmlFor={`${id}-code`}>{mode === "totp" ? "Code" : "Backup code"}</Label>
        {mode === "totp" ? (
          <Input
            id={`${id}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            autoFocus
            placeholder="123 456"
            className="font-mono tracking-widest tabular-nums"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
          />
        ) : (
          <Input
            id={`${id}-code`}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            autoFocus
            className="font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={trustDevice} onCheckedChange={(checked) => setTrustDevice(checked === true)} />
        Trust this device for 30 days
      </label>
      {failure && (
        <AuthNotice tone="error">
          <p>{failure.message}</p>
          {failure.restart && (
            <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className="font-medium underline underline-offset-4">
              Sign in again
            </Link>
          )}
        </AuthNotice>
      )}
      <Button type="submit" className="w-full" loading={busy}>
        Verify
      </Button>
      <div className="flex items-center justify-between gap-2 text-sm">
        <button type="button" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={switchMode}>
          {mode === "totp" ? "Use a backup code" : "Use the authenticator app"}
        </button>
        <Link
          href={next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`}
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Cancel
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Lost your phone and your backup codes?{" "}
        <Link href="/contact" className="text-foreground underline-offset-4 hover:underline">
          Contact support
        </Link>
        .
      </p>
    </form>
  );
}
