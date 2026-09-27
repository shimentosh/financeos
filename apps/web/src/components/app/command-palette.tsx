"use client";

import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Camera, ClipboardPaste, type LucideIcon, Mic, Plug, Settings, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { openAddTransaction } from "@/components/app/global-actions";
import { destinations } from "@/components/app/nav";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";

type PaletteItem = { id: string; label: string; hint?: string; icon: LucideIcon; run: () => void; keywords?: string };
type PaletteGroup = { value: string; label: string; items: PaletteItem[] };

/**
 * ⌘K: go anywhere, record something, or ask the Copilot. A question goes to
 * the Copilot page, which answers only from the ledger.
 */
export function CommandPalette() {
  const router = useRouter();
  const { workspace } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      setQuery(detail?.query ?? "");
      setOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("ew:command", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("ew:command", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (href: string) => () => {
    setOpen(false);
    router.push(href);
  };

  // `go` closes over router and setOpen only, both stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const groups = useMemo<PaletteGroup[]>(() => {
    const trimmed = query.trim();
    const ask: PaletteGroup[] = trimmed
      ? [
          {
            value: "ask",
            label: "Ask AI",
            items: [
              {
                id: "ask",
                label: `Ask: “${trimmed}”`,
                hint: "Answered from your ledger",
                icon: Sparkles,
                keywords: trimmed,
                run: go(`/ai/copilot?q=${encodeURIComponent(trimmed)}`),
              },
              {
                id: "capture",
                label: `Record: “${trimmed}”`,
                hint: "Turn this sentence into a transaction draft",
                icon: ClipboardPaste,
                keywords: trimmed,
                run: go(`/capture?mode=text&text=${encodeURIComponent(trimmed)}`),
              },
            ],
          },
        ]
      : [];
    const actions: PaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [
        {
          id: "a-expense",
          label: "Add expense",
          icon: ArrowUpRight,
          run: () => {
            setOpen(false);
            openAddTransaction("expense");
          },
        },
        {
          id: "a-income",
          label: "Add income",
          icon: ArrowDownLeft,
          run: () => {
            setOpen(false);
            openAddTransaction("income");
          },
        },
        {
          id: "a-transfer",
          label: "Add transfer",
          icon: ArrowLeftRight,
          run: () => {
            setOpen(false);
            openAddTransaction("transfer");
          },
        },
        { id: "a-scan", label: "Scan a screenshot or receipt", icon: Camera, run: go("/capture?mode=screenshot") },
        { id: "a-voice", label: "Record by voice", icon: Mic, run: go("/capture?mode=voice") },
      ],
    };
    const pages: PaletteGroup = {
      value: "pages",
      label: "Go to",
      // Every tab too, so "assets" or "budgets" jumps straight there.
      items: [
        ...destinations(workspace.kind).map((item) => ({ id: `p-${item.href}`, label: item.title, hint: item.group, icon: item.icon, run: go(item.href) })),
        { id: "p-integrations", label: "Integrations", hint: "Settings", icon: Plug, run: go("/integrations") },
        { id: "p-settings", label: "Settings", hint: "Workspace", icon: Settings, run: go("/settings") },
      ],
    };
    return [...ask, actions, pages];
  }, [query, workspace.kind]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup instant>
        <Command items={groups}>
          <CommandInput placeholder="Search pages, record something, or ask a question…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <CommandPanel>
            <CommandEmpty>
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches. Press Enter on “Ask” to ask the Copilot.</p>
            </CommandEmpty>
            <CommandList>
              {(group: PaletteGroup, index: number) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.label}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => (
                        <CommandItem
                          key={item.id}
                          value={`${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`}
                          onClick={item.run}
                          className="flex items-center gap-3"
                        >
                          <item.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                          {item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  {index < groups.length - 1 && <CommandSeparator />}
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
