import { Injectable } from "@nestjs/common";
import { badRequest } from "../../../common/errors.js";
import { demoBankConnector } from "./demo-bank.js";
import { demoPaymentsConnector } from "./demo-payments.js";
import { genericRestConnector } from "./generic-rest.js";
import { genericWebhookConnector } from "./generic-webhook.js";
import { stripeConnector } from "./stripe.js";
import type { AnyConnector, ComingSoonEntry, ConnectorCapabilities, FieldSpec } from "./types.js";

const NONE: ConnectorCapabilities = { sync: false, webhook: false, import: false, testConnection: false };
const SYNC: ConnectorCapabilities = { sync: true, webhook: false, import: false, testConnection: true };
const SYNC_AND_WEBHOOK: ConnectorCapabilities = { sync: true, webhook: true, import: false, testConnection: true };

/** Planned providers: listed in the marketplace, not connectable. */
const COMING_SOON: ComingSoonEntry[] = [
  {
    id: "paypal",
    displayName: "PayPal",
    category: "payments",
    icon: "wallet",
    website: "https://www.paypal.com",
    description: "Sales, fees, refunds and withdrawals from your PayPal balance.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "wise",
    displayName: "Wise",
    category: "banking",
    icon: "globe",
    website: "https://wise.com",
    description: "Multi-currency balances and transfers, with the rate Wise actually used.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "payoneer",
    displayName: "Payoneer",
    category: "payments",
    icon: "banknote",
    website: "https://www.payoneer.com",
    description: "Marketplace and client payments received in USD, EUR and GBP, and withdrawals to your local bank.",
    capabilities: SYNC,
  },
  {
    id: "lemon_squeezy",
    displayName: "Lemon Squeezy",
    category: "payments",
    icon: "citrus",
    website: "https://www.lemonsqueezy.com",
    description: "Orders, subscriptions, refunds and payouts from your merchant-of-record store.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "paddle",
    displayName: "Paddle",
    category: "payments",
    icon: "credit-card",
    website: "https://www.paddle.com",
    description: "Subscription revenue, taxes withheld, refunds and payouts.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "shopify",
    displayName: "Shopify",
    category: "ecommerce",
    icon: "shopping-bag",
    website: "https://www.shopify.com",
    description: "Orders, refunds, payment fees and payouts from your Shopify store.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "bkash_merchant",
    displayName: "bKash Merchant",
    category: "payments",
    icon: "smartphone",
    website: "https://www.bkash.com",
    description: "Merchant collections and settlements from the bKash payment gateway.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "open_banking",
    displayName: "Bank feeds",
    category: "banking",
    icon: "landmark",
    description: "Direct feeds from banks that offer account APIs, starting with Bangladeshi banks' corporate APIs.",
    capabilities: SYNC,
  },
  {
    id: "quickbooks",
    displayName: "QuickBooks Online",
    category: "accounting",
    icon: "book-open",
    website: "https://quickbooks.intuit.com",
    description: "Keep invoices, bills and the chart of accounts in step with your accountant's books.",
    capabilities: SYNC,
  },
  {
    id: "xero",
    displayName: "Xero",
    category: "accounting",
    icon: "book-open-check",
    website: "https://www.xero.com",
    description: "Two-way sync of invoices, bills and bank transactions with Xero.",
    capabilities: SYNC,
  },
  {
    id: "hubspot",
    displayName: "HubSpot",
    category: "crm",
    icon: "users",
    website: "https://www.hubspot.com",
    description: "Closed deals as expected revenue and customers as counterparties.",
    capabilities: SYNC_AND_WEBHOOK,
  },
  {
    id: "linear",
    displayName: "Linear",
    category: "projects",
    icon: "kanban",
    website: "https://linear.app",
    description: "Projects and teams as Expense Wise projects, for cost tracking per project.",
    capabilities: SYNC,
  },
];

export type CatalogEntry = {
  provider: string;
  displayName: string;
  category: string;
  description: string;
  icon: string;
  website: string | null;
  /** False for "coming soon" entries. */
  available: boolean;
  /** False when the entry is not a connection (coming soon, or the file importer). */
  connectable: boolean;
  /** Where the UI should send the user instead of a connect form, if anywhere. */
  href: string | null;
  capabilities: ConnectorCapabilities;
  requiresAccount: boolean;
  /** Without a chosen account, connecting creates a suitable one. */
  createsAccount: boolean;
  defaultSyncFrequency: "manual" | "hourly" | "daily" | null;
  credentialFields: FieldSpec[];
  configFields: FieldSpec[];
  webhook: { signatureHeader: string; scheme: string; events: string[] } | null;
};

const FILE_IMPORT: CatalogEntry = {
  provider: "file_import",
  displayName: "CSV & Excel statements",
  category: "banking",
  description: "Import bank, card and bKash statements from CSV or Excel. Columns are detected for you and duplicates are flagged before anything is saved.",
  icon: "file-spreadsheet",
  website: null,
  available: true,
  connectable: false,
  href: "/integrations/import",
  capabilities: { ...NONE, import: true },
  requiresAccount: true,
  createsAccount: false,
  defaultSyncFrequency: null,
  credentialFields: [],
  configFields: [],
  webhook: null,
};

/** Every provider Expense Wise knows. No provider-specific logic lives outside the connectors. */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, AnyConnector>();

  constructor() {
    for (const connector of [demoBankConnector, demoPaymentsConnector, stripeConnector, genericRestConnector, genericWebhookConnector]) {
      this.register(connector);
    }
  }

  register(connector: AnyConnector) {
    this.connectors.set(connector.id, connector);
  }

  get(provider: string): AnyConnector | null {
    return this.connectors.get(provider) ?? null;
  }

  require(provider: string): AnyConnector {
    const connector = this.get(provider);
    if (connector) return connector;
    if (COMING_SOON.some((entry) => entry.id === provider)) throw badRequest(`${provider} is coming soon and cannot be connected yet`, "provider_unavailable");
    throw badRequest(`Unknown integration provider "${provider}"`, "unknown_provider");
  }

  list(): AnyConnector[] {
    return [...this.connectors.values()];
  }

  syncProviders(): string[] {
    return this.list()
      .filter((connector) => connector.capabilities.sync && connector.fetch)
      .map((connector) => connector.id);
  }

  catalog(): CatalogEntry[] {
    const live: CatalogEntry[] = this.list().map((connector) => ({
      provider: connector.id,
      displayName: connector.displayName,
      category: connector.category,
      description: connector.description,
      icon: connector.icon,
      website: connector.website ?? null,
      available: true,
      connectable: true,
      href: null,
      capabilities: connector.capabilities,
      requiresAccount: connector.requiresAccount,
      createsAccount: connector.requiresAccount && Boolean(connector.suggestAccount),
      defaultSyncFrequency: connector.defaultSyncFrequency,
      credentialFields: connector.credentialFields,
      configFields: connector.configFields,
      webhook: connector.capabilities.webhook ? (connector.webhookDocs ?? null) : null,
    }));
    const planned: CatalogEntry[] = COMING_SOON.map((entry) => ({
      provider: entry.id,
      displayName: entry.displayName,
      category: entry.category,
      description: entry.description,
      icon: entry.icon,
      website: entry.website ?? null,
      available: false,
      connectable: false,
      href: null,
      capabilities: entry.capabilities,
      requiresAccount: false,
      createsAccount: false,
      defaultSyncFrequency: null,
      credentialFields: [],
      configFields: [],
      webhook: null,
    }));
    return [...live, FILE_IMPORT, ...planned];
  }
}
