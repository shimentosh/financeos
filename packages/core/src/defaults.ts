import type { CategoryKind, WorkspaceKind } from "./constants.ts";

export type DefaultCategory = {
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  children?: Array<{ name: string; icon: string }>;
};

// Starter categories. Users rename, archive and add to them freely; the names
// here also anchor the keyword hints in the entry parser.

const PERSONAL_EXPENSE: DefaultCategory[] = [
  {
    name: "Food & Dining",
    kind: "expense",
    icon: "utensils",
    color: "orange",
    children: [
      { name: "Groceries", icon: "shopping-basket" },
      { name: "Restaurants", icon: "utensils-crossed" },
    ],
  },
  { name: "Transport", kind: "expense", icon: "car", color: "sky", children: [{ name: "Fuel", icon: "fuel" }] },
  { name: "Rent", kind: "expense", icon: "house", color: "violet" },
  {
    name: "Bills & Utilities",
    kind: "expense",
    icon: "receipt",
    color: "amber",
    children: [
      { name: "Electricity", icon: "zap" },
      { name: "Gas", icon: "flame" },
      { name: "Water", icon: "droplet" },
      { name: "Internet", icon: "wifi" },
      { name: "Mobile", icon: "smartphone" },
    ],
  },
  { name: "Shopping", kind: "expense", icon: "shopping-bag", color: "pink" },
  { name: "Health", kind: "expense", icon: "heart-pulse", color: "rose" },
  { name: "Education", kind: "expense", icon: "graduation-cap", color: "indigo" },
  { name: "Family support", kind: "expense", icon: "users", color: "teal" },
  { name: "Household", kind: "expense", icon: "sofa", color: "stone" },
  { name: "Entertainment", kind: "expense", icon: "clapperboard", color: "purple" },
  { name: "Travel", kind: "expense", icon: "plane", color: "cyan" },
  { name: "Subscriptions", kind: "expense", icon: "repeat", color: "blue" },
  { name: "AI & APIs", kind: "expense", icon: "sparkles", color: "violet" },
  { name: "Personal care", kind: "expense", icon: "scissors", color: "fuchsia" },
  { name: "Charity", kind: "expense", icon: "hand-heart", color: "emerald" },
  { name: "Fees & Charges", kind: "expense", icon: "percent", color: "zinc" },
  { name: "Taxes", kind: "expense", icon: "landmark", color: "slate" },
  { name: "Interest", kind: "expense", icon: "trending-up", color: "red" },
  { name: "Other expenses", kind: "expense", icon: "circle-dashed", color: "neutral" },
];

const PERSONAL_INCOME: DefaultCategory[] = [
  { name: "Salary", kind: "income", icon: "briefcase", color: "emerald" },
  { name: "Freelance", kind: "income", icon: "laptop", color: "teal" },
  { name: "Business income", kind: "income", icon: "building-2", color: "sky" },
  { name: "Investment income", kind: "income", icon: "trending-up", color: "green" },
  { name: "Rental income", kind: "income", icon: "key-round", color: "lime" },
  { name: "Gifts received", kind: "income", icon: "gift", color: "pink" },
  { name: "Other income", kind: "income", icon: "circle-dashed", color: "neutral" },
];

const BUSINESS_EXPENSE: DefaultCategory[] = [
  { name: "Payroll", kind: "expense", icon: "users", color: "violet" },
  { name: "Software", kind: "expense", icon: "app-window", color: "blue" },
  { name: "AI & APIs", kind: "expense", icon: "sparkles", color: "purple" },
  { name: "Hosting", kind: "expense", icon: "server", color: "sky" },
  { name: "Marketing", kind: "expense", icon: "megaphone", color: "pink" },
  { name: "Advertising", kind: "expense", icon: "badge-dollar-sign", color: "rose" },
  { name: "Development", kind: "expense", icon: "code", color: "indigo" },
  { name: "Contractors", kind: "expense", icon: "hard-hat", color: "orange" },
  { name: "Operations", kind: "expense", icon: "settings", color: "slate" },
  { name: "Office", kind: "expense", icon: "building", color: "stone" },
  { name: "Legal", kind: "expense", icon: "scale", color: "zinc" },
  { name: "Accounting", kind: "expense", icon: "calculator", color: "teal" },
  { name: "Equipment", kind: "expense", icon: "monitor", color: "cyan" },
  { name: "R&D", kind: "expense", icon: "flask-conical", color: "fuchsia" },
  { name: "Travel", kind: "expense", icon: "plane", color: "amber" },
  { name: "Payment processing fees", kind: "expense", icon: "credit-card", color: "red" },
  { name: "Taxes", kind: "expense", icon: "landmark", color: "neutral" },
  { name: "Other expenses", kind: "expense", icon: "circle-dashed", color: "neutral" },
];

const BUSINESS_INCOME: DefaultCategory[] = [
  { name: "Product sales", kind: "income", icon: "package", color: "emerald" },
  { name: "Subscription revenue", kind: "income", icon: "repeat", color: "teal" },
  { name: "Services", kind: "income", icon: "handshake", color: "sky" },
  { name: "Other revenue", kind: "income", icon: "circle-dashed", color: "neutral" },
];

export function defaultCategories(kind: WorkspaceKind): DefaultCategory[] {
  return kind === "business" ? [...BUSINESS_EXPENSE, ...BUSINESS_INCOME] : [...PERSONAL_EXPENSE, ...PERSONAL_INCOME];
}

/** Seed exchange rates (to BDT), labelled as such and meant to be replaced. */
export const SEED_RATES_TO_BDT: Record<string, string> = {
  USD: "122.0000000000",
  EUR: "133.0000000000",
  GBP: "155.0000000000",
  INR: "1.4200000000",
  AED: "33.2000000000",
  SAR: "32.5000000000",
  SGD: "90.5000000000",
  MYR: "27.0000000000",
  CAD: "88.0000000000",
  AUD: "79.0000000000",
};
