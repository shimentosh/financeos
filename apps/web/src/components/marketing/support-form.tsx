"use client";

import { CheckCircle2, Send } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";

/**
 * Writes to the people running the service. Used on the public contact page
 * and in the app's Help dialog (where name and email are filled in).
 */
export function SupportForm({ defaultName = "", defaultEmail = "", onSent }: { defaultName?: string; defaultEmail?: string; onSent?: () => void }) {
  const id = useId();
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  // Hidden from people; bots that fill every field give themselves away.
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (message.trim().length < 10) return setError("Tell us a little more (at least 10 characters).");
    setBusy(true);
    try {
      const result = await clientApi<{ reference: string }>("/support", {
        method: "POST",
        body: {
          name: name.trim() || null,
          email: email.trim(),
          subject: subject.trim(),
          message: message.trim(),
          page: typeof window !== "undefined" ? window.location.pathname : null,
          website,
        },
      });
      setSent(result.reference);
      onSent?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
        <CheckCircle2 className="size-10 text-emerald-600" aria-hidden />
        <p className="font-semibold">Message sent</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          We'll reply to {email}, usually within one working day. Your reference is <span className="font-mono">{sent}</span>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input id={`${id}-email`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-subject`}>Subject</Label>
        <Input
          id={`${id}-subject`}
          required
          minLength={3}
          maxLength={160}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="What's it about?"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-message`}>Message</Label>
        <Textarea
          id={`${id}-message`}
          required
          rows={6}
          maxLength={5000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What happened, what you expected, and anything that helps us reproduce it."
        />
      </div>
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden>
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <Button type="submit" loading={busy}>
        <Send aria-hidden /> Send message
      </Button>
    </form>
  );
}
