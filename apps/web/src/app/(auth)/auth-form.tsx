"use client";

import { CircleCheck, Info, MailCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AuthOptions, authClient, safeNext, signIn, signUp } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

const linkClass = "text-foreground underline-offset-4 hover:underline";

/** Title and one line under it, the same on every auth screen. */
export function AuthHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** A tinted message box: errors, confirmations, things to know. */
export function AuthNotice({ tone = "info", children, className }: { tone?: "info" | "success" | "error"; children: ReactNode; className?: string }) {
  const Icon = tone === "error" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "error" && "bg-destructive/8 text-destructive-foreground",
        tone === "success" && "bg-success/8 text-success-foreground",
        tone === "info" && "bg-muted text-foreground",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 opacity-80" />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

/** The user-facing version of a Better Auth error. */
export function authErrorMessage(error: { code?: string; message?: string; status?: number } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password do not match.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Sign in instead.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 10 characters.";
    case "PASSWORD_TOO_LONG":
      return "Use at most 128 characters.";
    case "BANNED_USER":
      return "This account is suspended. Contact support if you think this is a mistake.";
    case "EMAIL_PASSWORD_SIGN_UP_DISABLED":
      return "New sign-ups are closed on this server.";
    default:
      return error.message || fallback;
  }
}

/** "Send a new link" for an address that still needs verifying. */
export function ResendVerification({ email, next, label = "Send a new link" }: { email: string; next?: string; label?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const resend = async () => {
    setState("busy");
    setError(null);
    const result = await authClient.sendVerificationEmail({ email, callbackURL: next ?? "/" });
    if (result.error) {
      setState("idle");
      setError(authErrorMessage(result.error, "Could not send the email. Try again shortly."));
      return;
    }
    setState("sent");
  };
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" className="w-full" loading={state === "busy"} disabled={state === "sent"} onClick={() => void resend()}>
        {state === "sent" ? (
          <>
            <MailCheck className="size-4" /> Sent. Check your inbox
          </>
        ) : (
          label
        )}
      </Button>
      {error && <p className="text-xs text-destructive-foreground">{error}</p>}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z" />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.11Z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77Z" />
    </svg>
  );
}

