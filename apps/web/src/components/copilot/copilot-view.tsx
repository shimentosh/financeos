"use client";

import type { CopilotAskResult, CopilotFact, CopilotMessageView, CopilotThreadView } from "@expensewise/core";
import { ArrowUp, History, Link2, MessageSquarePlus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Button } from "@/components/ui/button";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ActionCards, RememberedNotes } from "./action-cards";
import type { CopilotThreadDetail, CopilotThreadList } from "./types";

const FALLBACK_REASONS: Record<string, string> = {
  not_configured: "AI isn't configured on this server",
  disabled: "AI is turned off for this workspace",
  budget: "this month's AI budget is used up",
  credits: "the AI credits are used up",
  rate_limited: "too many AI requests just now",
  refusal: "the model declined this question",
  max_tokens: "the model's answer was cut off",
};

type Pending = { id: string; content: string };

/** Things to tell the copilot, offered next to the questions to people who can edit. */
const TELL: Record<"en", string[]> = {
  en: ["I paid 1,200 for groceries today", "Remember: my salary arrives on the 5th"],
};

/**
 * Questions about the workspace's own records, and changes to them. Every
 * figure beside an answer comes from the ledger's query layer and links to
 * the records behind it; the words may come from the model, the numbers never
 * do. A change the copilot prepares is a card that does nothing until the
 * user confirms it.
 */
