do $$ begin
	if to_regclass('public.qorpera_provider_account_cooldowns') is not null then
		raise exception '20260930792000 is already applied'; end if;
	if to_regprocedure('public.qorpera_run_usage_pause_json(uuid)') is null
		or to_regprocedure('public.qorpera_release_paused_runs_with_room(uuid)') is null
		or to_regprocedure('public.qorpera_move_paused_run(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)') is null then
		raise exception '20260930792000 needs 20260930703000 and 20260930570000'; end if;
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

create table public.qorpera_provider_account_turn_settings (
	singleton boolean primary key default true check (singleton),
	max_concurrent_turns integer not null default 6 check (max_concurrent_turns between 1 and 64),
	rate_limit_waits integer not null default 5 check (rate_limit_waits between 0 and 10)
);
insert into public.qorpera_provider_account_turn_settings (singleton) values (true);
alter table public.qorpera_provider_account_turn_settings enable row level security;
revoke all on public.qorpera_provider_account_turn_settings from public, anon, authenticated, service_role;

create table public.qorpera_provider_account_cooldowns (
	account_key text primary key check (char_length(account_key) between 1 and 300),
	cool_until timestamptz not null,
	strikes integer not null check (strikes between 1 and 5),
	last_signal_at timestamptz not null,
	updated_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_provider_account_cooldowns enable row level security;
revoke all on public.qorpera_provider_account_cooldowns from public, anon, authenticated, service_role;

create index qorpera_runner_jobs_leased_runs on public.qorpera_runner_jobs (run_id) where status = 'leased';

create function public.qorpera_provider_account_key(p_connection_id uuid, p_connection_version bigint)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select connection.provider || ':identity:' || metadata.provider_account_identity || ':'
				|| coalesce('member:' || connection.owner_user_id::text, 'company:' || connection.profile_id::text)
			from public.qorpera_provider_connections as connection
			join public.qorpera_native_provider_account_metadata as metadata on metadata.connection_id = connection.id
				and metadata.connection_version = p_connection_version and metadata.provider_account_identity is not null
			where connection.id = p_connection_id),
		(select 'login:' || link.login_id::text
			from public.qorpera_provider_connection_versions as version
			join public.qorpera_model_login_links as link on link.credential_capsule_id = version.credential_capsule_id
			where version.connection_id = p_connection_id and version.version = p_connection_version
			order by link.login_id limit 1),
		'connection:' || p_connection_id::text)
$$;

