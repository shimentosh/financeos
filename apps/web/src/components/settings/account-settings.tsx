"use client";

import { DEFAULT_REMINDER_OFFSETS } from "@financeos/core";
import { Copy, Download, KeyRound, Laptop, LogOut, MailCheck, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { encode } from "uqr";
import { useApp } from "@/components/app/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import { authClient } from "@/lib/auth-client";
import { formatDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { SettingsCard } from "./settings-page";

type SessionUserFlags = { emailVerified?: boolean; twoFactorEnabled?: boolean };

/** Better Auth error → a sentence for a toast. */
function authError(error: { code?: string; message?: string; status?: number } | null | undefined, fallback: string) {
  if (!error) return fallback;
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (error.code === "INVALID_PASSWORD") return "That password is not right.";
  if (error.code === "INVALID_CODE") return "That code did not match. Try the current one from your app.";
  if (error.code === "SESSION_NOT_FRESH") return "For your security, sign in again before changing this.";
  return error.message || fallback;
}

function ChangeEmail({ currentEmail, verified }: { currentEmail: string; verified: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async () => {
    const value = newEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(value)) return toast.error("Enter a valid email address");
    if (value === currentEmail.toLowerCase()) return toast.error("That is already your email");
    setBusy(true);
    const result = await authClient.changeEmail({ newEmail: value, callbackURL: "/settings/profile" });
    setBusy(false);
    if (result.error) return toast.error(authError(result.error, "Could not start the email change"));
    // A verified address approves the change first; an unverified one goes straight to the new address.
    setSentTo(verified ? currentEmail : value);
    setOpen(false);
    setNewEmail("");
  };

  if (sentTo) {
    return (
      <div className="flex gap-2 rounded-lg bg-info/8 px-3 py-2 text-sm text-info-foreground">
        <MailCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          {verified ? (
            <>
              We sent a link to <span className="font-medium">{sentTo}</span> to approve the change. After that, confirm it from the new address. Your email
              stays the same until then.
            </>
          ) : (
            <>
              We sent a confirmation link to <span className="font-medium">{sentTo}</span>. Your email changes once you open it.
            </>
          )}{" "}
          <button type="button" className="underline underline-offset-4" onClick={() => setSentTo(null)}>
            Done
          </button>
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Change email
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <Label htmlFor={`${id}-new-email`}>New email</Label>
        <Input id={`${id}-new-email`} type="email" autoComplete="email" autoFocus value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {verified
            ? `For your security, we first ask ${currentEmail} to approve the change, then the new address to confirm it.`
            : "We send a confirmation link to the new address."}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" loading={busy} disabled={!newEmail.trim()} onClick={() => void submit()}>
          Send confirmation
        </Button>
      </div>
    </div>
  );
}

function VerifyEmailNow({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const send = async () => {
    setState("busy");
    const result = await authClient.sendVerificationEmail({ email, callbackURL: "/settings/profile" });
    if (result.error) {
      setState("idle");
      return toast.error(authError(result.error, "Could not send the verification email"));
    }
    setState("sent");
    toast.success(`Verification link sent to ${email}`);
  };
  return (
    <Button size="xs" variant="ghost" loading={state === "busy"} disabled={state === "sent"} onClick={() => void send()}>
      {state === "sent" ? "Link sent" : "Send verification link"}
    </Button>
  );
}

export function ProfileSettings() {
  const { me } = useApp();
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState(me.user.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [busy, setBusy] = useState<"name" | "password" | null>(null);
  const session = authClient.useSession();
  const sessionUser = session.data?.user as (SessionUserFlags & { email?: string }) | undefined;
  const email = sessionUser?.email ?? me.user.email;
  const verified = sessionUser?.emailVerified;

  const saveName = async () => {
    setBusy("name");
    const result = await authClient.updateUser({ name: name.trim() });
    setBusy(null);
    if (result.error) return toast.error(result.error.message ?? "Could not save your name");
    toast.success("Name updated");
    router.refresh();
  };

  const changePassword = async () => {
    if (next.length < 10) return toast.error("The new password needs at least 10 characters");
    setBusy("password");
    const result = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: signOutOthers });
    setBusy(null);
    if (result.error) return toast.error(result.error.message ?? "Could not change the password");
    setCurrent("");
    setNext("");
    toast.success(signOutOthers ? "Password changed; other devices were signed out" : "Password changed");
  };

  return (
    <>
      <SettingsCard
        title="Your details"
        footer={
          <Button size="sm" loading={busy === "name"} disabled={!name.trim() || name === me.user.name} onClick={() => void saveName()}>
            Save
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-email`} className="flex items-center gap-2">
              Email
              {verified === true && (
                <Badge variant="success" size="sm">
                  Verified
                </Badge>
              )}
              {verified === false && (
                <Badge variant="warning" size="sm">
                  Not verified
                </Badge>
              )}
            </Label>
            <Input id={`${id}-email`} value={email} disabled />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ChangeEmail currentEmail={email} verified={verified === true} />
          {verified === false && <VerifyEmailNow email={email} />}
        </div>
      </SettingsCard>
      <SettingsCard
        title="Password"
        description="At least 10 characters. Your finances are behind it."
        footer={
          <Button size="sm" loading={busy === "password"} disabled={!current || !next} onClick={() => void changePassword()}>
            Change password
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-current`}>Current password</Label>
            <Input id={`${id}-current`} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-new`}>New password</Label>
            <Input id={`${id}-new`} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={signOutOthers} onCheckedChange={setSignOutOthers} /> Sign out my other devices
        </label>
      </SettingsCard>
    </>
  );
}

function setTheme(theme: "light" | "dark" | "system") {
  try {
    localStorage.setItem("ew-theme", theme);
  } catch {}
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function PreferencesSettings() {
  const { me } = useApp();
  const router = useRouter();
  const [theme, setThemeValue] = useState(me.preferences.theme ?? "system");
  const [numberLocale, setNumberLocale] = useState(me.preferences.numberLocale ?? "en-IN");
  const [weekStartsOn, setWeekStartsOn] = useState(String(me.preferences.weekStartsOn ?? 6));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await clientApi("/me/preferences", { method: "PATCH", body: { theme, numberLocale, weekStartsOn: Number(weekStartsOn) } });
      setTheme(theme);
      toast.success("Preferences saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Display"
      footer={
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>Theme</Label>
          <Select value={theme} onValueChange={(v) => typeof v === "string" && setThemeValue(v as typeof theme)}>
            <SelectTrigger>
              <SelectValue>{theme === "system" ? "Match device" : theme === "dark" ? "Dark" : "Light"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">Match device</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Number format</Label>
          <Select value={numberLocale} onValueChange={(v) => typeof v === "string" && setNumberLocale(v as typeof numberLocale)}>
            <SelectTrigger>
              <SelectValue>{numberLocale === "en-IN" ? "1,00,000 (lakh)" : "100,000"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en-IN">1,00,000 (lakh)</SelectItem>
              <SelectItem value="en-US">100,000</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Week starts on</Label>
          <Select value={weekStartsOn} onValueChange={(v) => typeof v === "string" && setWeekStartsOn(v)}>
            <SelectTrigger>
              <SelectValue>{weekStartsOn === "6" ? "Saturday" : weekStartsOn === "0" ? "Sunday" : "Monday"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="6">Saturday</SelectItem>
              <SelectItem value="0">Sunday</SelectItem>
              <SelectItem value="1">Monday</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </SettingsCard>
  );
}

export function NotificationSettings() {
  const { me, workspace, canManage } = useApp();
  const router = useRouter();
  const [email, setEmail] = useState(me.preferences.notifications?.email ?? true);
  const [offsets, setOffsets] = useState((workspace.settings.reminderOffsets ?? DEFAULT_REMINDER_OFFSETS).join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = offsets
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) return toast.error("Reminder days must be whole numbers between 0 and 365");
    setSaving(true);
    try {
      await clientApi("/me/preferences", { method: "PATCH", body: { notifications: { email, inApp: true } } });
      if (canManage) {
        await clientApi("/workspaces/current", { method: "PATCH", body: { settings: { reminderOffsets: [...new Set(parsed)].sort((a, b) => b - a) } } });
      }
      toast.success("Notification settings saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Alerts"
      description="Renewals, bills, overdue invoices, budget warnings and failed syncs."
      footer={
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
        <span>
          In-app notifications
          <span className="block text-xs text-muted-foreground">Always on: the bell at the top of every page.</span>
        </span>
        <Switch checked disabled />
      </label>
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
        <span>
          Email me too
          <span className="block text-xs text-muted-foreground">Sent when the server has an email provider configured.</span>
        </span>
        <Switch checked={email} onCheckedChange={setEmail} />
      </label>
      <div className="space-y-1">
        <Label htmlFor="reminder-offsets">Remind me this many days before a renewal or bill ({workspace.name})</Label>
        <Input id="reminder-offsets" value={offsets} onChange={(e) => setOffsets(e.target.value)} disabled={!canManage} />
        <p className="text-xs text-muted-foreground">Comma-separated, e.g. 45, 30, 7, 1, 0. Each subscription can override this.</p>
      </div>
    </SettingsCard>
  );
}

/** The otpauth:// link as a QR code, drawn as SVG squares (dark on white in either theme, so any camera reads it). */
function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="size-44 rounded-lg border border-border bg-white" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `FinanceOS backup codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join("\n")}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Backup codes copied");
    } catch {
      toast.error("Could not copy; select the codes instead");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "financeos-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-warning/8 px-3 py-2 text-sm text-warning-foreground">
        Save these backup codes now. They are shown only once, and each gets you in once if you lose your phone.
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm tabular-nums sm:grid-cols-3">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          <Download className="size-3.5" /> Download
        </Button>
        <Button size="sm" onClick={onDone}>
          I saved them
        </Button>
      </div>
    </div>
  );
}

type TwoFactorStep =
  | { kind: "idle" }
  | { kind: "password"; purpose: "enable" | "disable" | "codes" }
  | { kind: "setup"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; codes: string[] };

/** Two-step verification: turn on with an authenticator app, turn off, or get new backup codes. */
function TwoFactorCard({ onSessionChanged }: { onSessionChanged: () => void }) {
  const id = useId();
  const session = authClient.useSession();
  const enabled = (session.data?.user as SessionUserFlags | undefined)?.twoFactorEnabled === true;
  const [step, setStep] = useState<TwoFactorStep>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep({ kind: "idle" });
    setPassword("");
    setCode("");
  };

  // Turning 2FA on or off replaces this device's session: refresh what depends on it.
  const refresh = async () => {
    await session.refetch();
    onSessionChanged();
  };

  const confirmPassword = async (purpose: "enable" | "disable" | "codes") => {
    if (!password) return toast.error("Enter your password");
    setBusy(true);
    if (purpose === "enable") {
      const result = await authClient.twoFactor.enable({ password });
      setBusy(false);
      if (result.error || !result.data) return toast.error(authError(result.error, "Could not start two-step verification"));
      const data = result.data as { totpURI?: string; backupCodes?: string[] };
      if (!data.totpURI) return toast.error("The server did not return a setup key");
      setPassword("");
      setStep({ kind: "setup", totpURI: data.totpURI, backupCodes: data.backupCodes ?? [] });
      return;
    }
    if (purpose === "disable") {
      const result = await authClient.twoFactor.disable({ password });
      setBusy(false);
      if (result.error) return toast.error(authError(result.error, "Could not turn off two-step verification"));
      toast.success("Two-step verification is off");
      reset();
      await refresh();
      return;
    }
    const result = await authClient.twoFactor.generateBackupCodes({ password });
    setBusy(false);
    if (result.error || !result.data) return toast.error(authError(result.error, "Could not create new backup codes"));
    setPassword("");
    setStep({ kind: "codes", codes: (result.data as { backupCodes: string[] }).backupCodes });
  };

  const verifySetup = async (setup: Extract<TwoFactorStep, { kind: "setup" }>) => {
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) return toast.error("Enter the 6-digit code from your app");
    setBusy(true);
    const result = await authClient.twoFactor.verifyTotp({ code: value });
    setBusy(false);
    if (result.error) return toast.error(authError(result.error, "Could not check the code"));
    toast.success("Two-step verification is on");
    setCode("");
    setStep({ kind: "codes", codes: setup.backupCodes });
    await refresh();
  };

  const secret = step.kind === "setup" ? (new URL(step.totpURI).searchParams.get("secret") ?? "") : "";

  return (
    <SettingsCard
      title="Two-step verification"
      description="After your password, sign-in asks for a code from an authenticator app (Google Authenticator, 1Password, Authy and others)."
    >
      {step.kind === "idle" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={
                enabled
                  ? "flex size-8 items-center justify-center rounded-lg bg-success/10 text-success-foreground"
                  : "flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"
              }
            >
              {enabled ? <ShieldCheck className="size-4" /> : <ShieldOff className="size-4" />}
            </span>
            <div>
              <p className="text-sm font-medium">{enabled ? "On" : "Off"}</p>
              <p className="text-xs text-muted-foreground">
                {enabled ? "A code from your app is needed at every new sign-in." : "Anyone with your password can sign in."}
              </p>
            </div>
          </div>
          {session.isPending ? null : enabled ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep({ kind: "password", purpose: "codes" })}>
                <KeyRound className="size-3.5" /> New backup codes
              </Button>
              <Button size="sm" variant="destructive-outline" onClick={() => setStep({ kind: "password", purpose: "disable" })}>
                Turn off
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setStep({ kind: "password", purpose: "enable" })}>
              Turn on
            </Button>
          )}
        </div>
      )}

      {step.kind === "password" && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmPassword(step.purpose);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`${id}-password`}>Confirm your password</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {step.purpose === "enable"
                ? "Next you will scan a QR code with your authenticator app."
                : step.purpose === "disable"
                  ? "Sign-in will ask only for your password again."
                  : "Your old backup codes stop working."}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant={step.purpose === "disable" ? "destructive" : "default"} loading={busy}>
              {step.purpose === "enable" ? "Continue" : step.purpose === "disable" ? "Turn off" : "Create new codes"}
            </Button>
          </div>
        </form>
      )}

      {step.kind === "setup" && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void verifySetup(step);
          }}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <QrCode value={step.totpURI} label="QR code to add FinanceOS to your authenticator app" />
            <div className="min-w-0 flex-1 space-y-3 text-sm">
              <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
                <li>Open your authenticator app and add an account.</li>
                <li>Scan this QR code, or enter the key below.</li>
                <li>Type the 6-digit code the app shows.</li>
              </ol>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Setup key</p>
                <p className="break-all rounded-md bg-muted/60 px-2 py-1 font-mono text-xs">{secret.match(/.{1,4}/g)?.join(" ")}</p>
                <a href={step.totpURI} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                  Open in an authenticator app on this device
                </a>
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-code`}>Code from the app</Label>
            <Input
              id={`${id}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123 456"
              className="max-w-40 font-mono tracking-widest tabular-nums"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Verify and turn on
            </Button>
          </div>
        </form>
      )}

      {step.kind === "codes" && <BackupCodes codes={step.codes} onDone={reset} />}
    </SettingsCard>
  );
}

