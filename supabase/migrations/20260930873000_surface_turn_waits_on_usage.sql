set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_surface_session_note(uuid,text,uuid[])') is null
		or to_regprocedure('public.qorpera_native_account_resets_at(uuid)') is null then
		raise exception '20260930873000 requires 20260930579000, 20260930862000 and 20260930866000';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_surface_sessions' and column_name = 'waiting_on_usage_user_id'
	) then
		raise exception '20260930873000 is already applied';
	end if;
end $$;

create function pg_temp.stw_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930873000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930873000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_sessions
	add column waiting_on_usage_user_id uuid references auth.users(id) on delete set null,
	add column waiting_on_usage_until timestamptz,
	add column waiting_on_usage_grace boolean not null default false;

create function public.qorpera_surface_usage_wait(p_binding_id uuid, p_version bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'userId', connection.owner_user_id,
		'resetsAt', public.qorpera_native_account_resets_at(connection.id)
	)
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	where sponsor.binding_id = p_binding_id and sponsor.version = p_version
		and public.qorpera_native_account_remaining(sponsor.provider_connection_id, sponsor.provider_connection_version) = 0
$$;

create function public.qorpera_surface_turn_usage_wait(p_worker_id uuid, p_wake_id uuid, p_requester uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select public.qorpera_surface_usage_wait(worker.owner_sponsor_binding_id,
				public.qorpera_live_sponsor_version(worker.owner_sponsor_binding_id, worker.owner_sponsor_version))
			from public.qorpera_runtime_workers as worker
			where worker.id = p_worker_id and worker.owner_sponsor_binding_id is not null
				and worker.owner_user_id = p_requester),
		(select public.qorpera_surface_usage_wait(wake.sponsor_binding_id, wake.sponsor_version)
			from public.qorpera_wake_occurrences as wake
			where wake.id = p_wake_id and wake.sponsor_binding_id is not null)
	)
$$;

create function public.qorpera_surface_hold_for_usage(p_session_id uuid, p_wait jsonb, p_requeue boolean)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp();
	v_reset timestamptz := (p_wait ->> 'resetsAt')::timestamptz;
	v_recheck timestamptz;
begin
	-- WHY: a reading with room ends a wall before its reset, so the turn looks again every 15 minutes.
	v_recheck := greatest(v_now + interval '1 minute',
		least(coalesce(v_reset, v_now + interval '15 minutes'), v_now + interval '15 minutes'));
	update public.qorpera_surface_sessions as s
	set
		state = case
			when not p_requeue then s.state
			when s.state = 'reconciling_running' then 'reconciling'
			when s.state = 'running' then 'queued'
			else s.state end,
		lease_token = case when p_requeue then null else s.lease_token end,
		wake_id = case when p_requeue then null else s.wake_id end,
		lease_expires_at = v_recheck,
		waiting_on_usage_user_id = coalesce((p_wait ->> 'userId')::uuid, public.qorpera_surface_turn_requester(s)),
		waiting_on_usage_until = v_reset,
		waiting_on_usage_grace = false,
		updated_at = v_now
	where s.id = p_session_id;
	return v_recheck;
end $$;

