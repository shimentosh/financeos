"use client";

import { CircleCheck, Clock, type LucideIcon, MailCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, safeNext } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { AuthHeader, ResendVerification } from "../auth-form";

const TONES = {
  success: "bg-success/10 text-success-foreground",
  info: "bg-info/10 text-info-foreground",
  warning: "bg-warning/10 text-warning-foreground",
  error: "bg-destructive/10 text-destructive-foreground",
} as const;

function Frame({
  icon: Icon,
  tone,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  tone: keyof typeof TONES;
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <span className={cn("flex size-10 items-center justify-center rounded-xl", TONES[tone])}>
        <Icon className="size-5" />
      </span>
      <AuthHeader title={title} description={description} />
      {children}
    </div>
  );
}

/** Asks for the address when we do not know it (an old or broken link). */
function ResendForAddress({ next, initial = "" }: { next: string; initial?: string }) {
  const id = useId();
  const [email, setEmail] = useState(initial);
  const valid = /^\S+@\S+\.\S+$/.test(email);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${id}-email`}>Your email</Label>
        <Input id={`${id}-email`} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
      </div>
      {valid ? (
        <ResendVerification key={email} email={email} next={next} label="Send a new verification link" />
      ) : (
        <Button type="button" variant="outline" className="w-full" disabled>
          Send a new verification link
        </Button>
      )}
    </div>
  );
}

/**
 * Where every email link lands after Better Auth has checked it: `status`
 * says what happened, `error` that the link did not work, `next` where the
 * person was headed.
 */
export function VerifyEmailView() {
  const params = useSearchParams();
  const session = authClient.useSession();
  const sessionUser = session.data?.user as { email?: string; emailVerified?: boolean } | undefined;
  const error = params.get("error");
  const status = params.get("status");
  const email = params.get("email") ?? sessionUser?.email ?? "";
  const next = safeNext(params.get("next"));

  if (error) {
    const expired = error === "TOKEN_EXPIRED";
    return (
      <Frame
        icon={expired ? Clock : TriangleAlert}
        tone={expired ? "warning" : "error"}
        title={expired ? "This link has expired" : "This link does not work"}
        description={
          expired
            ? "Verification links are valid for 24 hours. Ask for a new one below."
            : "It may have been used already, copied only in part, or replaced by a newer link. Ask for a new one below."
        }
      >
        <ResendForAddress next={next} initial={email} />
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </Frame>
    );
  }

  if (status === "verified" || (!status && sessionUser?.emailVerified)) {
    return (
      <Frame
        icon={CircleCheck}
        tone="success"
        title="Your email is verified"
        description="Thanks for confirming. You are signed in and ready to set up your books."
      >
        {/* A full page load, so the app renders with the new session. */}
        <Button className="w-full" render={<a href={next} />}>
          Continue to FinanceOS
        </Button>
      </Frame>
    );
  }

  if (status === "change-confirmed") {
    return (
      <Frame
        icon={MailCheck}
        tone="info"
        title="One more step: check your new inbox"
        description="You approved the change. We sent a link to your new address; open it to finish. Until then you keep signing in with your current email."
      >
        <Button variant="outline" className="w-full" render={<a href={next === "/" ? "/settings/profile" : next} />}>
          Back to settings
        </Button>
      </Frame>
    );
  }

  if (status === "email-changed") {
    return (
      <Frame icon={CircleCheck} tone="success" title="Your email address was changed" description="Use the new address the next time you sign in.">
        <Button className="w-full" render={<a href={next === "/" ? "/settings/profile" : next} />}>
          Back to settings
        </Button>
      </Frame>
    );
  }

  if (email) {
    return (
      <Frame
        icon={MailCheck}
        tone="info"
        title={params.get("email") ? "Check your inbox" : "Verify your email"}
        description={
          params.get("email") ? (
            <>
              We sent a verification link to <span className="font-medium text-foreground">{email}</span>. Open it to continue.
            </>
          ) : (
            <>
              Confirm <span className="font-medium text-foreground">{email}</span> with the link we emailed you. Lost it? Send a new one.
            </>
          )
        }
      >
        <ResendVerification email={email} next={next} label={params.get("email") ? "Resend the email" : "Send a new link"} />
      </Frame>
    );
  }

  return (
    <Frame icon={MailCheck} tone="info" title="Verify your email" description="Open the link we emailed you. Lost it? Enter your address for a new one.">
      <ResendForAddress next={next} />
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </Frame>
  );
}
