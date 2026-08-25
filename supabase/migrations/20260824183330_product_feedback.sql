-- Private product-feedback inbox. Authenticated users can submit through the
-- function below, but cannot enumerate their own or anyone else's reports.
create table public.qorpera_product_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_feedback_id uuid not null,
  category text not null check (category in ('bug', 'bad-result', 'good-result', 'feature-request', 'performance', 'other')),
  details text not null check (char_length(btrim(details)) between 1 and 10000),
  include_diagnostics boolean not null,
  diagnostics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(diagnostics) = 'object' and octet_length(diagnostics::text) <= 32768),
  status text not null default 'new' check (status in ('new', 'triaged', 'planned', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_feedback_id)
);
create index qorpera_product_feedback_status_created_idx
  on public.qorpera_product_feedback (status, created_at desc);
alter table public.qorpera_product_feedback enable row level security;
revoke all on table public.qorpera_product_feedback from anon, authenticated;
create or replace function public.qorpera_submit_product_feedback(
  p_client_feedback_id uuid,
  p_category text,
  p_details text,
  p_include_diagnostics boolean,
  p_diagnostics jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  feedback_id uuid;
begin
  if actor is null then
    raise exception 'Qorpera sign-in is required to submit feedback';
  end if;

  select feedback.id
    into feedback_id
    from public.qorpera_product_feedback as feedback
   where feedback.user_id = actor
     and feedback.client_feedback_id = p_client_feedback_id;
  if feedback_id is not null then
    return feedback_id;
  end if;

  if p_category not in ('bug', 'bad-result', 'good-result', 'feature-request', 'performance', 'other') then
    raise exception 'invalid feedback category';
  end if;
  if char_length(btrim(coalesce(p_details, ''))) not between 1 and 10000 then
    raise exception 'feedback details must contain between 1 and 10000 characters';
  end if;
  if jsonb_typeof(coalesce(p_diagnostics, '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_diagnostics, '{}'::jsonb)::text) > 32768 then
    raise exception 'feedback diagnostics must be a JSON object no larger than 32768 bytes';
  end if;
  if (
    select count(*)
      from public.qorpera_product_feedback as recent
     where recent.user_id = actor
       and recent.created_at >= now() - interval '1 hour'
  ) >= 20 then
    raise exception 'feedback submission limit reached; try again later';
  end if;

  insert into public.qorpera_product_feedback (
    user_id,
    client_feedback_id,
    category,
    details,
    include_diagnostics,
    diagnostics
  ) values (
    actor,
    p_client_feedback_id,
    p_category,
    btrim(p_details),
    p_include_diagnostics,
    case when p_include_diagnostics then coalesce(p_diagnostics, '{}'::jsonb) else '{}'::jsonb end
  )
  returning id into feedback_id;

  return feedback_id;
end;
$$;
revoke all on function public.qorpera_submit_product_feedback(uuid, text, text, boolean, jsonb) from public;
grant execute on function public.qorpera_submit_product_feedback(uuid, text, text, boolean, jsonb) to authenticated;
