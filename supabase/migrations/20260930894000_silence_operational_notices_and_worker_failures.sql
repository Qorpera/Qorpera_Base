set local lock_timeout = '3s';

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_old constant text := $old$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind = 'surface-session')$old$;
	v_new constant text := $new$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind in ('surface-session', 'worker-dispatch', 'worker-completion', 'machine-event', 'machine-checkin', 'office-activation', 'surface-escalation', 'light-ask')) /* 20260930894000 */$new$;
	v_found integer;
begin
	if position('20260930894000' in v_definition) > 0 then
		raise exception '20260930894000 is already in qorpera_list_staff_execution_activity';
	end if;
	v_found := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
	if v_found <> 1 then
		raise exception '20260930894000 anchor found % time(s) in qorpera_list_staff_execution_activity', v_found;
	end if;
	execute replace(v_definition, v_old, v_new);
end $$;

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