create function public.qorpera_surface_usage_grace(p_session_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp();
begin
	-- WHY: at the reset the paused run, the held wake or the coding claim needs a moment to take the turn up again;
	-- one grace lease, then the usual expiry.
	update public.qorpera_surface_sessions
	set lease_expires_at = v_now + interval '10 minutes', waiting_on_usage_grace = true, updated_at = v_now
	where id = p_session_id and waiting_on_usage_user_id is not null and not waiting_on_usage_grace;
	return found;
end $$;

create function public.qorpera_surface_coding_login_usable(
	p_profile_id uuid,
	p_owner_user_id uuid,
	p_connection_id uuid,
	p_connection_version bigint,
	p_allow_autonomous boolean,
	p_member_initiated boolean
)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_provider_connections as connection
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
			and version.version = p_connection_version and version.authorization_state = 'active'
		where connection.id = p_connection_id
			and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
			and (version.authentication_mode <> 'native_subscription' or exists (
				select 1 from public.qorpera_native_credential_capsules as capsule
				where capsule.id = version.credential_capsule_id and capsule.status = 'active'
			))
	) and (
		exists (
			select 1
			from public.qorpera_execution_sponsor_versions as sponsor
			join public.qorpera_execution_sponsor_bindings as binding on binding.id = sponsor.binding_id
			where binding.profile_id = p_profile_id and binding.status = 'active'
				and sponsor.sponsor_kind = 'member_connection'
				and sponsor.provider_connection_id = p_connection_id
				and sponsor.provider_connection_version = p_connection_version
				and sponsor.created_by_user_id = p_owner_user_id
				and (sponsor.allow_autonomous or p_member_initiated)
				and sponsor.version = (select max(later.version) from public.qorpera_execution_sponsor_versions as later
					where later.binding_id = binding.id)
		)
		or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings as binding
			cross join lateral (select encode(extensions.digest(convert_to(
				case when p_allow_autonomous then 'qorpera-coding-owner:' else 'qorpera-surface-coding-owner:' end
					|| p_connection_id::text || ':' || p_connection_version::text, 'utf8'), 'sha256'), 'hex') as hex) as seed
			where binding.profile_id = p_profile_id
				and binding.client_binding_id = (left(seed.hex, 8) || '-' || substr(seed.hex, 9, 4) || '-4' || substr(seed.hex, 14, 3)
					|| '-8' || substr(seed.hex, 18, 3) || '-' || substr(seed.hex, 21, 12))::uuid
				and (binding.created_by_user_id <> p_owner_user_id or binding.status <> 'active')
		)
	)
$$;

create function public.qorpera_surface_continue_login(p_session public.qorpera_surface_sessions, p_user_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
	v_environment_id uuid;
	v_harnesses text[];
	v_harness text;
	v_connection_id uuid;
	v_connection_version bigint;
	v_member_initiated boolean := public.qorpera_surface_turn_member_initiated(p_session);
begin
	if not exists (
		select 1 from public.qorpera_surfaces surf where surf.id = p_session.surface_id and surf.source_kind = 'code_repo'
	) then
		return (
			select eligible.connection_id
			from public.qorpera_eligible_member_accounts(p_session.profile_id, p_user_id) as eligible
			order by eligible.remaining desc, eligible.connection_id, eligible.binding_id
			limit 1
		);
	end if;
	select c.environment_id into v_environment_id
	from public.qorpera_company_cofounders c where c.profile_id = p_session.profile_id limit 1;
	select coalesce(array_agg(distinct h), '{}'::text[]) into v_harnesses
	from public.qorpera_coding_executors e, unnest(e.harnesses) as h
	where e.enabled and (e.environment_id = v_environment_id or not exists (
		select 1 from public.qorpera_coding_executors other where other.environment_id = v_environment_id));
	foreach v_harness in array case
		when p_session.worker_id is not null then array[(
			select cs.harness from public.qorpera_coding_sessions cs where cs.worker_id = p_session.worker_id)]
		else array['codex', 'claude-code'] end
	loop
		continue when v_harness is null or not (v_harness = any(v_harnesses));
		select login.connection_id, login.connection_version into v_connection_id, v_connection_version
		from public.qorpera_coding_owner_login(p_session.profile_id, p_user_id, v_harness) as login
		where (v_member_initiated or coalesce(login.allow_autonomous, false))
			and public.qorpera_surface_coding_login_usable(p_session.profile_id, p_user_id, login.connection_id,
				login.connection_version, coalesce(login.allow_autonomous, false), v_member_initiated);
		if v_connection_id is not null then
			return case when public.qorpera_native_account_remaining(v_connection_id, v_connection_version) <> 0
				then v_connection_id end;
		end if;
	end loop;
	return null;
end $$;

create function public.qorpera_surface_session_continue(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
begin
	select * into v_peek from public.qorpera_surface_sessions where id = p_session_id;
	if v_peek.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_peek.profile_id, true);
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.waiting_on_usage_user_id is distinct from v_user_id then
		raise exception 'Only the member whose login is used up can continue this session' using errcode = '42501';
	end if;
	if v_session.state not in ('queued', 'reconciling') then
		raise exception 'This turn already runs on its login' using errcode = '55000';
	end if;
	if public.qorpera_surface_continue_login(v_session, v_user_id) is null then
		raise exception 'None of your logins has room yet' using errcode = '55000';
	end if;
	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;
	return public.qorpera_surface_session_json(v_session);
end $$;

select pg_temp.stw_patch('public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure, array[
$old$		'turnRequestedByUserId', public.qorpera_surface_turn_requester(p_session),$old$,
$new$		'turnRequestedByUserId', public.qorpera_surface_turn_requester(p_session),
		'waitingOnUsage', case
			when p_session.waiting_on_usage_user_id is not null
				and p_session.state in ('queued', 'running', 'reconciling', 'reconciling_running')
				and not p_session.waiting_on_usage_grace
				and (p_session.waiting_on_usage_until is null or p_session.waiting_on_usage_until > clock_timestamp())
			then jsonb_build_object(
				'userId', p_session.waiting_on_usage_user_id,
				'until', p_session.waiting_on_usage_until,
				'continueWith', case
					when p_session.waiting_on_usage_user_id = auth.uid() and p_session.state in ('queued', 'reconciling')
					then (
						select jsonb_build_object('account', (
							select v.provider_account_email from public.qorpera_provider_connection_versions as v
							where v.connection_id = login.id order by v.version desc limit 1
						))
						from (select public.qorpera_surface_continue_login(p_session, p_session.waiting_on_usage_user_id) as id) as login
						where login.id is not null
					)
				end
			)
		end,$new$
]);

