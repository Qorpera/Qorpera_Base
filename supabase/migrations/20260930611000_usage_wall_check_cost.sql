-- A login at its usage limit made the run materializer the database's largest cost (perf sprint 7 Nov 2026, measure D1).
--
-- Measured on production, 3 to 7 Nov: qorpera_folder_materialize_company took 72 % of all database time (33,058 s). Of its
-- 193,994 calls, 193,468 answered 'idle', and 193,463 of those fell in the one day a login's usage wall held (5 Nov 12:00Z
-- to 6 Nov 11:30Z). 20260930575000 taught the company's scan to leave work waiting on a login with no room, but not the due
-- list, so each reconcile pass (0.64 a second) listed every company with such work (5 of them), and each company's scan
-- found nothing to do. Each check was itself costly: for a login in 8 companies one qorpera_native_account_remaining ran
-- qorpera_native_account_usage_limit_reset_company 8 times at a wall and 72 times with none, and each of those tested every
-- signal in force, of every company, against the account metadata in nested loops (about 15,900 scans of that table per
-- materializer call). Plain SQL functions are also planned anew on every nested call.
--
-- Nothing changes in what any function answers (test 1111 compares the old and the new text on many worlds):
-- 1. The due list leaves out work whose login has no room, by the check the company's scan uses. Such a call could only
--    answer 'idle', which writes and locks nothing. The check comes last: only for companies the page can name, in page
--    order until the page is full, each company's sponsor version once, stopping at its first with room. A check that
--    fails counts as "no wait", so one bad row never stops the list: that company reaches its own call, where the scan's
--    same check fails for it alone, as before.
-- 2. qorpera_native_account_remaining works out each company's wall once, not once for each of the login's companies.
-- 3. qorpera_native_account_usage_limit_reset_company starts from the signals that can hold this connection, not from all
--    of them, and asks once per signal's login whether a later reading showed room.
-- 4. It, the wall reading's reset and the sibling list become PL/pgSQL, so each session keeps their plans.
-- Every function keeps its signature, ACL and security definer; each body names this migration, for deploy guards.
-- Undo: restore the previous text of the six functions (20260930548000, 575000, 577000, 20260930538000 for the due list).
-- The two helpers this adds can stay.

set local lock_timeout = '3s';

do $$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930577000') = 0 then
		raise exception '20260930611000 needs 20260930577000'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930611000') > 0 then
		raise exception '20260930611000 is already applied'; end if;
end $$;

-- 4. The login's other companies: the same query, its plan kept.
create or replace function public.qorpera_account_login_sibling_connections(p_connection_id uuid)
returns table(connection_id uuid, connection_version bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930611000: PL/pgSQL, so the session keeps the plan.
	return query
	select other_version.connection_id, other_version.version
	from public.qorpera_provider_connection_versions as own_version
	join public.qorpera_model_login_links as own_link on own_link.credential_capsule_id = own_version.credential_capsule_id
	join public.qorpera_model_login_links as other_link on other_link.login_id = own_link.login_id
		and other_link.owner_user_id = own_link.owner_user_id
		and other_link.credential_capsule_id <> own_link.credential_capsule_id
	join public.qorpera_provider_connection_versions as other_version
		on other_version.credential_capsule_id = other_link.credential_capsule_id
	where own_version.connection_id = p_connection_id
		and own_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
			where latest.connection_id = p_connection_id)
		and other_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
			where latest.connection_id = other_version.connection_id);
end $$;

-- 4. The latest reset still ahead of a full window in a usage reading of this login: the same query, its plan kept.
create or replace function public.qorpera_native_account_wall_reading_reset(p_connection_id uuid)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_reset timestamptz;
begin
	-- 20260930577000; 20260930611000: PL/pgSQL, so the session keeps the plan.
	select max((w.value ->> 'resetAt')::timestamptz) into v_reset
	from (select current_version.connection_id, current_version.version as connection_version
		from (select v.connection_id, v.version from public.qorpera_provider_connection_versions as v
			where v.connection_id = p_connection_id order by v.version desc limit 1) as current_version
		union all
		select sibling.connection_id, sibling.connection_version
		from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling) as login
	join public.qorpera_native_provider_account_metadata as m on m.connection_id = login.connection_id
		and m.connection_version = login.connection_version
	cross join lateral jsonb_array_elements(case when jsonb_typeof(m.provider_account_usage -> 'windows') = 'array'
		then m.provider_account_usage -> 'windows' else '[]'::jsonb end) as w
	where jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w.value -> 'resetAt') = 'string'
		and (w.value ->> 'resetAt')::timestamptz > clock_timestamp()
		and (w.value ->> 'resetAt')::timestamptz < clock_timestamp() + interval '90 days';
	return v_reset;
end $$;

