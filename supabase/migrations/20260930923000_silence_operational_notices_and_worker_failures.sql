set local lock_timeout = '3s';

create temp table silence_notices_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure;

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_old constant text := $old$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind = 'surface-session')$old$;
	v_new constant text := $new$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind in ('surface-session', 'worker-dispatch', 'worker-completion', 'machine-event', 'machine-checkin', 'office-activation', 'surface-escalation', 'light-ask')) /* WHY: 20260930923000 keeps background wake failures out of chat activity unless recovery is needed */$new$;
	v_found integer;
	v_bad text;
begin
	if position('20260930923000' in v_definition) > 0 then
		raise exception '20260930923000 is already in qorpera_list_staff_execution_activity';
	end if;
	v_found := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
	if v_found <> 1 then
		raise exception '20260930923000 anchor found % time(s) in qorpera_list_staff_execution_activity', v_found;
	end if;
	execute replace(v_definition, v_old, v_new);

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join silence_notices_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930923000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop table silence_notices_before;

create or replace function public.qorpera_notify_runs_without_progress()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_closed integer;
begin
	update public.qorpera_member_notifications as notice
	set acknowledged_at = clock_timestamp()
	where notice.kind = 'run_no_progress'
		and notice.acknowledged_at is null;
	get diagnostics v_closed = row_count;
	return jsonb_build_object('schema', 'qorpera.run-progress-notices/v1', 'opened', 0, 'closed', v_closed);
end
$$;
revoke all on function public.qorpera_notify_runs_without_progress()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

update public.qorpera_member_notifications
set acknowledged_at = clock_timestamp()
where kind in ('run_no_progress', 'company_ceiling_tripped')
	and acknowledged_at is null;
