import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

const sections: LegalSection[] = [
  {
    id: "service",
    title: "The service",
    body: (
      <p>
        FinanceOS is software for recording and understanding personal and business finances: accounts, transactions, receipts, bills, budgets, goals, assets,
        debts and reports. It is a record-keeping and planning tool. It does not hold or move your money, is not a bank or payment service, and does not give
        financial, tax, investment or legal advice.
      </p>
    ),
  },
  {
    id: "accounts",
    title: "Your account",
    body: (
      <ul>
        <li>
          You must give a real email address and keep your password (and two-factor device, if you use one) safe. You are responsible for what happens in your
          account.
        </li>
        <li>You must be old enough to form a binding contract where you live, and able to act for any business whose workspace you create.</li>
        <li>Tell us straight away through the contact page if you think someone else has accessed your account.</li>
      </ul>
    ),
  },
  {
    id: "workspaces",
    title: "Workspaces and the people you invite",
    body: (
      <>
        <p>
          The person who creates a workspace owns it. The owner decides who is invited and with which role (admin, member or viewer), and is responsible for
          having the right to share the workspace's information with them. Ownership can be transferred to another member.
        </p>
        <p>Plan limits (people, workspaces, storage, AI credits) follow the owner of each workspace.</p>
      </>
    ),
  },
  {
    id: "your-data",
    title: "Your data",
    body: (
      <>
        <p>
          Everything you put into FinanceOS — transactions, files, notes and the rest — stays yours. You give us permission to store, process and display it
          only to provide the service to you and the people you share it with, as described in our{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          .
        </p>
        <p>You can export your data at any time and delete your account from Settings → Data &amp; account.</p>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI features",
    body: (
      <>
        <p>
          Some features use AI models from third-party providers to read receipts and screenshots, suggest categories, write summaries and answer questions
          about your records. AI output can be wrong. Anything AI reads or prepares is a suggestion until you (or a rule you created) confirm it, and you are
          responsible for checking what you confirm.
        </p>
        <p>AI features use credits. Workspace owners can turn AI off; the rest of the service keeps working.</p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <ul>
        <li>Don't use the service for anything illegal, including money laundering, fraud or evading sanctions.</li>
        <li>Don't upload malware, or content you have no right to store.</li>
        <li>Don't probe, overload or try to get around the service's security, limits or billing, or access other people's workspaces.</li>
        <li>Automated access is welcome through the API and MCP with your own keys and within the published rate limits.</li>
      </ul>
    ),
  },
  {
    id: "plans",
    title: "Plans, payment and cancellation",
    body: (
      <>
        <p>
          The Free plan costs nothing. Paid plans are billed in advance, monthly or yearly, through our payment processors (for example Stripe or SSLCommerz).
          Prices are shown before you pay and may change for future periods with at least 30 days' notice.
        </p>
        <p>
          You can cancel any time; the plan then stays active until the end of the period already paid for, after which the workspace continues on Free and
          nothing is deleted. AI credit packs are one-off purchases that do not expire while your account exists. Except where the law requires otherwise,
          payments are not refundable; if something went wrong, contact us and we will put it right.
        </p>
        <p>If a payment fails we may limit paid features after a grace period until it is settled.</p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability and changes",
    body: (
      <p>
        We work to keep FinanceOS available and your data safe, and back it up regularly, but we do not promise the service will be uninterrupted or free of
        errors. We may improve, change or remove features; if a change removes something you pay for, we will tell you in advance.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Responsibility and liability",
    body: (
      <>
        <p>
          The service is provided “as is”. Keep the records you are legally required to keep (for example for tax) and check figures before relying on them for
          decisions.
        </p>
        <p>
          To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost data caused by your use of the service, and
          our total liability for any claim is limited to the amount you paid us in the twelve months before it. Nothing in these terms limits liability that
          cannot be limited by law.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and closing accounts",
    body: (
      <p>
        You can close your account at any time. We may suspend or close an account that breaks these terms or puts the service or other people at risk, and will
        tell you why unless the law prevents it. Where possible we will give you a chance to export your data first.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms. For material changes we will notify you by email or in the app before they apply; continuing to use the service afterwards
        means you accept them.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms? Use the{" "}
        <Link href="/contact" className="underline underline-offset-4">
          contact page
        </Link>
        .
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="26 September 2026"
      intro={
        <p>
          These terms are the agreement between you and FinanceOS (“we”, “us”) for using the FinanceOS website and apps. Please read them; by creating an
          account you accept them.
        </p>
      }
      sections={sections}
    />
  );
}
