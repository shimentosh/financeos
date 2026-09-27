// The ported UI primitives label a few controls through i18n. Expense Wise is
// English-first, so this is a small lookup rather than a translation runtime.
const STRINGS: Record<string, string> = {
  "common:breadcrumb.label": "Breadcrumb",
  "common:breadcrumb.more": "More",
  "common:actions.remove": "Remove",
  "common:actions.close": "Close",
  "common:sidebar.title": "Navigation",
  "common:sidebar.mobileDescription": "Move between sections",
  "common:a11y.toggleSidebar": "Toggle sidebar",
};

export const i18n = {
  t: (key: string) => STRINGS[key] ?? key.split(".").pop() ?? key,
};