select pg_temp.stw_patch('public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure, array[
$old$	v_conflict_paths text[];
begin$old$,
$new$	v_conflict_paths text[];
	v_wait jsonb;
begin$new$,
$old$		v_harness := v_coding_sponsor ->> 'harness';$old$,
$new$		v_wait := public.qorpera_surface_usage_wait(
			(v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint);
		if v_wait is not null then
			return jsonb_build_object('status', 'deferred', 'reason', 'usage_limit', 'resetsAt', v_wait -> 'resetsAt',
				'retryAfterSeconds', ceil(extract(epoch from public.qorpera_surface_hold_for_usage(v_session.id, v_wait, true) - v_now))::integer);
		end if;
		v_harness := v_coding_sponsor ->> 'harness';$new$,
$old$			worker_id = v_worker.id,
			wake_id = null,$old$,
$new$			worker_id = v_worker.id,
			wake_id = null,
			waiting_on_usage_user_id = null,
			waiting_on_usage_until = null,
			waiting_on_usage_grace = false,$new$,
$old$		return jsonb_build_object('status', 'unavailable', 'reason', 'no_sponsor');
	end if;
$old$,
$new$		return jsonb_build_object('status', 'unavailable', 'reason', 'no_sponsor');
	end if;
	v_wait := public.qorpera_surface_usage_wait(
		(v_sponsor ->> 'sponsorBindingId')::uuid, (v_sponsor ->> 'sponsorVersion')::bigint);
	if v_wait is not null then
		return jsonb_build_object('status', 'deferred', 'reason', 'usage_limit', 'resetsAt', v_wait -> 'resetsAt',
			'retryAfterSeconds', ceil(extract(epoch from public.qorpera_surface_hold_for_usage(v_session.id, v_wait, true) - v_now))::integer);
	end if;
$new$,
$old$		wake_id = v_wake.id,$old$,
$new$		wake_id = v_wake.id,
		waiting_on_usage_user_id = null,
		waiting_on_usage_until = null,
		waiting_on_usage_grace = false,$new$
]);

select pg_temp.stw_patch('public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure, array[
$old$		turn_requested_by_user_id = v_user_id,$old$,
$new$		turn_requested_by_user_id = v_user_id,
		waiting_on_usage_user_id = null,
		waiting_on_usage_until = null,
		waiting_on_usage_grace = false,$new$
]);

select pg_temp.stw_patch('public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure, array[
$old$	v_retry_increment integer := 0;
begin$old$,
$new$	v_retry_increment integer := 0;
	v_wait jsonb;
begin$new$,
$old$	if p_state = 'failed' and v_session.retry_count < 1 then$old$,
$new$	if p_state = 'failed' then
		v_wait := public.qorpera_surface_turn_usage_wait(v_session.worker_id, v_session.wake_id,
			public.qorpera_surface_turn_requester(v_session));
		if v_wait is not null then
			perform public.qorpera_surface_hold_for_usage(v_session.id, v_wait, true);
			select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
			return public.qorpera_surface_session_json(v_session);
		end if;
	end if;
	if p_state = 'failed' and v_session.retry_count < 1 then$new$,
$old$		retry_count = retry_count + v_retry_increment,$old$,
$new$		retry_count = retry_count + v_retry_increment,
		waiting_on_usage_user_id = null,
		waiting_on_usage_until = null,
		waiting_on_usage_grace = false,$new$
]);

