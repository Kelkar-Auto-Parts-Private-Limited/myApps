// Supabase Edge Function — send-email
// Sends transactional / bulk emails via Gmail SMTP using a Workspace
// App Password stored in Edge Function secrets.
//
// Setup:
//   1. Enable 2FA on noreply@kelkarauto.com.
//   2. Google Account → Security → App passwords → generate "KAP myApps".
//   3. supabase secrets set GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
//   4. supabase secrets set GMAIL_FROM_NAME="KAP myApps"
//      supabase secrets set GMAIL_FROM_ADDR="noreply@kelkarauto.com"
//
// Call from the browser:
//   await _sb.functions.invoke('send-email', { body: {
//     to: 'employee@kelkarauto.com',
//     subject: 'Salary Slip — May 2026',
//     html: '<p>Find your slip attached.</p>',
//     attachments: [{ filename: 'EMP001-May2026.pdf', content: '<base64>', contentType: 'application/pdf' }]
//   }});

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AttachmentIn {
  filename: string;
  content: string;          // base64-encoded file content
  contentType?: string;     // e.g. "application/pdf"
}

interface EmailPayload {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;            // optional plain-text alternative
  attachments?: AttachmentIn[];
  replyTo?: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload: EmailPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Minimal validation — keep Gmail from rejecting malformed envelopes.
  if (!payload.to || !payload.subject || !payload.html) {
    return new Response(JSON.stringify({ error: "to, subject, html are required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const fromAddr = Deno.env.get("GMAIL_FROM_ADDR") ?? "noreply@kelkarauto.com";
  const fromName = Deno.env.get("GMAIL_FROM_NAME") ?? "KAP myApps";
  const appPass  = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!appPass) {
    return new Response(JSON.stringify({ error: "GMAIL_APP_PASSWORD secret not set" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: fromAddr, password: appPass },
    },
  });

  const toList  = Array.isArray(payload.to)  ? payload.to  : [payload.to];
  const ccList  = payload.cc  ? (Array.isArray(payload.cc)  ? payload.cc  : [payload.cc])  : undefined;
  const bccList = payload.bcc ? (Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc]) : undefined;

  const attachments = (payload.attachments ?? []).map((a) => ({
    filename: a.filename,
    content: base64ToBytes(a.content),
    contentType: a.contentType ?? "application/octet-stream",
    encoding: "binary" as const,
  }));

  try {
    await client.send({
      from: `${fromName} <${fromAddr}>`,
      to: toList,
      cc: ccList,
      bcc: bccList,
      replyTo: payload.replyTo,
      subject: payload.subject,
      content: payload.text ?? "This message contains HTML — please use an HTML-capable email client.",
      html: payload.html,
      attachments,
    });
    await client.close();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    try { await client.close(); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    console.error("send-email error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
