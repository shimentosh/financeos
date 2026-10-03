"use client";

import type { AgentMemoryItem } from "@financeos/core";
import { Brain, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Section } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientApi, errorMessage } from "@/lib/api/client";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

/**
 * What the copilot remembers for this workspace: short notes the user gave it
 * ("my salary lands in BRAC on the 5th"), shown to it in every conversation
 * and to MCP agents through get_setup. Add, read and remove them here.
 */
export function AgentMemorySettings({ items }: { items: AgentMemoryItem[] }) {
  const router = useRouter();
  const { canWrite } = useApp();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim().length < 2) return;
    setSaving(true);
    try {
      const result = await clientApi<{ duplicate: boolean }>("/copilot/memory", { method: "POST", body: { text: text.trim() } });
      toast.success(result.duplicate ? "Already remembered" : "The copilot will remember that");
      setText("");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setRemoving(id);
    try {
      await clientApi(`/copilot/memory/${id}`, { method: "DELETE" });
      toast.success("Forgotten");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div id="memory" className="scroll-mt-20">
      <Section
        title="What the copilot remembers"
        hint="Context you gave it — which account pays what, your salary day, what a shop is. It uses these in every conversation; tell it “remember …” in the chat or add them here."
      >
        {items.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
                <Brain className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">{item.text}</p>
                  <p className="text-xs text-muted-foreground">{timeAgo(item.createdAt)}</p>
                </div>
                {canWrite && (
                  <Button size="icon-xs" variant="ghost" aria-label={`Forget “${item.text}”`} onClick={() => remove(item.id)} loading={removing === item.id}>
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            Nothing yet. Try telling the copilot “remember that my salary arrives in BRAC Bank on the 5th”, or add a note below.
          </p>
        )}
        {canWrite && (
          <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              placeholder="e.g. Shwapno and Chaldal are groceries; rent is paid from City Bank"
              aria-label="Something for the copilot to remember"
            />
            <Button type="submit" size="sm" variant="outline" loading={saving} disabled={text.trim().length < 2} className="shrink-0">
              <Plus aria-hidden /> Remember
            </Button>
          </form>
        )}
      </Section>
    </div>
  );
}
