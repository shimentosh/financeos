"use client";

import { ROLE_DESCRIPTIONS } from "@financeos/core";
import { Briefcase, Clock, MailWarning, ShieldAlert, User, UserX } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { expiresIn, type InvitationLookup, ROLE_LABELS } from "./shared";

const invitePath = (token: string) => `/invite?token=${encodeURIComponent(token)}`;
const withNext = (path: string, token: string) => `${path}?next=${encodeURIComponent(invitePath(token))}`;

/** Into the app, with a full load so the workspace the API just made active is the one that opens. */
function openApp() {
  window.location.assign("/");
}

/** The invitation page: who invited you where, and the one thing to do next. */
export function InviteCard({ token, invitation }: { token: string; invitation: InvitationLookup }) {
  const { viewer } = invitation;

  if (invitation.status === "revoked") {
    return (
      <InviteProblem
        icon={UserX}
        title="This invitation was withdrawn"
        description={`${invitation.inviterName} withdrew the invitation to ${invitation.workspaceName}, or sent a newer one. Ask them for a new link if you still need access.`}
        signedIn={Boolean(viewer)}
      />
    );
  }
  if (invitation.status === "accepted") {
    return viewer?.alreadyMember ? (
      <InviteProblem
        icon={Briefcase}
        tone="good"
        title={`You're in ${invitation.workspaceName}`}
        description="This invitation has been accepted."
        action={<OpenWorkspaceButton workspaceId={viewer.workspaceId} />}
        signedIn
      />
    ) : (
      <InviteProblem
        icon={UserX}
        title="This invitation has already been used"
        description={`Each link works once. Ask ${invitation.inviterName} for a new one if you still need access to ${invitation.workspaceName}.`}
        signedIn={Boolean(viewer)}
      />
    );
  }
  if (invitation.expired) {
    return (
      <InviteProblem
        icon={Clock}
        title="This invitation has expired"
        description={`Invitation links last 7 days. Ask ${invitation.inviterName} to send you a new one for ${invitation.workspaceName}.`}
        signedIn={Boolean(viewer)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <InviteHeader invitation={invitation} />
      {!viewer ? (
        <SignedOut token={token} invitation={invitation} />
      ) : viewer.alreadyMember && !viewer.matches ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">You're already a member of {invitation.workspaceName}.</p>
          <OpenWorkspaceButton workspaceId={viewer.workspaceId} />
        </div>
      ) : !viewer.matches ? (
        <WrongAccount token={token} invitation={invitation} signedInAs={viewer.email} />
      ) : !viewer.emailVerified ? (
        <Unverified token={token} email={viewer.email} />
      ) : (
        <Accept token={token} invitation={invitation} />
      )}
    </div>
  );
}

function InviteHeader({ invitation }: { invitation: InvitationLookup }) {
  const Icon = invitation.workspaceKind === "business" ? Briefcase : User;
  return (
    <div className="space-y-3">
      <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <Icon className="size-5" />
      </span>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold leading-snug">
          {invitation.inviterName} invited you to join {invitation.workspaceName}
        </h1>
        <p className="text-sm text-muted-foreground">
          A {invitation.workspaceKind} workspace on FinanceOS. Sent to <span className="font-medium text-foreground">{invitation.email}</span>, expires{" "}
          {expiresIn(invitation.expiresAt)}.
        </p>
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <Badge variant="outline">{ROLE_LABELS[invitation.role]}</Badge>
        <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[invitation.role]}</p>
      </div>
    </div>
  );
}

function SignedOut({ token, invitation }: { token: string; invitation: InvitationLookup }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Sign in, or create an account, with <span className="font-medium text-foreground">{invitation.email}</span> to accept. Come back to this link afterwards
        if it doesn't open by itself.
      </p>
      <div className="grid gap-2">
        <Button className="w-full" render={<Link href={withNext("/sign-in", token)} />}>
          Sign in to accept
        </Button>
        <Button className="w-full" variant="outline" render={<Link href={withNext("/sign-up", token)} />}>
          Create an account
        </Button>
      </div>
    </div>
  );
}

