"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-errors";

// Replaces the root layout when it fails, so it brings its own document and
// styles: globals.css and the theme script are not loaded here.
const styles = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #fafafa; color: #0a0a0a; }
  main { max-width: 28rem; margin: 0 auto; padding: 5rem 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.75rem; text-align: center; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0; }
  p { font-size: 0.875rem; color: #525252; margin: 0; }
  button { margin-top: 0.25rem; font: inherit; font-size: 0.875rem; padding: 0.4rem 0.9rem; border-radius: 0.5rem; border: 1px solid #0a0a0a; background: #0a0a0a; color: #fafafa; cursor: pointer; }
  small { font-size: 11px; color: #737373; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #fafafa; }
    p { color: #a3a3a3; }
    button { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
  }
`;

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError(error, "global");
  }, [error]);

  return (
    <html lang="en">
      <body>
        <title>Something went wrong · FinanceOS</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static styles for the fallback document */}
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <main>
          <h1>FinanceOS could not load</h1>
          <p>Something went wrong on our side. Your records are safe, and the error has been reported.</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
          {error.digest && <small>Reference {error.digest}</small>}
        </main>
      </body>
    </html>
  );
}
