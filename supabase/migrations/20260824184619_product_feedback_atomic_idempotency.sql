-- Make concurrent retries with the same client-generated identifier atomic.
-- The conflict update is intentionally a no-op so the first report remains
-- authoritative while every retry receives its durable identifier.
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
  on conflict (user_id, client_feedback_id) do update
    set client_feedback_id = excluded.client_feedback_id
  returning id into feedback_id;

  return feedback_id;
end;
$$;

revoke all on function public.qorpera_submit_product_feedback(uuid, text, text, boolean, jsonb) from public, anon;
grant execute on function public.qorpera_submit_product_feedback(uuid, text, text, boolean, jsonb) to authenticated;
