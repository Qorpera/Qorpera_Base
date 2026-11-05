-- Work at a usage limit waits on its own login and goes on by itself once the limit resets (founder, 5 Nov 2026).
--
-- "it won't automatically switch the subscription token, but wait until I press this button to do so in the chat. it
-- should do so automatically. or if there are no accounts with usage remaining, it should refresh it once daily to see if
-- usage is back so it can continue". Asked about OpenAI's terms on rotating accounts round a usage limit (the 1 October
-- amendment), the founder chose "wait + resume only": nothing moves to another login by itself. The 4 October rule
-- (20260930059000, 20260930095000) stands: work stays on its login, also at its limit; only the member's own pick moves
-- it. What changes is that waiting work no longer needs that pick to go on:
-- * The wall a usage limit puts on a login ends at the provider's reset (else 6 hours after the limit, as before), and a
--   usage reading taken after the limit that shows room ends it at once (qorpera_native_account_usage_limit_reset_company).
--   Before, a reading lifted it only for five minutes, and never one with a reset time.
-- * Codex's usage-limit error names no reset (codexErrorInfo is the bare name usageLimitExceeded), so no signal had one.
--   A signal now takes it from the login's newest usage reading, the one Settings → Refresh records: the latest reset
--   still ahead of a full window, in the reading of the version the run used (and the same account login's current links
--   in the member's other companies), observed in the last day (qorpera_native_account_reading_reset).
-- * What waits, on the same login, while that login is at its limit, and then goes on with nothing to press:
--   - a paused run (W5a): it comes back at the reset (6 hours without one), or as soon as a usage reading shows room
--     (qorpera_release_paused_runs_with_room, from the refresh's completion);
--   - a conversation's message and every wake (follow-up work, a routine's run, a coding turn's run): the materializer
--     leaves them queued until the login has room (qorpera_sponsor_waits_for_usage_limit);
--   - a coding session's next turn: the executor does not claim it until its login has room.
-- * The daily usage check: the shared vault's upkeep pass asks for one login at its limit that is due a reading
--   (qorpera_begin_model_login_usage_recheck): one whose newest reading is older than its limit, more than a day old, or
--   older than a reset it named that has passed; at most one refresh per member's identity in three hours, so a limit the
--   readings do not show is not lifted and hit again more often than that.
-- * The member's own pick of another login (the chat's Login menu) applies to their next message: in an agent thread (a
--   room) it runs at once, while a message already waiting stays on its login (an admitted wake never changes payer). The call makes an account
--   refresh for that member's identity, which the vault runs as Settings → Refresh's (its describe, record and complete).
--   Only vault logins are read this way; a login on a node is read when its member refreshes.
-- * The usage-limit notice names the login (accountEmail) for the member whose login it is; its kind and schema are
--   unchanged, so an older web reads it as before. The agent's words say the work waits and goes on by itself.
--
-- Locks: the materializer and the coding claim only read the new conditions. The paused-run release takes queued runner
-- job rows FOR UPDATE SKIP LOCKED after the refresh row, so it never waits on a claim. The recheck takes the identity's
-- refresh advisory lock, as Settings → Refresh does. Every new or changed body carries the marker 20260930575000.

set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_begin_model_login_usage_recheck(uuid,text,text)') is not null then
		raise exception '20260930575000 is already applied'; end if;
	if to_regprocedure('public.qorpera_native_account_rank(uuid,bigint)') is null
		or to_regprocedure('public.qorpera_account_login_sibling_connections(uuid)') is null
		or to_regprocedure('public.qorpera_resume_run_from_log(uuid,text,boolean)') is null then
		raise exception '20260930575000 needs 20260930548000, 20260930559000 and 20260930170000'; end if;
end $$;

create function pg_temp.as575_patch(p_target regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception '20260930575000 anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The wall of a usage limit ------------------------------------------------------------------------------------------

-- It ends at the provider's reset (else 6 hours after the limit, as before); and a reading after the limit that shows room
-- in every window ends it at once.
select pg_temp.as575_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$      and (blocked.resets_at is not null or not exists ($old$,
	$new$      -- 20260930575000: a later reading with room ends it, with or without a reset time, however old the reading.
      and (not exists ($new$);
select pg_temp.as575_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$          and (recovered.provider_account_usage ->> 'observedAt')::timestamptz > statement_timestamp() - interval '5 minutes'
$old$, '');
-- A window that had already reset when the reading was taken makes it no evidence; one that reset since does not.
select pg_temp.as575_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$              or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz <= statement_timestamp()))$old$,
	$new$              or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz
                <= (recovered.provider_account_usage ->> 'observedAt')::timestamptz))$new$);