select pg_temp.stw_patch('public.qorpera_surface_renew_lease(text,uuid,uuid,integer)'::regprocedure, array[
$old$		update public.qorpera_surface_sessions
		set lease_expires_at = v_new_expiry, updated_at = clock_timestamp()$old$,
$new$		update public.qorpera_surface_sessions
		set lease_expires_at = v_new_expiry, waiting_on_usage_user_id = null, waiting_on_usage_until = null,
			waiting_on_usage_grace = false,
			updated_at = clock_timestamp()$new$
]);

select pg_temp.stw_patch('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure, array[
$old$	v_publishes jsonb := '[]'::jsonb;
begin$old$,
$new$	v_publishes jsonb := '[]'::jsonb;
	v_wait jsonb;
	v_alive boolean;
begin$new$,
$old$			where s.state in ('running', 'reconciling_running')
				and not exists (
					select 1 from public.qorpera_runtime_workers rw$old$,
$new$			where s.state in ('running', 'reconciling_running')
				and not (s.waiting_on_usage_user_id is not null and s.lease_expires_at > v_now)
				and not exists (
					select 1 from public.qorpera_runtime_workers rw$new$,
$old$		loop
			if v_expired_session.retry_count < 1 then$old$,
$new$		loop
			v_wait := public.qorpera_surface_turn_usage_wait(v_expired_session.worker_id, v_expired_session.wake_id,
				coalesce(v_expired_session.turn_requested_by_user_id, v_expired_session.created_by_user_id));
			v_alive := exists (
				select 1 from public.qorpera_wake_occurrences wk
				where wk.id = v_expired_session.wake_id and wk.status in ('queued', 'materialized')
			);
			if v_wait is not null then
				perform public.qorpera_surface_hold_for_usage(v_expired_session.id, v_wait, not v_alive);
				continue;
			end if;
			if v_alive and public.qorpera_surface_usage_grace(v_expired_session.id) then
				continue;
			end if;
			if v_expired_session.retry_count < 1 then$new$
]);

select pg_temp.stw_patch('public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure, array[
$old$	v_expired boolean;
begin$old$,
$new$	v_expired boolean;
	v_wait jsonb;
begin$new$,
$old$			if not v_expired then
				continue;
			end if;
$old$,
$new$			if not v_expired then
				continue;
			end if;
			v_wait := public.qorpera_surface_turn_usage_wait(v_worker.id, null, public.qorpera_surface_turn_requester(v_ss));
			if v_wait is not null then
				perform public.qorpera_surface_hold_for_usage(v_ss.id, v_wait, false);
				continue;
			end if;
			if public.qorpera_surface_usage_grace(v_ss.id) then
				continue;
			end if;
$new$
]);

revoke all on function
	public.qorpera_surface_usage_wait(uuid, bigint),
	public.qorpera_surface_turn_usage_wait(uuid, uuid, uuid),
	public.qorpera_surface_hold_for_usage(uuid, jsonb, boolean),
	public.qorpera_surface_usage_grace(uuid),
	public.qorpera_surface_coding_login_usable(uuid, uuid, uuid, bigint, boolean, boolean),
	public.qorpera_surface_continue_login(public.qorpera_surface_sessions, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_surface_session_continue(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_surface_session_continue(uuid) to authenticated;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
			'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
			'public.qorpera_surface_renew_lease(text,uuid,uuid,integer)'::regprocedure,
			'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
			'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure,
			'public.qorpera_surface_session_continue(uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface usage wait function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_usage_wait(uuid, bigint), '
			|| 'public.qorpera_surface_turn_usage_wait(uuid, uuid, uuid), public.qorpera_surface_hold_for_usage(uuid, jsonb, boolean), '
			|| 'public.qorpera_surface_usage_grace(uuid), '
			|| 'public.qorpera_surface_coding_login_usable(uuid, uuid, uuid, bigint, boolean, boolean), '
			|| 'public.qorpera_surface_continue_login(public.qorpera_surface_sessions, uuid) to %I',
			v_owner);
	end loop;
end $$;

drop function pg_temp.stw_patch(regprocedure, text[]);