-- 3. One connection's wall. The rules are 20260930575000's and 20260930577000's:
-- * a usage-limit signal holds this connection if it is on the connection's current version, or on a login of the same
--   provider account of the same member in the same company at the version that reading names;
-- * it holds until its reset, or, naming none, until 6 hours after it or (for 8 days) the reset a usage reading names;
-- * a later reading of that account in this company, on a live login, showing room in every window, ends it at once.
create or replace function public.qorpera_native_account_usage_limit_reset_company(p_connection_id uuid)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_reset timestamptz;
begin
	-- 20260930575000; 20260930577000; 20260930611000: from the signals that can hold it, not from all of them.
	with login as (
		select connection.profile_id, connection.owner_user_id, connection.provider, current_version.version
		from public.qorpera_provider_connections as connection
		cross join lateral (select v.version from public.qorpera_provider_connection_versions as v
			where v.connection_id = connection.id order by v.version desc limit 1) as current_version
		where connection.id = p_connection_id
	), signal as materialized (
		select blocked.provider_connection_id, blocked.provider_connection_version, blocked.observed_at,
			coalesce(blocked.resets_at, greatest(blocked.observed_at + interval '6 hours',
				/* 20260930577000: else the reset a usage reading of this login names; an init plan, run at most once */
				case when blocked.observed_at > statement_timestamp() - interval '8 days'
					then (select public.qorpera_native_account_wall_reading_reset(p_connection_id)) end)) as held_until
		from (
			select own_signal.provider_connection_id, own_signal.provider_connection_version, own_signal.observed_at,
				own_signal.resets_at
			from login
			join public.qorpera_provider_connection_usage_signals as own_signal
				on own_signal.provider_connection_id = p_connection_id
				and own_signal.provider_connection_version = login.version
			where own_signal.signal_kind = 'usage_limit'
			union all
			select other_signal.provider_connection_id, other_signal.provider_connection_version, other_signal.observed_at,
				other_signal.resets_at
			from login
			join public.qorpera_native_provider_account_metadata as own
				on own.connection_id = p_connection_id and own.connection_version = login.version
			join public.qorpera_native_provider_account_metadata as other
				on other.provider_account_identity = own.provider_account_identity
			join public.qorpera_provider_connections as other_connection on other_connection.id = other.connection_id
				and other_connection.profile_id = login.profile_id
				and other_connection.owner_user_id is not distinct from login.owner_user_id
				and other_connection.provider = login.provider
			join public.qorpera_provider_connection_usage_signals as other_signal
				on other_signal.provider_connection_id = other.connection_id
				and other_signal.provider_connection_version = other.connection_version
			where other_signal.signal_kind = 'usage_limit'
		) as blocked
	), blocked_login as materialized (
		select distinct signal.provider_connection_id, signal.provider_connection_version
		from signal where signal.held_until > statement_timestamp()
	), room as materialized (
		-- 20260930575000: the newest reading with room, with or without a reset time, however old the reading.
		select blocked_login.provider_connection_id, blocked_login.provider_connection_version,
			(select max((recovered.provider_account_usage ->> 'observedAt')::timestamptz)
			from public.qorpera_native_provider_account_metadata as recovered
			join public.qorpera_provider_connections as recovered_connection on recovered_connection.id = recovered.connection_id
			join public.qorpera_provider_connection_versions as recovered_version
				on recovered_version.connection_id = recovered.connection_id
				and recovered_version.version = recovered.connection_version
			left join public.qorpera_native_provider_account_metadata as blocked_metadata
				on blocked_metadata.connection_id = blocked_login.provider_connection_id
				and blocked_metadata.connection_version = blocked_login.provider_connection_version
			where recovered_connection.profile_id = login.profile_id
				and recovered_connection.owner_user_id is not distinct from login.owner_user_id
				and recovered_connection.provider = login.provider
				and recovered_connection.status = 'active' and recovered_version.authorization_state = 'active'
				and recovered_version.authentication_mode = 'native_subscription'
				and not exists (select 1 from public.qorpera_provider_connection_versions as newer
					where newer.connection_id = recovered.connection_id and newer.version > recovered.connection_version)
				and ((recovered.connection_id = blocked_login.provider_connection_id
					and recovered.connection_version = blocked_login.provider_connection_version)
					or recovered.provider_account_identity = blocked_metadata.provider_account_identity)
				and (recovered.provider_account_usage ->> 'observedAt')::timestamptz <= statement_timestamp()
				and jsonb_array_length(recovered.provider_account_usage -> 'windows') > 0
				and not exists (select 1 from jsonb_array_elements(recovered.provider_account_usage -> 'windows') as w
					where (w ->> 'usedPercent')::numeric is null or (w ->> 'usedPercent')::numeric < 0
						or (w ->> 'usedPercent')::numeric >= 100
						or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz
							<= (recovered.provider_account_usage ->> 'observedAt')::timestamptz))) as observed_at
		from blocked_login cross join login
	)
	select max(signal.held_until) into v_reset
	from signal
	join room on room.provider_connection_id = signal.provider_connection_id
		and room.provider_connection_version = signal.provider_connection_version
	where signal.held_until > statement_timestamp()
		and (room.observed_at is null or room.observed_at <= signal.observed_at);
	return v_reset;