function WrongAccount({ token, invitation, signedInAs }: { token: string; invitation: InvitationLookup; signedInAs: string }) {
  const [busy, setBusy] = useState(false);
  const switchAccount = async () => {
    setBusy(true);
    await signOut().catch(() => undefined);
    window.location.assign(withNext("/sign-in", token));
  };
  return (
    <div className="space-y-3">
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>This invitation is for a different email</AlertTitle>
        <AlertDescription>
          <span>
            It was sent to <span className="font-medium text-foreground">{invitation.email}</span>, but you're signed in as{" "}
            <span className="font-medium text-foreground">{signedInAs}</span>. Only the invited address can accept it.
          </span>
        </AlertDescription>
      </Alert>
      <Button className="w-full" loading={busy} onClick={() => void switchAccount()}>
        Sign in with the invited email
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Should it be this account? Ask {invitation.inviterName} to invite {signedInAs} instead.
      </p>
    </div>
  );
}

function Unverified({ token, email }: { token: string; email: string }) {
  return (
    <div className="space-y-3">
      <Alert variant="warning">
        <MailWarning />
        <AlertTitle>Verify your email first</AlertTitle>
        <AlertDescription>
          <span>
            To keep invitations safe, only a verified address can accept one. Confirm <span className="font-medium text-foreground">{email}</span> with the link
            we emailed you, then open this invitation again.
          </span>
        </AlertDescription>
      </Alert>
      <Button className="w-full" render={<Link href={withNext("/verify-email", token)} />}>
        Verify my email
      </Button>
    </div>
  );
}

function Accept({ token, invitation }: { token: string; invitation: InvitationLookup }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);

  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await clientApi("/invitations/accept", { method: "POST", body: { token } });
      toast.success(`Welcome to ${invitation.workspaceName}`);
      openApp();
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError) setProblem({ code: error.code, message: error.message });
      else setProblem({ code: "error", message: "Something went wrong. Try again." });
    }
  };

  return (
    <div className="space-y-3">
      <Button className="w-full" loading={busy} onClick={() => void accept()}>
        Accept and open {invitation.workspaceName}
      </Button>
      {problem && (
        <Alert variant={problem.code === "plan_limit" ? "warning" : "error"}>
          <AlertTitle>{problem.code === "plan_limit" ? "The workspace is full" : "Couldn't accept the invitation"}</AlertTitle>
          <AlertDescription>
            <span>
              {problem.message}
              {problem.code === "plan_limit" && ` Ask ${invitation.inviterName} to upgrade their plan or free up a seat, then try again.`}
              {problem.code === "email_unverified" && (
                <>
                  {" "}
                  <Link href={withNext("/verify-email", token)} className="font-medium text-foreground underline underline-offset-4">
                    Verify your email
                  </Link>
                </>
              )}
            </span>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function OpenWorkspaceButton({ workspaceId }: { workspaceId: string | null }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      if (workspaceId) await clientApi("/me/active-workspace", { method: "POST", body: { workspaceId } });
    } catch {
      // Opening the app anyway lands in whichever workspace is active.
    }
    openApp();
  };
  return (
    <Button className="w-full" loading={busy} onClick={() => void open()}>
      Open the workspace
    </Button>
  );
}

/** No invitation behind the link: mistyped, cut off, or replaced by a newer one. */
export function InviteNotFound({ reason, signedIn }: { reason: "invalid" | "rate_limited"; signedIn: boolean }) {
  return reason === "rate_limited" ? (
    <InviteProblem icon={Clock} title="Too many attempts" description="Wait a minute, then open the invitation link again." signedIn={signedIn} />
  ) : (
    <InviteProblem
      icon={UserX}
      title="This invitation link doesn't work"
      description="It may be incomplete, or a newer invitation replaced it. Open the latest invitation email, or ask the person who invited you to send it again."
      signedIn={signedIn}
    />
  );
}

/** A link that can't be used (any more), with the way forward. */
function InviteProblem({
  icon: Icon,
  title,
  description,
  action,
  signedIn,
  tone = "warn",
}: {
  icon: typeof Clock;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  signedIn: boolean;
  tone?: "warn" | "good";
}) {
  return (
    <div className="space-y-4">
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-xl",
          tone === "good" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold leading-snug">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action ?? (
        <Button className="w-full" variant="outline" render={<Link href={signedIn ? "/" : "/sign-in"} />}>
          {signedIn ? "Go to FinanceOS" : "Sign in"}
        </Button>
      )}
    </div>
  );
}