export function CopilotView({ list, current, initialQuestion }: { list: CopilotThreadList; current: CopilotThreadDetail | null; initialQuestion?: string }) {
  const router = useRouter();
  const { canWrite } = useApp();
  const [threads, setThreads] = useState<CopilotThreadView[]>(list.items);
  const [threadId, setThreadId] = useState<string | null>(current?.thread.id ?? null);
  const [messages, setMessages] = useState<CopilotMessageView[]>(current?.messages ?? []);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending) return;
      setPending({ id: `pending-${Date.now()}`, content: message });
      setDraft("");
      scrollToEnd();
      try {
        const result = await clientApi<CopilotAskResult>("/copilot/ask", { method: "POST", body: { message, ...(threadId ? { threadId } : {}) } });
        // A "yes" confirms earlier suggestions: their cards change too.
        const changed = new Map((result.updated ?? []).map((m) => [m.id, m]));
        setMessages((previous) => [...previous.map((m) => changed.get(m.id) ?? m), result.question, result.answer]);
        if (changed.size) router.refresh();
        setThreads((previous) => [result.thread, ...previous.filter((t) => t.id !== result.thread.id)]);
        if (!threadId) {
          setThreadId(result.thread.id);
          window.history.replaceState(null, "", `/ai/copilot?thread=${result.thread.id}`);
        }
      } catch (error) {
        toast.error(errorMessage(error));
        setDraft(message);
      } finally {
        setPending(null);
        scrollToEnd();
      }
    },
    [pending, threadId, scrollToEnd, router],
  );

  const replaceMessage = useCallback((next: CopilotMessageView) => {
    setMessages((previous) => previous.map((m) => (m.id === next.id ? next : m)));
  }, []);

  useEffect(() => {
    if (initialQuestion && !askedInitial.current) {
      askedInitial.current = true;
      void ask(initialQuestion);
    }
  }, [initialQuestion, ask]);

  // An opened conversation starts at its latest message.
  const openedWithMessages = useRef(Boolean(current?.messages.length));
  useEffect(() => {
    if (openedWithMessages.current) endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  const startNew = () => {
    setHistoryOpen(false);
    if (!threadId && !messages.length) return;
    router.push("/ai/copilot");
  };

  const open = (id: string) => {
    setHistoryOpen(false);
    if (id !== threadId) router.push(`/ai/copilot?thread=${id}`);
  };

  const remove = async (id: string) => {
    try {
      await clientApi(`/copilot/threads/${id}`, { method: "DELETE" });
      setThreads((previous) => previous.filter((t) => t.id !== id));
      toast.success("Conversation deleted");
      if (id === threadId) router.push("/ai/copilot");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant");
  const empty = !messages.length && !pending;

  const threadList = <ThreadList threads={threads} activeId={threadId} onOpen={open} onDelete={remove} onNew={startNew} />;

  return (
    <div className="flex min-h-[calc(100dvh-10rem)] gap-6">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 lg:flex">{threadList}</aside>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetPopup side="left" className="w-80 max-w-[85vw]">
          <SheetHeader>
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-2">{threadList}</SheetPanel>
        </SheetPopup>
      </Sheet>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex items-center justify-between gap-2 lg:hidden">
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden />
            History
          </Button>
          <Button variant="ghost" size="sm" onClick={startNew} disabled={empty}>
            <MessageSquarePlus aria-hidden />
            New
          </Button>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
          {empty ? (
            <Intro ai={list.ai} suggestions={canWrite ? [...list.suggestions.slice(0, 4), ...TELL.en] : list.suggestions} onAsk={ask} canWrite={canWrite} />
          ) : (
            <ol className="flex flex-col gap-6 pb-6">
              {messages.map((message) =>
                message.role === "user" ? (
                  <UserBubble key={message.id}>{message.content}</UserBubble>
                ) : (
                  <Answer
                    key={message.id}
                    message={message}
                    onAsk={ask}
                    onUpdate={replaceMessage}
                    canWrite={canWrite}
                    showFollowUps={message.id === lastAnswer?.id && !pending}
                  />
                ),
              )}
              {pending && (
                <>
                  <UserBubble>{pending.content}</UserBubble>
                  <li className="flex gap-3" aria-live="polite">
                    <AnswerAvatar />
                    <p className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                      <span className="flex gap-1" aria-hidden>
                        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
                        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
                        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
                      </span>
                      Looking through your records…
                    </p>
                  </li>
                </>
              )}
            </ol>
          )}
          <div ref={endRef} />

          <Composer value={draft} onChange={setDraft} onSubmit={() => ask(draft)} busy={Boolean(pending)} ai={list.ai} canWrite={canWrite} />
        </div>
      </section>
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onOpen,
  onDelete,
  onNew,
}: {
  threads: CopilotThreadView[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      <Button variant="outline" className="w-full justify-start" onClick={onNew}>
        <MessageSquarePlus aria-hidden />
        New conversation
      </Button>
      {threads.length ? (
        <ul className="flex flex-col gap-0.5">
          {threads.map((thread) => (
            <li key={thread.id} className="group relative">
              <button
                type="button"
                onClick={() => onOpen(thread.id)}
                className={cn(
                  "flex w-full flex-col rounded-lg px-2.5 py-2 pr-9 text-left transition-colors hover:bg-accent/60",
                  thread.id === activeId && "bg-accent",
                )}
              >
                <span className="truncate text-sm">{thread.title}</span>
                <span className="text-xs text-muted-foreground">{timeAgo(thread.updatedAt)}</span>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete “${thread.title}”`}
                onClick={() => onDelete(thread.id)}
                className="absolute top-2 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">Your conversations will appear here.</p>
      )}
    </>
  );
}

function Intro({ ai, suggestions, onAsk, canWrite }: { ai: CopilotThreadList["ai"]; suggestions: string[]; onAsk: (text: string) => void; canWrite: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
        <Sparkles className="size-6" aria-hidden />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="font-semibold text-xl tracking-tight">{canWrite ? "Ask about your money, or tell me what to record" : "Ask about your money"}</h2>
        <p className="text-sm text-muted-foreground">
          In English, Banglish or বাংলা. Answers come only from your records, and every figure links to the transactions behind it.
          {canWrite
            ? " Tell it about an expense, a new category, a bill or a budget and it prepares the change for you to confirm; nothing is saved until you do."
            : " You can view this workspace, so the copilot only reads."}
        </p>
        <AiStatus ai={ai} canWrite={canWrite} />
      </div>
      <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onAsk(suggestion)}
            className="rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm transition-colors hover:bg-accent/50"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function AiStatus({ ai, canWrite }: { ai: CopilotThreadList["ai"]; canWrite: boolean }) {
  return (
    <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", ai.available ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
      {ai.available
        ? `Using ${ai.model ?? "AI"} · ${canWrite ? "reads your records; changes wait for your confirmation" : "read-only queries"}`
        : `Built-in answers: ${FALLBACK_REASONS[ai.reason ?? "not_configured"] ?? "AI is unavailable"}`}
      {!ai.available && ai.reason === "credits" && (
        <Link href="/settings/billing" className="underline underline-offset-4 hover:text-foreground">
          Get more credits
        </Link>
      )}
    </p>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <li className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground text-sm">{children}</p>
    </li>
  );
}

function AnswerAvatar() {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400" aria-hidden>
      <Sparkles className="size-4" />
    </div>
  );
}

function Answer({
  message,
  onAsk,
  onUpdate,
  canWrite,
  showFollowUps,
}: {
  message: CopilotMessageView;
  onAsk: (text: string) => void;
  onUpdate: (message: CopilotMessageView) => void;
  canWrite: boolean;
  showFollowUps: boolean;
}) {
  const data = message.data;
  const facts = data.facts ?? [];
  const sources = data.sources ?? [];
  const queries = data.toolCalls?.length ?? 0;
  return (
    <li className="flex gap-3">
      <AnswerAvatar />
      <div className="min-w-0 flex-1 space-y-3">
        <RichText text={message.content} />
        <ActionCards message={message} canWrite={canWrite} onUpdate={onUpdate} />
        <RememberedNotes items={data.remembered ?? []} />
        {facts.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {facts.map((fact) => (
              <FactCard key={`${fact.label}|${fact.value}|${fact.href ?? ""}`} fact={fact} />
            ))}
          </div>
        )}
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sources</span>
            {sources.map((source) => (
              <Link
                key={source.href}
                href={source.href}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <Link2 className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{source.label}</span>
              </Link>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/80">
          {data.mode === "ai"
            ? `Answered by ${data.model ?? "AI"} from ${queries} ${queries === 1 ? "query" : "queries"} of your records`
            : `Built-in answer${data.fallbackReason ? ` — ${FALLBACK_REASONS[data.fallbackReason] ?? "the model couldn't answer"}` : ""}`}
        </p>
        {showFollowUps && data.followUps && data.followUps.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {data.followUps.map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => onAsk(followUp)}
                className="rounded-full border border-border px-3 py-1 text-xs transition-colors hover:bg-accent/60"
              >
                {followUp}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

const TONES: Record<NonNullable<CopilotFact["tone"]>, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-foreground",
  warning: "text-amber-600 dark:text-amber-400",
};

function FactCard({ fact }: { fact: CopilotFact }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <span className="truncate text-xs text-muted-foreground">{fact.label}</span>
        {fact.estimate && (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground uppercase tracking-wide">Estimate</span>
        )}
      </span>
      <span className={cn("mt-0.5 block truncate font-medium text-sm tabular-nums", fact.tone ? TONES[fact.tone] : "text-foreground")}>{fact.value}</span>
    </>
  );
  const className = "block min-w-0 rounded-xl border border-border bg-card px-3 py-2.5";
  return fact.href ? (
    <Link href={fact.href} className={cn(className, "transition-colors hover:bg-accent/50")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Paragraphs, "- " lists and **bold**; nothing else from the model is interpreted. */
function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        const bullets = lines.every((line) => /^\s*([-•*]|\d+\.)\s+/.test(line));
        return bullets ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text split
          <ul key={index} className="list-disc space-y-1 pl-5">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static text split
              <li key={i}>{inline(line.replace(/^\s*([-•*]|\d+\.)\s+/, ""))}</li>
            ))}
          </ul>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text split
          <p key={index} className="whitespace-pre-wrap">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text split
      <strong key={index} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text split
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  ai,
  canWrite,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  ai: CopilotThreadList["ai"];
  canWrite: boolean;
}) {
  return (
    <form
      className="sticky bottom-0 mt-auto bg-background/95 pt-2 pb-1 backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="relative">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line; never interrupt Bangla/IME composition.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            canWrite
              ? "Ask a question, or tell me: “lunch 250 from bKash”, “add a Rent category”… বাংলায়ও লিখতে পারেন"
              : "Ask about spending, bills, budgets, balances… বাংলায়ও জিজ্ঞেস করতে পারেন"
          }
          aria-label="Message the copilot"
          maxLength={2000}
          rows={1}
          className="pr-12 [&_textarea]:max-h-40 [&_textarea]:min-h-11"
        />
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !value.trim()} loading={busy} className="absolute right-2 bottom-2">
          <ArrowUp aria-hidden />
        </Button>
      </div>
      <p className="mt-1.5 hidden text-center text-[11px] text-muted-foreground sm:block">
        {canWrite ? "Changes are suggestions until you confirm" : "Read-only"} · figures come from your ledger ·{" "}
        {ai.available ? "worded by AI" : "built-in answers"}
      </p>
    </form>
  );
}
