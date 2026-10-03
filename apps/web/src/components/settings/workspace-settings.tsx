"use client";

import { COMMON_CURRENCIES, minorToInput, parseMoneyInput } from "@financeos/core";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { isPlanLimit, PlanLimitNotice, type TeamInvitation, type TeamMember } from "@/components/teams/shared";
import { TeamMembers } from "@/components/teams/team-members";
import { WorkspaceDangerZone } from "@/components/teams/workspace-danger-zone";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { clientApi, errorMessage } from "@/lib/api/client";
import { toast } from "@/lib/toast";
import { SettingsCard } from "./settings-page";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TIMEZONES = [
  "Asia/Dhaka",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];

export function WorkspaceSettings({ members, invitations }: { members: TeamMember[]; invitations: TeamInvitation[] | null }) {
  const { workspace, canManage } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const id = useId();
  const [name, setName] = useState(workspace.name);
  const [baseCurrency, setBaseCurrency] = useState(workspace.baseCurrency);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [fiscal, setFiscal] = useState(String(workspace.fiscalYearStartMonth));
  const [threshold, setThreshold] = useState(
    workspace.settings.reviewThreshold ? minorToInput(workspace.settings.reviewThreshold, workspace.baseCurrency) : "",
  );
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (params.get("new") === "1") setCreating(true);
  }, [params]);

  const save = async () => {
    const reviewThreshold = threshold.trim() ? parseMoneyInput(threshold, baseCurrency) : null;
    if (threshold.trim() && reviewThreshold === null) return toast.error("Enter the review threshold as a number");
    setSaving(true);
    try {
      await clientApi("/workspaces/current", {
        method: "PATCH",
        body: { name: name.trim(), baseCurrency, timezone, fiscalYearStartMonth: Number(fiscal), settings: { reviewThreshold } },
      });
      toast.success("Workspace saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsCard
        title={`${workspace.kind === "business" ? "Business" : "Personal"} workspace`}
        description="Changing the base currency affects new transactions; existing ones keep the base amount they were recorded with."
        footer={
          canManage ? (
            <Button size="sm" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} />
          </div>
          <div className="space-y-1">
            <Label>Base (reporting) currency</Label>
            <Select value={baseCurrency} onValueChange={(v) => typeof v === "string" && setBaseCurrency(v)} disabled={!canManage}>
              <SelectTrigger>
                <SelectValue>{baseCurrency}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {COMMON_CURRENCIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Timezone</Label>
            <Select value={timezone} onValueChange={(v) => typeof v === "string" && setTimezone(v)} disabled={!canManage}>
              <SelectTrigger>
                <SelectValue>{timezone}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {[...new Set([timezone, ...TIMEZONES])].map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Financial year starts in</Label>
            <Select value={fiscal} onValueChange={(v) => typeof v === "string" && setFiscal(v)} disabled={!canManage}>
              <SelectTrigger>
                <SelectValue>{MONTHS[Number(fiscal) - 1]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((month, index) => (
                  <SelectItem key={month} value={String(index + 1)}>
                    {month}
                    {index === 6 ? " (Bangladesh FY)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${id}-threshold`}>Ask me to confirm imported or AI transactions at or above ({baseCurrency})</Label>
            <Input
              id={`${id}-threshold`}
              inputMode="decimal"
              placeholder="e.g. 50,000 — leave empty for no limit"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              disabled={!canManage}
            />
          </div>
        </div>
      </SettingsCard>

      <TeamMembers members={members} invitations={invitations} />

      <SettingsCard title="Another workspace" description="Keep a second business, a family budget or a side project completely separate.">
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" /> New workspace
        </Button>
      </SettingsCard>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />

      <WorkspaceDangerZone members={members} />
    </>
  );
}

function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "business">("business");
  const [currency, setCurrency] = useState("BDT");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setLimit(null);
    try {
      const workspace = await clientApi<{ id: string }>("/workspaces", { method: "POST", body: { name: name.trim(), kind, baseCurrency: currency } });
      await clientApi("/me/active-workspace", { method: "POST", body: { workspaceId: workspace.id } });
      toast.success(`${name} created`);
      onOpenChange(false);
      router.push("/");
      router.refresh();
    } catch (error) {
      if (isPlanLimit(error)) setLimit(error.message);
      else toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => typeof v === "string" && setKind(v as typeof kind)}>
                <SelectTrigger>
                  <SelectValue>{kind === "business" ? "Business" : "Personal"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="business">Business</SelectItem>
                  <SelectItem value="personal">Personal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Base currency</Label>
              <Select value={currency} onValueChange={(v) => typeof v === "string" && setCurrency(v)}>
                <SelectTrigger>
                  <SelectValue>{currency}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {COMMON_CURRENCIES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {limit && <PlanLimitNotice message={limit} />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