end $$;

-- 2. One company connection's room in its fresh windows, or nothing: the second half of
-- qorpera_native_account_remaining_company, on its own.
create function public.qorpera_native_account_window_room(p_connection_id uuid, p_connection_version bigint)
returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_room numeric;
begin
	-- 20260930611000
	select min(100 - (w.value ->> 'usedPercent')::numeric) into v_room
	from public.qorpera_native_provider_account_metadata as m,
		lateral jsonb_array_elements(m.provider_account_usage -> 'windows') as w
	where m.connection_id = p_connection_id and m.connection_version = p_connection_version
		and (m.provider_account_usage ->> 'observedAt')::timestamptz > statement_timestamp() - interval '5 minutes'
		and (not (w.value ? 'resetAt') or (w.value ->> 'resetAt')::timestamptz > statement_timestamp());
	return v_room;
end $$;
revoke all on function public.qorpera_native_account_window_room(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_native_account_remaining_company(p_connection_id uuid, p_connection_version bigint)
returns numeric
language sql stable security definer set search_path = '' as $$
	-- 20260930611000: the windows moved to qorpera_native_account_window_room.
	select case when public.qorpera_native_account_usage_limit_reset(p_connection_id) is not null then 0
		else coalesce(public.qorpera_native_account_window_room(p_connection_id, p_connection_version), -1) end
$$;

-- 2. The login's room, as before: 0 if qorpera_native_account_usage_limit_reset is set, else the least of
-- qorpera_native_account_remaining_company at or above 0 over this connection and its siblings, else -1. Each of those
-- asked again for the wall of the connection and of all its siblings; now each wall is asked once. Once this connection
-- and its siblings have no wall, one kind of connection can still close a sibling: another connection on this one's
-- credential capsule. It is never this connection's sibling, but it is a sibling of each of its siblings (a capsule has
-- one login link, so a sibling's siblings are the connections on this login's other capsules).
create or replace function public.qorpera_native_account_remaining(p_connection_id uuid, p_connection_version bigint)
returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_connections uuid[]; v_versions bigint[]; v_remaining numeric;
begin
	-- 20260930611000: each company's wall once.
	select coalesce(array_agg(sibling.connection_id), '{}'), coalesce(array_agg(sibling.connection_version), '{}')
	into v_connections, v_versions
	from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling;
	if public.qorpera_native_account_usage_limit_reset_company(p_connection_id) is not null then return 0; end if;
	if exists (select 1 from unnest(v_connections) as sibling(connection_id)
		where public.qorpera_native_account_usage_limit_reset_company(sibling.connection_id) is not null) then
		return 0;
	end if;
	if cardinality(v_connections) > 0 and exists (
		select 1 from public.qorpera_provider_connection_versions as own
		join public.qorpera_provider_connection_versions as other on other.credential_capsule_id = own.credential_capsule_id
			and other.connection_id <> own.connection_id
		where own.connection_id = p_connection_id
			and own.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
				where latest.connection_id = p_connection_id)
			and other.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
				where latest.connection_id = other.connection_id)
			and public.qorpera_native_account_usage_limit_reset_company(other.connection_id) is not null) then
		return 0;
	end if;
	select min(known.remaining) into v_remaining
	from (select public.qorpera_native_account_window_room(login.connection_id, login.connection_version) as remaining
		from unnest(array[p_connection_id] || v_connections, array[p_connection_version] || v_versions)
			as login(connection_id, connection_version)
		offset 0) as known
	where known.remaining >= 0;
	return coalesce(v_remaining, -1);
end $$;

-- 1. The due list's check for one sponsor version: the scan's own check, which may not stop the list. A check that fails
-- says "no wait", so the company is listed and its own qorpera_folder_materialize_company fails for it alone (its scan
-- makes the same check) and reports the error; a cancel or a timeout is not caught.
create function public.qorpera_folder_due_sponsor_waits(p_binding_id uuid, p_version bigint)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930611000
	return public.qorpera_sponsor_waits_for_usage_limit(p_binding_id, p_version);
exception when others then
	return false;