-- The reset of a login at its usage limit by its newest usage reading.
create function public.qorpera_native_account_reading_reset(p_connection_id uuid, p_connection_version bigint)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select max((w.value ->> 'resetAt')::timestamptz)
	from (select p_connection_id as connection_id, p_connection_version as connection_version
		union all
		select sibling.connection_id, sibling.connection_version
		from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling) as login
	join public.qorpera_native_provider_account_metadata as m on m.connection_id = login.connection_id
		and m.connection_version = login.connection_version
	cross join lateral jsonb_array_elements(case when jsonb_typeof(m.provider_account_usage -> 'windows') = 'array'
		then m.provider_account_usage -> 'windows' else '[]'::jsonb end) as w
	where jsonb_typeof(m.provider_account_usage -> 'observedAt') = 'string'
		and (m.provider_account_usage ->> 'observedAt')::timestamptz > clock_timestamp() - interval '1 day'
		and jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w.value -> 'resetAt') = 'string'
		and (w.value ->> 'resetAt')::timestamptz > clock_timestamp()
		and (w.value ->> 'resetAt')::timestamptz < clock_timestamp() + interval '90 days'
$$;

-- The login's email for the member whose own login it is, for the usage-limit notice; nothing for a company account.
create function public.qorpera_usage_limit_account(p_user_id uuid, p_connection_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select coalesce((select jsonb_build_object('accountEmail', (select version.provider_account_email
			from public.qorpera_provider_connection_versions as version
			where version.connection_id = p_connection_id order by version.version desc limit 1))
		from public.qorpera_provider_connections as connection
		where connection.id = p_connection_id and connection.owner_user_id = p_user_id), '{}'::jsonb)
$$;

revoke all on function public.qorpera_native_account_reading_reset(uuid, bigint), public.qorpera_usage_limit_account(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.as575_patch('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
$old$		p_signal_kind,'native_adapter',p_resets_at,v_lease.assignment_id)
$old$,
$new$		-- 20260930575000: the provider names no reset with a usage limit; the login's newest usage reading may.
		p_signal_kind,'native_adapter',coalesce(p_resets_at, case when p_signal_kind = 'usage_limit'
			then public.qorpera_native_account_reading_reset(v_lease.provider_connection_id, v_lease.provider_connection_version)
			end),v_lease.assignment_id)
$new$);
select pg_temp.as575_patch('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
$old$				'sponsorVersion',v_run.sponsor_version,'resetsAt',p_resets_at),
$old$,
$new$				'sponsorVersion',v_run.sponsor_version,'resetsAt',v_signal.resets_at)
				-- 20260930575000: which login reached its limit, for its own member.
				|| public.qorpera_usage_limit_account(v_recipient, v_connection.id),
$new$);

-- 2. What waits, on the same login ----------------------------------------------------------------------------------------

-- Whether work paid by this sponsor version waits for its login's usage limit: the login has no room now (a usage-limit
-- wall, or a fresh reading with a full window). Unknown usage is room.
create function public.qorpera_sponsor_waits_for_usage_limit(p_binding_id uuid, p_version bigint)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select coalesce((select public.qorpera_native_account_remaining(sponsor.provider_connection_id,
			sponsor.provider_connection_version) = 0
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_binding_id and sponsor.version = p_version), false)
$$;

