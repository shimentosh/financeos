import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

const sections: LegalSection[] = [
  {
    id: "what",
    title: "What we collect",
    body: (
      <ul>
        <li>
          <strong>Account details:</strong> your name, email address, password (stored only as a salted hash), two-factor settings and preferences.
        </li>
        <li>
          <strong>Your financial records:</strong> everything you enter, capture, import or connect — accounts, transactions, categories, bills, budgets, goals,
          assets, debts, notes — and files such as receipts, invoices, screenshots and statements.
        </li>
        <li>
          <strong>Connections:</strong> if you connect an app or service, the credentials needed to read from it (encrypted) and the records it sends.
        </li>
        <li>
          <strong>Payments:</strong> which plan you are on and your payment history. Card and wallet details are handled by our payment processors; we never see
          or store full card numbers.
        </li>
        <li>
          <strong>Technical data:</strong> sign-in sessions (IP address, browser), security and audit logs, error reports and basic usage counts needed to run
          and protect the service.
        </li>
      </ul>
    ),
  },
  {
    id: "why",
    title: "How we use it",
    body: (
      <ul>
        <li>To provide the service: store and show your records, compute balances and reports, send the reminders and alerts you have turned on.</li>
        <li>To keep it secure: detect abuse, investigate problems, and keep an audit trail of changes in each workspace.</li>
        <li>To bill paid plans and send receipts.</li>
        <li>To answer you when you contact support.</li>
      </ul>
    ),
  },
  {
    id: "ai",
    title: "AI processing",
    body: (
      <>
        <p>
          When you use an AI feature — reading a receipt or screenshot, categorising, writing a report summary, or asking the copilot — the relevant content
          (for example the image you captured, or the figures the copilot looked up for your question) is sent to the AI provider the service is configured
          with, only to produce that result. We use providers' business APIs, under which your content is not used to train their models.
        </p>
        <p>Workspace owners can turn AI off in Settings → AI. Things you ask the copilot to remember are stored in your workspace and can be deleted there.</p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who we share it with",
    body: (
      <>
        <p>We do not sell your data or use it for advertising. We share it only with:</p>
        <ul>
          <li>People you invite to a workspace, according to their role.</li>
          <li>
            Service providers that run parts of Expense Wise for us: hosting and databases, file storage, email delivery, AI model providers, error monitoring
            and payment processors — each only for its task.
          </li>
          <li>Apps you connect or give an API key to, for the data you allow them to read or write.</li>
          <li>Authorities, when the law requires it.</li>
        </ul>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect it",
    body: (
      <ul>
        <li>Encryption in transit (HTTPS) and encryption of credentials and keys at rest.</li>
        <li>Files in private storage, opened only through your workspace after a permission check.</li>
        <li>Workspace isolation on every request, optional two-factor sign-in, rate limits, and a full audit log of changes.</li>
        <li>Regular backups.</li>
      </ul>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <p>
        We keep your data while your account exists. When you delete your account, the workspaces you own alone are deleted with their records and files;
        backups roll over and are gone within 30 days. We keep payment records as long as tax and accounting law requires.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your choices and rights",
    body: (
      <ul>
        <li>
          <strong>Access and export:</strong> download your data as JSON or CSV from Settings → Data &amp; account.
        </li>
        <li>
          <strong>Correction:</strong> edit anything in the app, or your profile in Settings.
        </li>
        <li>
          <strong>Deletion:</strong> delete records, workspaces or your whole account yourself.
        </li>
        <li>
          <strong>Emails:</strong> turn alert emails off in Settings → Notifications (security and billing emails are always sent).
        </li>
        <li>Depending on where you live you may have further rights, such as objecting to processing or complaining to a data protection authority.</li>
      </ul>
    ),
  },
  {
    id: "cookies",
    title: "Cookies",
    body: (
      <p>
        We use only the cookies the service needs to work: your sign-in session and the workspace you last opened. There are no advertising or tracking cookies,
        so there is nothing to opt out of.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: <p>If we change this policy in a meaningful way we will tell you by email or in the app before the change applies.</p>,
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions or requests about your data? Use the{" "}
        <Link href="/contact" className="underline underline-offset-4">
          contact page
        </Link>{" "}
        and we will answer.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="26 September 2026"
      intro={
        <p>
          Your financial records are about as personal as data gets. This policy explains what Expense Wise collects, why, who helps us process it, and the
          control you have over it.
        </p>
      }
      sections={sections}
    />
  );
}
