do $$ begin
	if to_regprocedure('public.qorpera_note_model_login_pass_refused(uuid,timestamp with time zone)') is not null then
		raise exception '20260930808000 is already applied'; end if;
	if to_regprocedure('public.qorpera_rate_limit_wait_until(uuid)') is null
		or to_regprocedure('public.qorpera_take_idle_account_model_login_renewal(uuid,text)') is null then
		raise exception '20260930808000 needs 20260930801000 and 20260930548000'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.sr808_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930808000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_model_logins
	add column refused_version bigint check (refused_version between 1 and 9007199254740991),
	add column refused_at timestamptz,
	add constraint qorpera_model_logins_refused_pair check ((refused_version is null) = (refused_at is null));

do $$
declare v_constraint name;
begin
	select conname into strict v_constraint from pg_constraint
	where conrelid = 'public.qorpera_provider_connection_usage_signals'::regclass and contype = 'c'
		and pg_get_constraintdef(oid) like '%signal_kind%usage_limit%rate_limited%provider_outage%';
	execute format('alter table public.qorpera_provider_connection_usage_signals drop constraint %I', v_constraint);
end $$;
alter table public.qorpera_provider_connection_usage_signals
	add constraint qorpera_provider_connection_usage_signals_signal_kind_check
	check (signal_kind in ('usage_limit', 'rate_limited', 'provider_outage', 'sign_in_refused'));

create function public.qorpera_capsule_model_login(p_capsule_id uuid)
returns public.qorpera_model_logins
language sql stable security definer set search_path = '' as $$
	select login.* from public.qorpera_model_logins as login
	where login.credential_capsule_id = p_capsule_id
	union all
	select login.* from public.qorpera_model_login_links as link
	join public.qorpera_model_logins as login on login.id = link.login_id and login.owner_user_id = link.owner_user_id
	where link.credential_capsule_id = p_capsule_id
	limit 1
$$;

create function public.qorpera_connection_login_pass_refused(p_connection_id uuid, p_connection_version bigint)
returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce((select login.status = 'active' and login.refused_version is not distinct from login.current_version
			and login.refused_at > clock_timestamp() - interval '30 minutes'
		from public.qorpera_provider_connection_versions as version
		cross join lateral public.qorpera_capsule_model_login(version.credential_capsule_id) as login
		where version.connection_id = p_connection_id and version.version = p_connection_version), false)
$$;

create function public.qorpera_note_model_login_pass_refused(p_capsule_id uuid, p_since timestamptz)
returns void
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_login public.qorpera_model_logins%rowtype;
begin
	v_login := public.qorpera_capsule_model_login(p_capsule_id);
	if v_login.id is null then return; end if;
	update public.qorpera_model_logins as login
	set refused_version = login.current_version, refused_at = clock_timestamp(), updated_at = clock_timestamp()
	where login.id = v_login.id and login.status = 'active'
		and login.refused_version is distinct from login.current_version
		and exists (select 1 from public.qorpera_model_login_versions as version
			where version.login_id = login.id and version.version = login.current_version
				and version.created_at <= p_since);
exception when lock_not_available or deadlock_detected then
	return;
end $$;

create or replace function public.qorpera_model_login_renewal_due(
	p_login public.qorpera_model_logins,
	p_now timestamptz,
	p_idle boolean
)
returns boolean
language sql immutable set search_path = '' as $$
	select case when p_login.login_kind = 'chatgpt_plan' then
			(p_login.renew_not_before is null or p_now >= p_login.renew_not_before)
			and (p_login.refused_version is not distinct from p_login.current_version
				or case when p_idle then p_now >= p_login.access_issued_at + interval '7 days'
					else p_now >= p_login.access_issued_at + (p_login.access_expires_at - p_login.access_issued_at) / 2 end)
		else p_login.refused_version is not distinct from p_login.current_version
			or p_now >= p_login.access_issued_at + (p_login.access_expires_at - p_login.access_issued_at) / 2
	end
$$;

select pg_temp.sr808_replace('public.qorpera_take_idle_account_model_login_renewal(uuid,text)',
	'order by login.access_expires_at, login.id',
	'order by login.refused_version is not distinct from login.current_version desc, login.access_expires_at, login.id');
select pg_temp.sr808_replace('public.qorpera_take_idle_model_login_renewal(uuid,text)',
	'order by login.access_expires_at, login.id',
	'order by login.refused_version is not distinct from login.current_version desc, login.access_expires_at, login.id');

select pg_temp.sr808_replace('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
	$old$p_signal_kind not in ('usage_limit','rate_limited','provider_outage')$old$,
	$new$p_signal_kind not in ('usage_limit','rate_limited','provider_outage','sign_in_refused')$new$);
select pg_temp.sr808_replace('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
	E'\tif p_signal_kind = \'usage_limit\' then\n',
	E'\tif p_signal_kind = \'sign_in_refused\' then\n'
	|| E'\t\tperform public.qorpera_note_model_login_pass_refused(v_lease.credential_capsule_id, v_lease.created_at);\n'
	|| E'\tend if;\n\tif p_signal_kind = \'usage_limit\' then\n');