create function public.qorpera_run_provider_account_key(p_run_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select public.qorpera_provider_account_key(sponsor.provider_connection_id, sponsor.provider_connection_version)
	from public.qorpera_execution_runs as run
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
		and sponsor.version = run.sponsor_version
	where run.id = p_run_id
$$;

create function public.qorpera_provider_account_cooling_until(p_account_key text)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select cooldown.cool_until from public.qorpera_provider_account_cooldowns as cooldown
	where cooldown.account_key = p_account_key and cooldown.cool_until > statement_timestamp()
$$;

create function public.qorpera_provider_account_rate_limited(p_account_key text, p_resets_at timestamptz)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
	v_cooldown public.qorpera_provider_account_cooldowns%rowtype;
	v_strikes integer;
	v_until timestamptz;
	v_reset timestamptz := case when p_resets_at > statement_timestamp()
		then least(p_resets_at, statement_timestamp() + interval '6 hours') end;
begin
	select cooldown.* into v_cooldown from public.qorpera_provider_account_cooldowns as cooldown
	where cooldown.account_key = p_account_key for update;
	if found and v_cooldown.cool_until > statement_timestamp() then
		if v_reset > v_cooldown.cool_until then
			update public.qorpera_provider_account_cooldowns set cool_until = v_reset, updated_at = clock_timestamp()
			where account_key = p_account_key;
			return v_reset;
		end if;
		return v_cooldown.cool_until;
	end if;
	v_strikes := case when found and v_cooldown.last_signal_at > statement_timestamp() - interval '30 minutes'
		then least(v_cooldown.strikes + 1, 5) else 1 end;
	v_until := greatest(statement_timestamp() + (array[1, 2, 4, 8, 15])[v_strikes] * interval '1 minute', v_reset);
	insert into public.qorpera_provider_account_cooldowns as cooldown(account_key, cool_until, strikes, last_signal_at)
	values (p_account_key, v_until, v_strikes, statement_timestamp())
	on conflict (account_key) do update set cool_until = greatest(cooldown.cool_until, excluded.cool_until),
		strikes = excluded.strikes, last_signal_at = excluded.last_signal_at, updated_at = clock_timestamp();
	return v_until;
end $$;

create function public.qorpera_provider_account_busy_turns(p_account_key text, p_except_run_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
	select count(*)::integer
	from (select job.run_id from public.qorpera_runner_jobs as job where job.status = 'leased' and job.run_id is not null
		union
		select claim.run_id from public.qorpera_runner_job_claims as claim where claim.status in ('claimed', 'assigned')) as busy
	join public.qorpera_execution_runs as run on run.id = busy.run_id
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
		and sponsor.version = run.sponsor_version
	where busy.run_id is distinct from p_except_run_id
		and public.qorpera_provider_account_key(sponsor.provider_connection_id, sponsor.provider_connection_version)
			= p_account_key
$$;

create function public.qorpera_run_borrows_parent_turn(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences as wake
		join public.qorpera_runner_jobs as parent on parent.run_id = wake.parent_run_id and parent.status = 'leased'
		where wake.run_id = p_run_id and wake.source_kind = 'worker-dispatch')
$$;

create function public.qorpera_provider_account_turn_admits(p_run public.qorpera_execution_runs,
	p_exact boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_key text := public.qorpera_run_provider_account_key(p_run.id);
begin
	if v_key is null then return true; end if;
	if public.qorpera_provider_account_cooling_until(v_key) is not null then return false; end if;
	if public.qorpera_run_borrows_parent_turn(p_run.id) then return true; end if;
	if p_exact then
		perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.provider-account-turns:' || v_key, 0));
	end if;
	return public.qorpera_provider_account_busy_turns(v_key, p_run.id)
		< (select settings.max_concurrent_turns from public.qorpera_provider_account_turn_settings as settings);
end $$;

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
	if not found then return null; end if;
	select signal.* into v_signal from public.qorpera_provider_connection_usage_signals as signal
	where signal.run_id = v_run.id and signal.sponsor_version = v_run.sponsor_version
		and signal.signal_kind = 'rate_limited' and signal.assignment_id = v_job.client_lease_id;
	if not found or public.qorpera_run_had_effect(v_run.id) then return null; end if;
	select count(*)::integer into v_waits from public.qorpera_execution_run_events as paused
	where paused.run_id = v_run.id and paused.event_type = 'run_paused' and paused.payload ->> 'pausedFor' = 'rate_limited';
	if v_waits >= (select settings.rate_limit_waits from public.qorpera_provider_account_turn_settings as settings) then
		return null; end if;
	return greatest(
		statement_timestamp() + (array[1, 2, 4, 8, 15])[least(v_waits + 1, 5)] * interval '1 minute'
			* (0.8 + 0.4 * random()),
		public.qorpera_provider_account_cooling_until(
			public.qorpera_provider_account_key(v_signal.provider_connection_id, v_signal.provider_connection_version)),
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

create function public.qorpera_routine_turned_away_runs(p_routine_id uuid, p_version bigint)
returns integer language sql stable security definer set search_path = '' as $$
	select count(*)::integer from public.qorpera_wake_occurrences as wake
	where wake.routine_id = p_routine_id and wake.routine_version = p_version and wake.run_id is not null
		and wake.status in ('failed', 'requires_review')
		and wake.blocked_reason is distinct from 'Brought forward: open todos of the agent changed and are still open'
		and public.qorpera_run_rate_limited(wake.run_id)
$$;

revoke all on function public.qorpera_provider_account_key(uuid, bigint), public.qorpera_run_provider_account_key(uuid),
	public.qorpera_provider_account_cooling_until(text), public.qorpera_provider_account_rate_limited(text, timestamptz),
	public.qorpera_provider_account_busy_turns(text, uuid), public.qorpera_run_borrows_parent_turn(uuid),
	public.qorpera_provider_account_turn_admits(public.qorpera_execution_runs, boolean),
	public.qorpera_run_had_effect(uuid), public.qorpera_rate_limit_wait_until(uuid), public.qorpera_run_rate_limited(uuid),
	public.qorpera_run_rate_limit_pause(uuid), public.qorpera_routine_turned_away_runs(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.rate_limit_replace('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
$old$			and assignment_id = v_lease.assignment_id;
	end if;
$old$,
$new$			and assignment_id = v_lease.assignment_id;
	end if;
	if p_signal_kind = 'rate_limited' and not v_replayed then
		perform public.qorpera_provider_account_rate_limited(public.qorpera_provider_account_key(
			v_lease.provider_connection_id, v_lease.provider_connection_version), v_signal.resets_at);
	end if;
$new$);

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

select pg_temp.rate_limit_replace(
	'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)',
	E'\t\tand public.qorpera_execution_compute_available(run)\n',
	E'\t\tand public.qorpera_execution_compute_available(run)\n\t\tand public.qorpera_provider_account_turn_admits(run)\n');
select pg_temp.rate_limit_replace(
	'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)',
	E'\tselect run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;\n',
	E'\tselect run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;\n'
	|| E'\tif not public.qorpera_provider_account_turn_admits(v_run, true) then return \'null\'::jsonb; end if;\n');

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

select pg_temp.rate_limit_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)',
	E'\t-- 20260930570000: a run brought forward starts now, as the attempt of the run that gives way to it.\n',
	E'\tif v_ended > 0 and public.qorpera_routine_turned_away_runs(v_routine.id, v_routine.current_version) > 0 then\n'
	|| E'\t\tv_ended := greatest(v_ended - public.qorpera_routine_turned_away_runs(v_routine.id, v_routine.current_version), 0);\n'
	|| E'\t\tv_at := case when v_ended <= 3 then statement_timestamp()\n'
	|| E'\t\t\telse statement_timestamp() + least(interval \'15 minutes\' * power(2, least(v_ended - 4, 12)), interval \'1 day\') end;\n'
	|| E'\t\tif v_last.run_id is not null and public.qorpera_run_rate_limited(v_last.run_id) then\n'
	|| E'\t\t\tv_at := greatest(v_at, public.qorpera_provider_account_cooling_until(\n'
	|| E'\t\t\t\tpublic.qorpera_run_provider_account_key(v_last.run_id)));\n'
	|| E'\t\tend if;\n'
	|| E'\tend if;\n'
	|| E'\t-- 20260930570000: a run brought forward starts now, as the attempt of the run that gives way to it.\n');
select pg_temp.rate_limit_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)',
	E'\t\t\twhere routine_id = v_routine.id) >= v_routine.max_occurrences) then\n',
	E'\t\t\twhere routine_id = v_routine.id\n'
	|| E'\t\t\t\tand not (run_id is not null and public.qorpera_run_rate_limited(run_id))) >= v_routine.max_occurrences) then\n');

drop function pg_temp.rate_limit_replace(regprocedure, text, text);
