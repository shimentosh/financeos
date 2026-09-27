"use client";

import { BookOpen, FileText, LifeBuoy, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useApp } from "@/components/app/app-context";
import { SupportForm } from "@/components/marketing/support-form";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";

/** Help & support from inside the app: a message to the team (with the account attached) and the useful links. */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { me } = useApp();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LifeBuoy className="size-5" aria-hidden /> Help &amp; support
          </DialogTitle>
          <DialogDescription>Write to the team. Your message arrives with your account, so you don't need to explain who you are.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <SupportForm defaultName={me.user.name} defaultEmail={me.user.email} />
          <div className="grid gap-2 border-t border-border pt-4 text-sm sm:grid-cols-3">
            <Link
              href="/ai/copilot"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-accent/50"
              onClick={() => onOpenChange(false)}
            >
              <BookOpen className="size-4 text-muted-foreground" aria-hidden /> Ask the copilot
            </Link>
            <Link href="/terms" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-accent/50" target="_blank">
              <FileText className="size-4 text-muted-foreground" aria-hidden /> Terms
            </Link>
            <Link href="/privacy" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-accent/50" target="_blank">
              <ShieldCheck className="size-4 text-muted-foreground" aria-hidden /> Privacy
            </Link>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
