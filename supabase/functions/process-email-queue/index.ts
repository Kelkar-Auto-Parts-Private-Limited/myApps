// Supabase Edge Function — process-email-queue
// Drains email_queue by calling send-email per row. Wire this up to
// Supabase Cron (recommended: every 1 minute) so the queue gets flushed
// continuously. Gmail SMTP is throttled — we send at most BATCH_SIZE per
// tick with INTER_SEND_MS delay between sends.
//
// Setup:
//   1. Deploy: supabase functions deploy process-email-queue --no-verify-jwt
//   2. Schedule with Supabase Cron:
//        select cron.schedule(
//          'process-email-queue',
//          '* * * * *',
//          $$ select net.http_post(
//               url := 'https://<project-ref>.supabase.co/functions/v1/process-email-queue',
//               headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
//             ) $$
//        );
//   3. Or call manually for testing:
//        curl -X POST <fn-url> -H "Authorization: Bearer <service-role-key>"

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH_SIZE     = 10;     // rows per tick — keep well under Gmail bursts
const INTER_SEND_MS  = 800;    // delay between sends in same tick

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface QueueRow {
  id: string;
  to_email: string;
  cc_email: string | null;
  bcc_email: string | null;
  reply_to: string | null;
  subject: string;
  body_html: string;
  body_text: string | null;
  attachments: Array<{ filename: string; content: string; contentType?: string }>;
}

async function callSendEmail(row: QueueRow): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({
      to: row.to_email,
      cc: row.cc_email || undefined,
      bcc: row.bcc_email || undefined,
      replyTo: row.reply_to || undefined,
      subject: row.subject,
      html: row.body_html,
      text: row.body_text || undefined,
      attachments: row.attachments || [],
    }),
  });
  if (res.ok) return { ok: true };
  const body = await res.text().catch(() => "");
  return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 500)}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serve(async (_req: Request): Promise<Response> => {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Atomically claim a batch — the RPC flips status to 'sending' and
  // returns the claimed rows so concurrent ticks can't double-send.
  const { data: claimed, error: claimErr } = await sb.rpc("email_queue_claim_batch", {
    p_limit: BATCH_SIZE,
  });
  if (claimErr) {
    console.error("claim error:", claimErr);
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), { status: 500 });
  }

  const rows = (claimed ?? []) as QueueRow[];
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: true, drained: 0 }), { status: 200 });
  }

  let sent = 0, failed = 0;
  for (const row of rows) {
    const result = await callSendEmail(row);
    const { error: markErr } = await sb.rpc("email_queue_mark", {
      p_id: row.id,
      p_ok: result.ok,
      p_error: result.error ?? null,
    });
    if (markErr) console.error("mark error:", markErr);
    if (result.ok) sent++; else failed++;
    if (rows.indexOf(row) < rows.length - 1) await sleep(INTER_SEND_MS);
  }

  return new Response(JSON.stringify({ ok: true, sent, failed, drained: rows.length }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
