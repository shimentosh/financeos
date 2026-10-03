import { Injectable, Logger } from "@nestjs/common";
import { env } from "../../env.js";

/** One email, described rather than hand-written: the template turns it into HTML and plain text. */
export type EmailMessage = {
  to: string | string[];
  subject: string;
  /** Short text shown in the inbox list before opening. */
  preview?: string;
  heading: string;
  paragraphs: string[];
  /** The one thing to do, as a button (and a plain link below it). */
  action?: { label: string; url: string };
  /** Small print under the button: why they got it, when a link expires. */
  footnote?: string;
  replyTo?: string;
  /** Rows of label/value, e.g. a receipt. */
  details?: Array<{ label: string; value: string }>;
};

export type EmailResult = { delivered: boolean; id?: string; error?: string };

const logger = new Logger("Email");

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An absolute link: relative paths are resolved against APP_URL. */
export const appLink = (path: string) => (/^https?:\/\//.test(path) ? path : `${env.APP_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`);

export function renderEmail(message: EmailMessage): { html: string; text: string } {
  const paragraphs = message.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#27272a">${escapeHtml(p)}</p>`).join("");
  const details = message.details?.length
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 18px">${message.details
        .map(
          (row) =>
            `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f1;font-size:14px;color:#71717a">${escapeHtml(row.label)}</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f1;font-size:14px;color:#18181b;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(row.value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const action = message.action
    ? `<p style="margin:22px 0 10px"><a href="${escapeHtml(message.action.url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 20px;border-radius:10px">${escapeHtml(message.action.label)}</a></p>
       <p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#71717a">Or open this link: <a href="${escapeHtml(message.action.url)}" style="color:#52525b;word-break:break-all">${escapeHtml(message.action.url)}</a></p>`
    : "";
  const footnote = message.footnote ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#71717a">${escapeHtml(message.footnote)}</p>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(message.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
${message.preview ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.preview)}</div>` : ""}
<table role="presentation" width="100%" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:28px">
<tr><td>
<p style="margin:0 0 20px;font-size:14px;font-weight:700;color:#18181b;letter-spacing:-0.01em">FinanceOS</p>
<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#09090b">${escapeHtml(message.heading)}</h1>
${paragraphs}${details}${action}${footnote}
</td></tr></table>
<p style="margin:16px 0 0;font-size:11px;color:#a1a1aa">FinanceOS · <a href="${escapeHtml(env.APP_URL)}" style="color:#a1a1aa">${escapeHtml(env.APP_URL.replace(/^https?:\/\//, ""))}</a></p>
</td></tr></table></body></html>`;
  const text = [
    message.heading,
    "",
    ...message.paragraphs,
    ...(message.details?.length ? ["", ...message.details.map((row) => `${row.label}: ${row.value}`)] : []),
    ...(message.action ? ["", `${message.action.label}: ${message.action.url}`] : []),
    ...(message.footnote ? ["", message.footnote] : []),
    "",
    `FinanceOS · ${env.APP_URL}`,
  ].join("\n");
  return { html, text };
}

/**
 * Sends an email through Resend. Without RESEND_API_KEY the email is written
 * to the log instead — links included, so verification works in development.
 * Never throws: a failed email must not break the action that sent it.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const recipients = (Array.isArray(message.to) ? message.to : [message.to]).filter(Boolean);
  if (!recipients.length) return { delivered: false, error: "No recipient" };
  const { html, text } = renderEmail(message);
  if (!env.RESEND_API_KEY) {
    const log = `${message.subject} → ${recipients.join(", ")}${message.action ? `\n  ${message.action.label}: ${message.action.url}` : ""}`;
    if (env.NODE_ENV === "production") logger.warn(`RESEND_API_KEY is not set; email not sent: ${log}`);
    else logger.log(`(not sent, no RESEND_API_KEY) ${log}`);
    return { delivered: false, error: "Email is not configured" };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: recipients,
        subject: message.subject,
        html,
        text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) {
      logger.warn(`Email "${message.subject}" failed: ${response.status} ${body.message ?? ""}`);
      return { delivered: false, error: body.message ?? `HTTP ${response.status}` };
    }
    return { delivered: true, id: body.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Email "${message.subject}" failed: ${reason}`);
    return { delivered: false, error: reason };
  }
}

/** Injectable wrapper, for services. */
@Injectable()
export class EmailService {
  send(message: EmailMessage) {
    return sendEmail(message);
  }

  get configured() {
    return Boolean(env.RESEND_API_KEY);
  }
}