end $$;
revoke all on function public.qorpera_folder_due_sponsor_waits(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 1. The due list: work whose login has no room is not due (the check the company's scan makes, 20260930575000). The check
-- is last, so a pass costs little however much work waits: only the companies the page can name, in page order until the
-- page is full.
create or replace function public.qorpera_folder_materialize_due(p_after_profile_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid; v_has_more boolean; v_now timestamptz := clock_timestamp();
begin
	-- 20260930018000: folder core C4 (P28).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Run materialization requires control-plane authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Run materialization page limit is invalid' using errcode = '22023'; end if;
	-- The work the company's materializer would take: a request at the head of its conversation with no live turn, and
	-- a due wake; a wake left waiting with its reason comes back after 30 seconds, not on every pass.
	with work as (
		select request.profile_id, request.sponsor_binding_id, request.sponsor_version
		from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		join public.qorpera_session_inputs as input on input.id = request.input_id and input.session_id = request.session_id
		where request.status = 'queued' and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
			and not exists (select 1 from public.qorpera_session_turn_requests as earlier
				join public.qorpera_session_inputs as earlier_input on earlier_input.id = earlier.input_id
				where earlier.session_id = request.session_id and earlier.status = 'queued'
					and (earlier.created_at, earlier.id) < (request.created_at, request.id)
					and earlier_input.completed_at is null and earlier_input.failed_at is null
					and earlier_input.execution_run_id is null and earlier_input.turn_id is null)
			-- 20260930538000 (G5): any live run in the conversation, a wake's or a room delivery's too.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = request.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased'))
		union
		select wake.profile_id, wake.sponsor_binding_id, wake.sponsor_version from public.qorpera_wake_occurrences as wake
		where wake.status = 'queued' and wake.not_before <= v_now
			and (wake.blocked_reason is null or wake.admission_scan_at <= v_now - interval '30 seconds')
			-- 20260930538000 (G5): a wake waits while its conversation has a live run; in a group chat (no agent), while its
			-- own agent has one there.
			and not exists (select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				join public.qorpera_shared_sessions as session on session.id = run.session_id
				where run.session_id = wake.session_id and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased')
					and (session.staff_agent_id is not null or run.staff_agent_id = wake.staff_agent_id))
	), listable as (
		select company.profile_id from (select distinct work.profile_id from work) as company
		join public.qorpera_company_files as file on file.profile_id = company.profile_id and file.core = 'folder-v2'
		where (p_after_profile_id is null or company.profile_id > p_after_profile_id)
			and not public.qorpera_company_execution_paused(company.profile_id)
			and not public.qorpera_company_at_zero(company.profile_id, v_now)
		order by company.profile_id
	), page as (
		-- 20260930611000: work at its login's usage limit is not due; the company's scan would leave it queued and answer
		-- idle. Without this every pass called every such company, for as long as the limit held. Each row of work is one
		-- company's one sponsor version. Offset 0 keeps this a check per listable company, in page order, up to the limit;
		-- as a join it could check every company's sponsors first.
		select listable.profile_id from listable
		where exists (select 1 from work where work.profile_id = listable.profile_id
			and not public.qorpera_folder_due_sponsor_waits(work.sponsor_binding_id, work.sponsor_version) offset 0)
		order by listable.profile_id
		limit p_limit + 1
	), visible as (
		select * from page order by profile_id limit p_limit
	)
	select (select coalesce(jsonb_agg(jsonb_build_object('profile_id', visible.profile_id) order by visible.profile_id),
				'[]'::jsonb) from visible),
		(select visible.profile_id from visible order by visible.profile_id desc limit 1),
		(select count(*) > p_limit from page)
	into v_items, v_next, v_has_more;
	return jsonb_build_object('items', v_items, 'has_more', v_has_more,
		'next_after_profile_id', case when v_has_more then v_next end);
end $$;

do $guard$
declare v_target regprocedure;
begin
	foreach v_target in array array[
		'public.qorpera_account_login_sibling_connections(uuid)'::regprocedure,
		'public.qorpera_native_account_wall_reading_reset(uuid)'::regprocedure,
		'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
		'public.qorpera_native_account_window_room(uuid,bigint)'::regprocedure,
		'public.qorpera_folder_due_sponsor_waits(uuid,bigint)'::regprocedure,
		'public.qorpera_native_account_remaining_company(uuid,bigint)'::regprocedure,
		'public.qorpera_native_account_remaining(uuid,bigint)'::regprocedure]
	loop
		if strpos((select prosrc from pg_proc where oid = v_target), '20260930611000') = 0 then
			raise exception '20260930611000 marker is missing in %', v_target; end if;
		if has_function_privilege('anon', v_target, 'execute') or has_function_privilege('authenticated', v_target, 'execute')
			or has_function_privilege('service_role', v_target, 'execute') then
			raise exception '20260930611000: % must stay private', v_target; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930577000') = 0 then
		raise exception '20260930611000 dropped the marker the bundle activations read'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_materialize_due(uuid,integer)'::regprocedure),
		'20260930611000') = 0 then
		raise exception '20260930611000 marker is missing in the due list'; end if;
end $guard$;
