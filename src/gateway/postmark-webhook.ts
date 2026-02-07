import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

interface PostmarkInboundEmail {
  MessageID: string;
  From: string;
  FromFull: {
    Email: string;
    Name: string;
  };
  To: string;
  ToFull: Array<{ Email: string; Name: string }>;
  Cc?: string;
  CcFull?: Array<{ Email: string; Name: string }>;
  ReplyTo?: string;
  Subject: string;
  Date: string;
  TextBody: string;
  HtmlBody: string;
  StrippedTextReply?: string;
  Tag?: string;
  Headers: Array<{ Name: string; Value: string }>;
  Attachments: Array<{
    Name: string;
    Content: string;
    ContentType: string;
    ContentLength: number;
  }>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function createPostmarkWebhookHandler(opts: {
  log: SubsystemLogger;
  getConfig: () => OpenClawConfig | null;
  sendToTelegram?: (message: string, chatId?: string) => Promise<void>;
}) {
  const { log, getConfig } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    log.info(`Postmark handler called: ${req.method} ${url.pathname}`);

    // Match /webhooks/postmark
    if (url.pathname !== "/webhooks/postmark") {
      return false;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }

    try {
      const body = await readJsonBody(req);
      const email = body as PostmarkInboundEmail;

      log.info(`📧 Postmark email received: ${email.Subject} from ${email.From}`);

      // Format email for display
      const textBody = email.StrippedTextReply || email.TextBody || "";
      const message = [
        `📧 **New Email**`,
        ``,
        `**From:** ${email.FromFull?.Name || email.From}`,
        `**Subject:** ${email.Subject}`,
        ``,
        textBody.substring(0, 1000) + (textBody.length > 1000 ? "..." : ""),
      ].join("\n");

      // Log to file for debugging
      log.info(`Email content (${textBody.length} chars)`);

      sendJson(res, 200, { ok: true, messageId: email.MessageID });
      return true;
    } catch (err) {
      log.error(`Postmark webhook error: ${String(err)}`);
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
  };
}