type SessionRow = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string | Date; expiresAt: string | Date };

export function SecuritySettings() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [currentToken, setCurrentToken] = useState<string | null>(null);

  const load = async () => {
    const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    setSessions((list.data as SessionRow[] | null) ?? []);
    setCurrentToken(current.data?.session.token ?? null);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    void load();
  }, []);

  const revoke = async (token: string) => {
    const result = await authClient.revokeSession({ token });
    if (result.error) return toast.error(result.error.message ?? "Could not sign that device out");
    toast.success("Signed out");
    void load();
  };

  const revokeOthers = async () => {
    const result = await authClient.revokeOtherSessions();
    if (result.error) return toast.error(result.error.message ?? "Could not sign other devices out");
    toast.success("Other devices signed out");
    void load();
  };

  return (
    <>
      <TwoFactorCard onSessionChanged={() => void load()} />
      <SettingsCard
        title="Signed-in devices"
        description="Sign out anything you do not recognise."
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => void revokeOthers()}>
              Sign out other devices
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={async () => {
                await authClient.signOut();
                router.push("/sign-in");
              }}
            >
              <LogOut className="size-3.5" /> Sign out here
            </Button>
          </>
        }
      >
        {sessions === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((session) => {
              const mobile = /mobile|android|iphone/i.test(session.userAgent ?? "");
              const current = session.token === currentToken;
              return (
                <li key={session.id} className="flex items-center gap-3 py-2">
                  {mobile ? <Smartphone className="size-4 text-muted-foreground" /> : <Laptop className="size-4 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{(session.userAgent ?? "Unknown device").replace(/\(.*?\)/g, "").slice(0, 80)}</p>
                    <p className="text-xs text-muted-foreground">
                      {session.ipAddress ?? "unknown IP"} · since {formatDateTime(String(session.createdAt))}
                      {current ? " · this device" : ""}
                    </p>
                  </div>
                  {!current && (
                    <Button size="xs" variant="ghost" onClick={() => void revoke(session.token)}>
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard title="How your data is protected">
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
          <li>Every request is checked against your workspace membership on the server.</li>
          <li>Integration credentials are encrypted with AES-256-GCM and never sent to the browser.</li>
          <li>Receipts and screenshots are served only to members of their workspace.</li>
          <li>Every financial change is written to the audit log with before and after values.</li>
        </ul>
      </SettingsCard>
    </>
  );
}