select pg_temp.sr808_replace('public.qorpera_sponsor_waits_for_usage_limit(uuid,bigint)',
	E'\t\t\tsponsor.provider_connection_version) = 0\n',
	E'\t\t\tsponsor.provider_connection_version) = 0\n'
	|| E'\t\t\tor public.qorpera_connection_login_pass_refused(sponsor.provider_connection_id,\n'
	|| E'\t\t\t\tsponsor.provider_connection_version)\n');

create function public.qorpera_rate_limit_wait_kind(p_job_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
	select signal.signal_kind
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.id = job.run_id
	join public.qorpera_provider_connection_usage_signals as signal on signal.run_id = run.id
		and signal.sponsor_version = run.sponsor_version and signal.assignment_id = job.client_lease_id
		and signal.signal_kind in ('rate_limited', 'sign_in_refused')
	where job.id = p_job_id
	order by signal.observed_at desc, signal.id
	limit 1
$$;

create or replace function public.qorpera_rate_limit_wait_until(p_job_id uuid)
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
		and signal.signal_kind in ('rate_limited', 'sign_in_refused') and signal.assignment_id = v_job.client_lease_id
	order by signal.observed_at desc, signal.id
	limit 1;
	if not found or public.qorpera_run_had_effect(v_run.id) then return null; end if;
	if v_signal.signal_kind = 'sign_in_refused' and (select login.status
			from public.qorpera_provider_connection_versions as version
			cross join lateral public.qorpera_capsule_model_login(version.credential_capsule_id) as login
			where version.connection_id = v_signal.provider_connection_id
				and version.version = v_signal.provider_connection_version) is distinct from 'active' then
		return null; end if;
	select count(*)::integer into v_waits from public.qorpera_execution_run_events as paused
	where paused.run_id = v_run.id and paused.event_type = 'run_paused'
		and paused.payload ->> 'pausedFor' in ('rate_limited', 'sign_in_refused');
	if v_waits >= coalesce((select settings.rate_limit_waits from public.qorpera_member_rate_limit_settings as settings), 0) then
		return null; end if;
	return greatest(
		statement_timestamp() + (array[1, 2, 4, 8, 15])[least(v_waits + 1, 5)] * interval '1 minute'
			* (0.8 + 0.4 * random()),
		case when v_signal.resets_at > statement_timestamp()
			then least(v_signal.resets_at, statement_timestamp() + interval '6 hours') end);
end $$;

select pg_temp.sr808_replace('public.qorpera_resume_run_from_log(uuid,text,boolean)',
	$old$v_paused_for := 'rate_limited';$old$,
	$new$v_paused_for := public.qorpera_rate_limit_wait_kind(v_job.id);$new$);

select pg_temp.sr808_replace('public.qorpera_run_rate_limit_pause(uuid)',
	$old$last_event.payload ->> 'pausedFor' = 'rate_limited'$old$,
	$new$last_event.payload ->> 'pausedFor' in ('rate_limited', 'sign_in_refused')$new$);

create function public.qorpera_run_wait_paused_for(p_run_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
	select last_event.payload ->> 'pausedFor'
	from public.qorpera_execution_run_events as last_event
	where last_event.run_id = p_run_id and last_event.event_type in ('run_cut_off', 'run_paused', 'sponsor_handoff')
	order by last_event.id desc
	limit 1
$$;

select pg_temp.sr808_replace('public.qorpera_run_usage_pause_json(uuid)',
	$old$case when public.qorpera_run_rate_limit_pause(run.id) then 'rate_limited' else 'usage_limit' end$old$,
	$new$case when public.qorpera_run_rate_limit_pause(run.id) then public.qorpera_run_wait_paused_for(run.id)
				else 'usage_limit' end$new$);

create function public.qorpera_run_sign_in_refused(p_run_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_execution_runs as run
		join public.qorpera_provider_connection_usage_signals as signal on signal.run_id = run.id
			and signal.sponsor_version = run.sponsor_version and signal.signal_kind = 'sign_in_refused'
		join public.qorpera_provider_connection_versions as version on version.connection_id = signal.provider_connection_id
			and version.version = signal.provider_connection_version
		cross join lateral public.qorpera_capsule_model_login(version.credential_capsule_id) as login
		where run.id = p_run_id and login.status = 'needs_sign_in')
$$;

select pg_temp.sr808_replace('public.qorpera_get_execution_run_recovery(uuid)',
	$old$'rate_limited', public.qorpera_run_rate_limited(v_run.id),$old$,
	$new$'rate_limited', public.qorpera_run_rate_limited(v_run.id),
		'sign_in_refused', public.qorpera_run_sign_in_refused(v_run.id),$new$);

select pg_temp.sr808_replace('public.qorpera_list_member_native_execution_connections(uuid)',
	$old$'allow_autonomous', version.allow_autonomous,$old$,
	$new$'login_status', (public.qorpera_capsule_model_login(version.credential_capsule_id)).status,
				'allow_autonomous', version.allow_autonomous,$new$);

revoke all on function public.qorpera_capsule_model_login(uuid),
	public.qorpera_connection_login_pass_refused(uuid, bigint),
	public.qorpera_note_model_login_pass_refused(uuid, timestamptz),
	public.qorpera_rate_limit_wait_kind(uuid),
	public.qorpera_run_wait_paused_for(uuid),
	public.qorpera_run_sign_in_refused(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_model_login_renewal_due(public.qorpera_model_logins, timestamptz, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

drop function pg_temp.sr808_replace(regprocedure, text, text);