/** "Continue with Google": shown only when the server has Google credentials. */
export function GoogleButton({ next, label = "Continue with Google" }: { next: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await signIn.social({ provider: "google", callbackURL: next, errorCallbackURL: "/sign-in" });
    // On success the browser is already on its way to Google.
    if (result.error) {
      setBusy(false);
      setError(authErrorMessage(result.error, "Google sign-in is not available right now."));
    }
  };
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" className="w-full" loading={busy} onClick={() => void start()}>
        <GoogleMark /> {label}
      </Button>
      {error && <p className="text-xs text-destructive-foreground">{error}</p>}
    </div>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// Messages for query parameters other screens send people here with.
const SIGN_IN_NOTICES: Record<string, { tone: "info" | "success" | "error"; text: string }> = {
  deleted: { tone: "info", text: "Your account was deleted. Thank you for using Expense Wise." },
  reset: { tone: "success", text: "Password changed. Sign in with your new password." },
};

const DEFAULT_OPTIONS: AuthOptions = { signUpEnabled: true, googleEnabled: false, emailVerificationRequired: false };

export function AuthForm({ mode, options = DEFAULT_OPTIONS }: { mode: "sign-in" | "sign-up"; options?: AuthOptions }) {
  const id = useId();
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Signed up, waiting for the verification link; or signed in but not verified yet.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const destination = safeNext(params.get("next"));
  const notice = mode === "sign-in" ? Object.entries(SIGN_IN_NOTICES).find(([key]) => params.has(key))?.[1] : undefined;
  const oauthError = mode === "sign-in" ? params.get("error") : null;
  const withNext = (path: string) => (destination === "/" ? path : `${path}?next=${encodeURIComponent(destination)}`);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    if (mode === "sign-in") {
      const result = await signIn.email({ email, password });
      setBusy(false);
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED") return setPendingEmail(email);
        return setError(authErrorMessage(result.error, "That did not work. Check your details and try again."));
      }
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        router.push(`/two-factor?next=${encodeURIComponent(destination)}`);
        return;
      }
    } else {
      const result = await signUp.email({ name: name.trim() || email.split("@")[0] || "You", email, password, callbackURL: destination });
      setBusy(false);
      if (result.error) return setError(authErrorMessage(result.error, "That did not work. Check your details and try again."));
      // No session means the email has to be verified first.
      if (!result.data?.token) return setPendingEmail(email);
    }
    router.push(destination);
    router.refresh();
  };

  if (pendingEmail) {
    return (
      <div className="space-y-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-info/10 text-info-foreground">
          <MailCheck className="size-5" />
        </span>
        <AuthHeader
          title={mode === "sign-up" ? "Check your inbox" : "Verify your email first"}
          description={
            <>
              {mode === "sign-up" ? "We sent a verification link to " : "Your account is waiting for you to confirm "}
              <span className="font-medium text-foreground">{pendingEmail}</span>.{" "}
              {mode === "sign-up" ? "Open it to finish creating your account." : "Open the link we emailed you, or ask for a new one."}
            </>
          }
        />
        <ResendVerification email={pendingEmail} next={destination} label={mode === "sign-up" ? "Resend the email" : "Send a new link"} />
        <p className="text-xs text-muted-foreground">
          Nothing after a few minutes? Check spam, or make sure the address is right. The link expires in 24 hours.
        </p>
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setPendingEmail(null);
            setPassword("");
          }}
        >
          {mode === "sign-up" ? "Use a different email" : "Back to sign in"}
        </button>
      </div>
    );
  }

  if (mode === "sign-up" && !options.signUpEnabled) {
    return (
      <div className="space-y-4">
        <AuthHeader title="Sign-ups are closed" description="This Expense Wise server is not accepting new accounts right now." />
        <p className="text-sm text-muted-foreground">
          If someone invited you, open the link in your invitation email. Already have an account?{" "}
          <Link href={withNext("/sign-in")} className={linkClass}>
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthHeader
        title={mode === "sign-in" ? "Welcome back" : "Create your account"}
        description={mode === "sign-in" ? "Sign in to your books." : "You get a personal and a business workspace to start."}
      />
      {notice && <AuthNotice tone={notice.tone}>{notice.text}</AuthNotice>}
      {oauthError && (
        <AuthNotice tone="error">Google sign-in did not work ({oauthError.replace(/_/g, " ").toLowerCase()}). Try again or use your email.</AuthNotice>
      )}
      {options.googleEnabled && (
        <>
          <GoogleButton next={destination} label={mode === "sign-up" ? "Sign up with Google" : "Continue with Google"} />
          <OrDivider />
        </>
      )}
      {mode === "sign-up" && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input id={`${id}-email`} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`${id}-password`}>Password</Label>
          {mode === "sign-in" && (
            <Link href="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Forgot password?
            </Link>
          )}
        </div>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          required
          minLength={10}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "sign-up" && <p className="text-xs text-muted-foreground">At least 10 characters.</p>}
      </div>
      {error && <AuthNotice tone="error">{error}</AuthNotice>}
      <Button type="submit" className="w-full" loading={busy}>
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </Button>
      {mode === "sign-up" && (
        <p className="text-center text-xs text-muted-foreground">
          By creating an account you agree to the{" "}
          <Link href="/terms" className={linkClass}>
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className={linkClass}>
            Privacy Policy
          </Link>
          .
        </p>
      )}
      <p className="text-center text-sm text-muted-foreground">
        {mode === "sign-in" ? (
          options.signUpEnabled ? (
            <>
              New here?{" "}
              <Link href={withNext("/sign-up")} className={linkClass}>
                Create an account
              </Link>
            </>
          ) : null
        ) : (
          <>
            Already have an account?{" "}
            <Link href={withNext("/sign-in")} className={linkClass}>
              Sign in
            </Link>
          </>
        )}
      </p>
      {mode === "sign-in" && (
        <p className="text-center text-xs text-muted-foreground">
          Trouble signing in?{" "}
          <Link href="/contact" className={linkClass}>
            Contact support
          </Link>
        </p>
      )}
    </form>
  );
}
