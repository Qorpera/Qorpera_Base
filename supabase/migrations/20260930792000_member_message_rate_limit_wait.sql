do $$ begin
	if to_regclass('public.qorpera_member_rate_limit_settings') is not null then
		raise exception '20260930792000 is already applied'; end if;
	if to_regprocedure('public.qorpera_run_usage_pause_json(uuid)') is null
		or to_regprocedure('public.qorpera_release_paused_runs_with_room(uuid)') is null
		or to_regprocedure('public.qorpera_move_paused_run(uuid,uuid)') is null then
		raise exception '20260930792000 needs 20260930703000'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.rate_limit_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930792000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create table public.qorpera_member_rate_limit_settings (
	singleton boolean primary key default true check (singleton),
	rate_limit_waits integer not null default 5 check (rate_limit_waits between 0 and 10)
);
insert into public.qorpera_member_rate_limit_settings (singleton) values (true);
alter table public.qorpera_member_rate_limit_settings enable row level security;
revoke all on public.qorpera_member_rate_limit_settings from public, anon, authenticated, service_role;

create function public.qorpera_run_had_effect(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = p_run_id and receipt.status <> 'cancelled')
		or exists (select 1 from public.qorpera_agent_sends as delivery where delivery.run_id = p_run_id)
		or exists (select 1 from public.qorpera_company_proposals as proposal
			where proposal.execution_kind = 'run' and proposal.execution_id = p_run_id and proposal.status = 'open')
$$;

create function public.qorpera_rate_limit_wait_until(p_job_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_signal public.qorpera_provider_connection_usage_signals%rowtype;
	v_waits integer;
begin
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	if not found or v_job.run_id is null or v_job.client_lease_id is null then return null; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not found or v_run.source_kind not in ('session_turn', 'room_delivery') then return null; end if;
	select signal.* into v_signal from public.qorpera_provider_connection_usage_signals as signal
	where signal.run_id = v_run.id and signal.sponsor_version = v_run.sponsor_version
		and signal.signal_kind = 'rate_limited' and signal.assignment_id = v_job.client_lease_id;
	if not found or public.qorpera_run_had_effect(v_run.id) then return null; end if;
	select count(*)::integer into v_waits from public.qorpera_execution_run_events as paused
	where paused.run_id = v_run.id and paused.event_type = 'run_paused' and paused.payload ->> 'pausedFor' = 'rate_limited';
	if v_waits >= (select settings.rate_limit_waits from public.qorpera_member_rate_limit_settings as settings) then
		return null; end if;
	return greatest(
		statement_timestamp() + (array[1, 2, 4, 8, 15])[least(v_waits + 1, 5)] * interval '1 minute'
			* (0.8 + 0.4 * random()),
		case when v_signal.resets_at > statement_timestamp()
			then least(v_signal.resets_at, statement_timestamp() + interval '6 hours') end);
end $$;

create function public.qorpera_run_rate_limited(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_provider_connection_usage_signals as signal on signal.run_id = run.id
				and signal.sponsor_version = run.sponsor_version and signal.signal_kind = 'rate_limited'
			where run.id = p_run_id
				and not exists (select 1 from public.qorpera_execution_run_events as resumed
					where resumed.run_id = run.id and resumed.event_type in ('run_paused', 'run_cut_off')
						and resumed.payload ->> 'assignmentId' = signal.assignment_id::text))
		and not exists (select 1 from public.qorpera_execution_runs as run
			join public.qorpera_provider_connection_usage_signals as signal on signal.run_id = run.id
				and signal.sponsor_version = run.sponsor_version and signal.signal_kind = 'usage_limit'
			where run.id = p_run_id)
$$;

create function public.qorpera_run_rate_limit_pause(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select last_event.event_type = 'run_paused' and last_event.payload ->> 'pausedFor' = 'rate_limited'
		from public.qorpera_execution_run_events as last_event
		where last_event.run_id = p_run_id and last_event.event_type in ('run_cut_off', 'run_paused', 'sponsor_handoff')
		order by last_event.id desc limit 1), false)
$$;

revoke all on function public.qorpera_run_had_effect(uuid), public.qorpera_rate_limit_wait_until(uuid),
	public.qorpera_run_rate_limited(uuid), public.qorpera_run_rate_limit_pause(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.rate_limit_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)',
	E'\tv_until timestamptz;\nbegin\n',
	E'\tv_until timestamptz;\n\tv_rate_limit_until timestamptz;\n\tv_paused_for text;\nbegin\n');
select pg_temp.rate_limit_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)',
	E'\tselect signal.* into v_signal from public.qorpera_provider_connection_usage_signals as signal\n',
	E'\tv_rate_limit_until := public.qorpera_rate_limit_wait_until(v_job.id);\n'
	|| E'\tselect signal.* into v_signal from public.qorpera_provider_connection_usage_signals as signal\n');
select pg_temp.rate_limit_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)',
	E'\telsif p_cut_off and v_job.attempt_count < 8 then\n',
	E'\telsif v_rate_limit_until is not null then\n\t\tv_kind := \'paused\';\n\t\tv_paused_for := \'rate_limited\';\n'
	|| E'\t\tv_until := v_rate_limit_until;\n\telsif p_cut_off and v_job.attempt_count < 8 then\n');
select pg_temp.rate_limit_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)',
	$old$'providerConnectionVersion', v_sponsor.provider_connection_version, 'resetsAt', v_until)));$old$,
	$new$'providerConnectionVersion', v_sponsor.provider_connection_version, 'resetsAt', v_until,
		'pausedFor', v_paused_for)));$new$);

select pg_temp.rate_limit_replace('public.qorpera_get_execution_run_recovery(uuid)',
	E'\t\t-- Whether a member\'s ChatGPT plan pays for this run (20260929993000)',
	E'\t\t\'rate_limited\', public.qorpera_run_rate_limited(v_run.id),\n'
	|| E'\t\t-- Whether a member\'s ChatGPT plan pays for this run (20260929993000)');

select pg_temp.rate_limit_replace('public.qorpera_run_usage_pause_json(uuid)',
	$old$select coalesce((select jsonb_build_object('paused_until', pause.until,$old$,
	$new$select coalesce((select jsonb_build_object('paused_until', pause.until,
			'paused_for', case when public.qorpera_run_rate_limit_pause(run.id) then 'rate_limited' else 'usage_limit' end,$new$);
select pg_temp.rate_limit_replace('public.qorpera_run_usage_pause_json(uuid)',
	$old$'movable', sponsor.sponsor_kind = 'member_connection' and not plan.paid$old$,
	$new$'movable', not public.qorpera_run_rate_limit_pause(run.id) and sponsor.sponsor_kind = 'member_connection'
				and not plan.paid$new$);

select pg_temp.rate_limit_replace('public.qorpera_move_paused_run(uuid,uuid)',
	E'\tif public.qorpera_run_usage_pause(v_run.id) is null then\n',
	E'\tif public.qorpera_run_usage_pause(v_run.id) is null or public.qorpera_run_rate_limit_pause(v_run.id) then\n');

select pg_temp.rate_limit_replace('public.qorpera_release_paused_runs_with_room(uuid)',
	E'\t\t\tand (last_event.payload ->> \'resetsAt\')::timestamptz = job.dispatch_deferred_until\n',
	E'\t\t\tand (last_event.payload ->> \'resetsAt\')::timestamptz = job.dispatch_deferred_until\n'
	|| E'\t\t\tand last_event.payload ->> \'pausedFor\' is null\n');

drop function pg_temp.rate_limit_replace(regprocedure, text, text);
