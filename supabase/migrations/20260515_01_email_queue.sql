-- email_queue: durable spool for outbound emails (salary slips, OTPs,
-- notifications). The browser inserts a row, a worker (Edge Function
-- triggered by Supabase Cron) pulls pending rows, calls send-email, and
-- marks each row sent / failed with attempt tracking.
--
-- Why a queue instead of inline sends:
--   • Gmail throttles bursts — month-end salary-slip runs need pacing.
--   • Retries: transient SMTP errors are common; keep attempts < max_attempts.
--   • Audit trail: every send (success or failure) is durable, queryable.
--   • Detachment: client doesn't block waiting for SMTP.

create table if not exists public.email_queue (
  id              uuid primary key default gen_random_uuid(),
  -- Recipient + content
  to_email        text not null,
  cc_email        text,
  bcc_email       text,
  reply_to        text,
  subject         text not null,
  body_html       text not null,
  body_text       text,
  -- Attachments stored inline as JSONB: [{filename, content (base64), contentType}, ...]
  -- Keep PDFs ≤ 5 MB each; Postgres handles it but Gmail caps at ~25 MB total.
  attachments     jsonb not null default '[]'::jsonb,
  -- Tagging / filtering for the audit log + per-feature throttles.
  scope           text not null default 'general',
    -- 'salary_slip' | 'otp' | 'approval' | 'notification' | 'general'
  related_id      text,           -- e.g. empCode or hrmsAttSal rec id for traceability
  -- Lifecycle
  status          text not null default 'pending',
    -- 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,
  last_error      text,
  -- Scheduling
  not_before      timestamptz not null default now(),  -- delayed sends
  sent_at         timestamptz,
  -- Audit
  created_at      timestamptz not null default now(),
  created_by      text                                  -- user id or 'system'
);

-- Common access patterns:
--   worker:  WHERE status='pending' AND not_before<=now() ORDER BY created_at LIMIT N
--   audit:   WHERE scope='salary_slip' AND created_at >= ...
--   retry:   WHERE status='failed' AND attempts < max_attempts
create index if not exists email_queue_pending_idx
  on public.email_queue (status, not_before)
  where status in ('pending','sending');

create index if not exists email_queue_scope_created_idx
  on public.email_queue (scope, created_at desc);

create index if not exists email_queue_to_idx
  on public.email_queue (to_email);

-- Helper RPC: claim up to N pending rows atomically and flip them to
-- 'sending' so two concurrent workers don't double-send. Returns the
-- claimed rows for the worker to process.
create or replace function public.email_queue_claim_batch(p_limit int default 25)
returns setof public.email_queue
language sql
security definer
as $$
  update public.email_queue eq
     set status = 'sending', attempts = attempts + 1
   where eq.id in (
     select id from public.email_queue
      where status = 'pending'
        and not_before <= now()
      order by created_at
      limit p_limit
      for update skip locked
   )
   returning eq.*;
$$;

-- Helper RPC: mark a row sent or failed (failed rows revert to 'pending'
-- if attempts < max_attempts so the next batch retries them).
create or replace function public.email_queue_mark(
  p_id uuid,
  p_ok boolean,
  p_error text default null
) returns void
language plpgsql
security definer
as $$
begin
  if p_ok then
    update public.email_queue
       set status = 'sent', sent_at = now(), last_error = null
     where id = p_id;
  else
    update public.email_queue
       set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           last_error = p_error
     where id = p_id;
  end if;
end;
$$;

-- RLS: the queue holds personal email content + (potentially) salary PDFs,
-- so lock it down. Only Super Admin / HRMS Admin can read; only the
-- service role (Edge Function) can write status updates.
alter table public.email_queue enable row level security;

-- Read: Super Admin and HRMS Admin only.
drop policy if exists email_queue_select on public.email_queue;
create policy email_queue_select on public.email_queue
  for select to authenticated
  using (
    exists (
      select 1 from public.users u
       where u.id = auth.uid()::text
         and ( 'Super Admin' = any(coalesce(u.roles,       '{}'))
            or 'HRMS Admin'  = any(coalesce(u.hrms_roles,  '{}')) )
    )
  );

-- Insert: any authenticated user (the UI enqueues — sender identity is
-- captured in `created_by`). Trim what's allowed by checking length on the
-- attachments column at app level if you want stricter limits.
drop policy if exists email_queue_insert on public.email_queue;
create policy email_queue_insert on public.email_queue
  for insert to authenticated
  with check (true);

-- Update/Delete: blocked for everyone (service role bypasses RLS by
-- design, so the Edge Function still updates status via its service key).
drop policy if exists email_queue_update on public.email_queue;
create policy email_queue_update on public.email_queue
  for update to authenticated
  using (false) with check (false);

drop policy if exists email_queue_delete on public.email_queue;
create policy email_queue_delete on public.email_queue
  for delete to authenticated
  using (false);

grant select, insert on public.email_queue to authenticated;
grant execute on function public.email_queue_claim_batch(int) to service_role;
grant execute on function public.email_queue_mark(uuid, boolean, text) to service_role;

comment on table  public.email_queue              is 'Outbound email spool — workers drain to Gmail SMTP via the send-email Edge Function.';
comment on column public.email_queue.scope        is 'Feature tag: salary_slip | otp | approval | notification | general';
comment on column public.email_queue.attachments  is 'JSONB array: [{filename, content (base64), contentType}, ...]';
comment on column public.email_queue.not_before   is 'Earliest send time — supports delayed dispatch (e.g., schedule for 9 AM).';