-- A coding session waits while the login it pays with has no room.
create function public.qorpera_coding_session_waits_for_usage_limit(p_worker_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select coalesce((select public.qorpera_sponsor_waits_for_usage_limit(worker.owner_sponsor_binding_id,
			public.qorpera_live_sponsor_version(worker.owner_sponsor_binding_id, worker.owner_sponsor_version))
		from public.qorpera_runtime_workers as worker
		where worker.id = p_worker_id and worker.owner_sponsor_binding_id is not null), false)
$$;

revoke all on function public.qorpera_sponsor_waits_for_usage_limit(uuid, bigint),
	public.qorpera_coding_session_waits_for_usage_limit(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The materializer leaves a conversation's message and a wake queued while their login has no room.
select pg_temp.as575_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
$old$		where request.profile_id = p_profile_id and request.status = 'queued' and input.completed_at is null
$old$,
$new$		where request.profile_id = p_profile_id and request.status = 'queued' and input.completed_at is null
			-- 20260930575000: a message waits while its login is at its usage limit, and goes on once it has room.
			and not public.qorpera_sponsor_waits_for_usage_limit(request.sponsor_binding_id, request.sponsor_version)
$new$);
select pg_temp.as575_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
$old$		where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.not_before <= v_now
$old$,
$new$		where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.not_before <= v_now
			-- 20260930575000: so does a wake (follow-up work, a routine's run, a coding turn's run).
			and not public.qorpera_sponsor_waits_for_usage_limit(wake.sponsor_binding_id, wake.sponsor_version)
$new$);

-- The coding executor claims no session whose login has no room: its next turn waits in the queue.
select pg_temp.as575_patch('public.qorpera_claim_coding_session(text,integer)'::regprocedure,
$old$		where (session.phase in ('queued','input_ready') and (session.claim_after is null or session.claim_after <= clock_timestamp())
$old$,
$new$		where (session.phase in ('queued','input_ready') and (session.claim_after is null or session.claim_after <= clock_timestamp())
				-- 20260930575000: a session whose login is at its usage limit waits until it has room.
				and not public.qorpera_coding_session_waits_for_usage_limit(session.worker_id)
$new$);

-- Paused runs of an identity's logins come back as soon as their login has room (a usage reading showed it): their
-- deferral ends now. Rows a claim holds are left; they come back at their own time.
create function public.qorpera_release_paused_runs_with_room(p_compute_identity_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	-- 20260930575000
	with paused as (
		select job.id
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.id = job.run_id and run.job_id = job.id
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
			and sponsor.version = run.sponsor_version
		join public.qorpera_provider_connection_versions as version on version.connection_id = sponsor.provider_connection_id
			and version.version = sponsor.provider_connection_version
		join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
			and capsule.compute_identity_id = p_compute_identity_id
		cross join lateral (select event.payload from public.qorpera_execution_run_events as event
			where event.run_id = run.id and event.event_type = 'run_paused' order by event.id desc limit 1) as last_event
		where job.status = 'queued' and job.dispatch_deferred_until > clock_timestamp()
			and last_event.payload ->> 'schema' = 'qorpera.run-resume/v1'
			and (last_event.payload ->> 'resetsAt')::timestamptz = job.dispatch_deferred_until
			and public.qorpera_native_account_usage_limit_reset(sponsor.provider_connection_id) is null
		for update of job skip locked
	)
	update public.qorpera_runner_jobs as job
	set dispatch_deferred_until = clock_timestamp(), queued_at = clock_timestamp()
	from paused where job.id = paused.id;
	get diagnostics v_count = row_count;
	return v_count;
end
$$;
revoke all on function public.qorpera_release_paused_runs_with_room(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.as575_patch('public.qorpera_complete_model_login_account_refresh(uuid,text,uuid,text)'::regprocedure,
$old$	set status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
	where id = p_request_id;
$old$,
$new$	set status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
	where id = p_request_id;
	-- 20260930575000: a reading with room ends its login's wall; runs paused on it come back now.
	perform public.qorpera_release_paused_runs_with_room(v_request.compute_identity_id);
$new$);

-- 3. The daily usage check --------------------------------------------------------------------------------------------

-- Whether a login at its usage limit is due a usage reading: it is at its limit (a usage-limit wall, or its newest reading
-- shows a full window), and that reading is missing, older than its newest limit, more than a day old, or older than a
-- reset of a full window that has passed since.
create function public.qorpera_native_account_usage_recheck_due(p_connection_id uuid, p_connection_version bigint)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	with reading as (
		select (m.provider_account_usage ->> 'observedAt')::timestamptz as observed_at,
			case when jsonb_typeof(m.provider_account_usage -> 'windows') = 'array'
				then m.provider_account_usage -> 'windows' else '[]'::jsonb end as windows
		from public.qorpera_native_provider_account_metadata as m
		where m.connection_id = p_connection_id and m.connection_version = p_connection_version
			and jsonb_typeof(m.provider_account_usage -> 'observedAt') = 'string'
	),
	full_window as (
		select case when jsonb_typeof(w.value -> 'resetAt') = 'string' then (w.value ->> 'resetAt')::timestamptz end as reset_at
		from reading cross join lateral jsonb_array_elements(reading.windows) as w
		where jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
	),
	signal as (
		select max(blocked.observed_at) as observed_at from public.qorpera_provider_connection_usage_signals as blocked
		where blocked.provider_connection_id = p_connection_id and blocked.signal_kind = 'usage_limit'
	)
	select (public.qorpera_native_account_usage_limit_reset(p_connection_id) is not null or exists (select 1 from full_window))
		and (not exists (select 1 from reading)
			or exists (select 1 from reading, signal where reading.observed_at < signal.observed_at)
			or exists (select 1 from reading where reading.observed_at < clock_timestamp() - interval '1 day')
			or exists (select 1 from reading, full_window where full_window.reset_at <= clock_timestamp()
				and full_window.reset_at > reading.observed_at))
$$;
revoke all on function public.qorpera_native_account_usage_recheck_due(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The vault's daily check: one member identity of this broker's company with a vault login (a company login, or an account
-- login's link) at its usage limit and due a reading, with no refresh of its own in the last three hours. Makes a pending account
-- refresh for that identity under p_capability_sha256 (the vault's own, made for this one refresh), as
-- qorpera_begin_native_account_refresh makes the member's; answers it, or null when nothing is due. The vault then runs it
-- as Settings → Refresh's.
create function public.qorpera_begin_model_login_usage_recheck(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_capability_sha256 text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_created timestamptz;
begin
	-- 20260930575000
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login usage recheck is invalid' using errcode = '22023'; end if;
	if public.qorpera_company_execution_paused(v_authority.profile_id)
		or not public.qorpera_provider_execution_enabled('openai', 'native_subscription', 'codex-cli') then
		return jsonb_build_object('schema', 'qorpera.model-login-usage-recheck/v1', 'request', null); end if;
	select identity.* into v_identity
	from public.qorpera_provider_connections as connection
	cross join lateral (select v.* from public.qorpera_provider_connection_versions as v
		where v.connection_id = connection.id order by v.version desc limit 1) as version
	join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
		and capsule.status = 'active' and capsule.encrypted_capsule_reference ~ '^model-login/[0-9a-f-]{36}$'
	join public.qorpera_member_compute_identities as identity on identity.id = capsule.compute_identity_id
		and identity.profile_id = v_authority.profile_id and identity.ownership_kind = 'member' and identity.status = 'active'
		and identity.recovery_pending_id is null and identity.owner_user_id = connection.owner_user_id
	join public.qorpera_profile_members as member on member.profile_id = identity.profile_id
		and member.user_id = identity.owner_user_id and member.role in ('owner', 'admin', 'contributor')
	where connection.profile_id = v_authority.profile_id and connection.status = 'active' and connection.provider = 'openai'
		and version.authorization_state = 'active' and version.authentication_mode = 'native_subscription'
		and version.native_harness = 'codex-cli'
		-- A company vault login of this broker, or an account login's link in this company.
		and (exists (select 1 from public.qorpera_model_logins as login
				where login.credential_capsule_id = capsule.id and login.broker_authority_id = v_authority.id
					and login.status = 'active')
			-- As qorpera_describe_model_login_account_refresh lists an account login (20260930548000).
			or exists (select 1 from public.qorpera_model_login_links as link
				join public.qorpera_model_logins as login on login.id = link.login_id
				where link.credential_capsule_id = capsule.id and link.profile_id = v_authority.profile_id
					and link.compute_identity_id = identity.id and link.owner_user_id = identity.owner_user_id
					and login.owner_user_id = link.owner_user_id and login.status = 'active'
					and login.principal_id = v_authority.principal_id
					and public.qorpera_account_model_logins_enabled()))
		and public.qorpera_native_account_usage_recheck_due(connection.id, version.version)
		and not exists (select 1 from public.qorpera_native_account_refresh_requests as recent
			where recent.compute_identity_id = identity.id
				and (recent.created_at > clock_timestamp() - interval '3 hours'
					or (recent.status = 'pending' and recent.expires_at > clock_timestamp())))
	order by connection.id
	limit 1;
	if v_identity.id is null then
		return jsonb_build_object('schema', 'qorpera.model-login-usage-recheck/v1', 'request', null); end if;
	-- The identity's refresh lock, as a member's refresh takes it; then the check again under it.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.account_refresh:' || v_identity.id::text, 0));
	update public.qorpera_native_account_refresh_requests set status = 'expired'
	where compute_identity_id = v_identity.id and status = 'pending' and expires_at <= clock_timestamp();
	if exists (select 1 from public.qorpera_native_account_refresh_requests as recent
		where recent.compute_identity_id = v_identity.id
			and (recent.created_at > clock_timestamp() - interval '3 hours' or recent.status = 'pending')) then
		return jsonb_build_object('schema', 'qorpera.model-login-usage-recheck/v1', 'request', null); end if;
	v_created := clock_timestamp();
	insert into public.qorpera_native_account_refresh_requests(profile_id, client_request_id, compute_identity_id,
		requested_by_user_id, capability_sha256, compute_recovery_epoch, status, created_at, expires_at)
	values (v_identity.profile_id, extensions.gen_random_uuid(), v_identity.id, v_identity.owner_user_id, p_capability_sha256,
		v_identity.recovery_epoch, 'pending', v_created, v_created + interval '5 minutes')
	returning * into v_request;
	return jsonb_build_object('schema', 'qorpera.model-login-usage-recheck/v1',
		'request', public.qorpera_native_account_refresh_json(v_request));
end
$$;
revoke all on function public.qorpera_begin_model_login_usage_recheck(uuid, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_model_login_usage_recheck(uuid, text, text) to qorpera_secret_broker;

-- 4. What the agent is told ---------------------------------------------------------------------------------------------

-- The words a run at its usage limit gives its agent (20260930549300): the work waits and goes on by itself.
select pg_temp.as575_patch('public.qorpera_worker_usage_limit_text(uuid)'::regprocedure,
$old$	-- 20260930549300.
	select 'The login paying for this work reached its usage limit. '
		|| case when limit_reset.resets is null then ''
			else 'It resets on ' || to_char(limit_reset.resets at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work does not move to another login by itself: the member can choose another of their logins for it '
		|| '(in the conversation''s Login menu), or wait until the limit resets.'
$old$,
$new$	-- 20260930549300. 20260930575000: the work waits and goes on by itself on the same login.
	select 'The login paying for this work reached its usage limit. '
		|| case when limit_reset.resets is null then ''
			else 'It resets on ' || to_char(limit_reset.resets at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work does not move to another login by itself. It waits and goes on by itself on this login once the limit '
		|| 'resets (its usage is checked at least once a day). The member can also choose another of their logins for it '
		|| '(in the conversation''s Login menu).'
$new$);

-- 5. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_native_account_usage_limit_reset_company(uuid)', 'public.qorpera_native_account_reading_reset(uuid,bigint)',
		'public.qorpera_usage_limit_account(uuid,uuid)',
		'public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
		'public.qorpera_sponsor_waits_for_usage_limit(uuid,bigint)',
		'public.qorpera_coding_session_waits_for_usage_limit(uuid)', 'public.qorpera_folder_materialize_company(uuid,integer)',
		'public.qorpera_claim_coding_session(text,integer)', 'public.qorpera_release_paused_runs_with_room(uuid)',
		'public.qorpera_complete_model_login_account_refresh(uuid,text,uuid,text)',
		'public.qorpera_native_account_usage_recheck_due(uuid,bigint)',
		'public.qorpera_begin_model_login_usage_recheck(uuid,text,text)', 'public.qorpera_worker_usage_limit_text(uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930575000') = 0 then
			raise exception '20260930575000 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
