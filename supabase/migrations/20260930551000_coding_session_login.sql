-- A coding session whose login cannot pay says so, and its owner can move it to another of their logins (live
-- company-building test, 3 Nov 2026). Every patched or new body carries the marker 20260930551000.
--
-- Session 774b2e2c was dispatched on the founder's login 4f417795. Its first turn failed at the provider (a ChatGPT
-- workspace plan Codex refuses), and the founder signed that login out (Settings, AI subscriptions, Sign out: the
-- connection is revoked). The Co-Founder then asked the same session to try again: the turn's wake was cancelled at
-- admission, "Wake execution authority is unavailable" (qorpera_folder_materialize_company: the session's sponsor
-- binding still pays with the revoked connection, as it must, since the payer never changes without the member,
-- 20260930059000), so no run began, and the executor completed the turn failed with "The coding turn did not
-- finish." and no reason. The agent, the turn's outcome (reason null) and the session's card had nothing to act on,
-- and nothing let the member move the session to the login they still had: a coding session's payer is pinned at the
-- dispatch (qorpera_coding_owner_payer) and only a conversation had a login choice
-- (qorpera_choose_member_session_account).
--
-- Now:
-- * qorpera_coding_session_login_state(worker): whether the login the session pays with can pay for its next turn, as
--   admission checks it: 'ready', or 'removed' (signed out or its binding ended), 'disabled' (an owner or admin turned
--   it off), 'needs_sign_in', 'not_allowed_away' (the version it pays with no longer allows work while its member is
--   away) or 'unavailable' (that kind of login is switched off, or its credential is not active). Null for a worker
--   with no owner's payer.
-- * qorpera_coding_turn_failure(worker, summary): what a failed turn reports. A login that cannot pay comes first (the
--   next turn would fail the same way): reason login_<state> and fixed words the agent can relay, never provider text
--   (a turn whose own run ran keeps the executor's summary after them).
--   Then a run stopped at its login's usage limit (20260930549300's words, pointing at the session's card instead of
--   the conversation's Login menu): reason usage_limit. Then a wake cancelled for its payer's authority:
--   login_unavailable. Otherwise the summary stays and the reason is the failure's own code: the [code=...] of the
--   summary or of the turn's run's last error, else what the turn's rows say (turn_not_begun: no run was asked for;
--   run_not_started: the wake ended without a run; ended_without_submission; stopped; turn_failed).
-- * qorpera_complete_coding_turn: a failed turn reports that summary, its worker result carries the reason (the turn
--   row's outcome.reason, through qorpera_settle_coding_turn) and its `failed` event carries it as `code`.
-- * qorpera_coding_session_view: adds `loginState` and `reason` (the last turn's).
-- * qorpera_list_coding_session_logins(worker) and qorpera_choose_coding_session_login(worker, connection): the
--   session's owner reads which of their logins can pay for it and moves it to one by hand. Never while a turn runs,
--   never to another member's login or a ChatGPT plan, and only to a login that may work while they are away, as the
--   dispatch requires (qorpera_coding_owner_login). The session pays with the binding qorpera_coding_owner_sponsor would
--   find or make for that login (the same client id), at its newest version; the move is the session's event. Nothing
--   moves a session by itself.
--
-- Locks: the choice takes the session's company entry and its worker (qorpera_lock_coding_worker), then its session
-- row, the order every coding writer takes them in; a binding it makes takes that binding's row, as the dispatch's.
-- The reads take none.

set local lock_timeout = '3s';

-- Whether the login a coding session pays with can pay for its next turn (20260930551000): the checks the wake's
-- admission makes for a worker's turn (qorpera_folder_materialize_company), read without its locks.
create function public.qorpera_coding_session_login_state(p_worker public.qorpera_runtime_workers)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930551000.
	select case
		when p_worker.owner_sponsor_binding_id is null then null
		when binding.id is null or binding.status <> 'active' or sponsor.binding_id is null or connection.id is null
			or connection.status = 'revoked' or version.connection_id is null or version.authorization_state = 'revoked'
			then 'removed'
		when connection.status <> 'active' then 'disabled'
		when version.authorization_state <> 'active' then 'needs_sign_in'
		when not sponsor.allow_autonomous or not version.allow_autonomous
			or exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = version.connection_id and newer.version > version.version and not newer.allow_autonomous)
			then 'not_allowed_away'
		when not public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
			or (version.authentication_mode = 'native_subscription' and not exists (select 1
				from public.qorpera_native_credential_capsules as capsule
				where capsule.id = version.credential_capsule_id and capsule.status = 'active'))
			then 'unavailable'
		else 'ready' end
	from (select 1) as one
	left join public.qorpera_execution_sponsor_bindings as binding
		on binding.id = p_worker.owner_sponsor_binding_id and binding.profile_id = p_worker.profile_id
	left join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
		and sponsor.version = public.qorpera_live_sponsor_version(binding.id, p_worker.owner_sponsor_version)
	left join public.qorpera_provider_connections as connection
		on connection.id = sponsor.provider_connection_id and connection.profile_id = p_worker.profile_id
	left join public.qorpera_provider_connection_versions as version
		on version.connection_id = connection.id and version.version = sponsor.provider_connection_version
$$;
revoke all on function public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- What a failed coding turn reports, as {reason, summary} (20260930551000). p_summary is the executor's.
create function public.qorpera_coding_turn_failure(p_worker public.qorpera_runtime_workers, p_summary text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_state text := public.qorpera_coding_session_login_state(p_worker); v_occurrence uuid; v_usage text;
	v_wake public.qorpera_wake_occurrences%rowtype; v_job public.qorpera_runner_jobs%rowtype; v_code text; v_login text;
	-- The same tail for every login reason: the payer never changes without the member (20260930059000).
	v_tail constant text := ' The session does not move to another login by itself: the member who owns it can choose '
		|| 'another of their logins for it on the coding session''s card in the conversation, then ask for the work again.';
begin
	-- 20260930551000.
	select turn.occurrence_id into v_occurrence from public.qorpera_coding_session_turns as turn
	where turn.worker_id = p_worker.id and turn.sequence = p_worker.sequence;
	if v_occurrence is not null then
		select * into v_wake from public.qorpera_wake_occurrences where id = v_occurrence;
		if v_wake.run_id is not null then
			select job.* into v_job from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id where run.id = v_wake.run_id;
		end if;
	end if;
	-- 1. The session's login cannot pay: its next turn would fail the same way, whatever ended this one. A turn whose
	-- own run ran keeps what the executor said of it after the words, when both fit.
	if v_state is not null and v_state <> 'ready' then
		v_login := case v_state
			when 'removed' then 'This coding session''s login was removed (signed out), so its turn could not run.'
			when 'disabled' then 'This coding session''s login was turned off by an owner or admin, so its turn could not run. '
				|| 'It can run again once they turn the login back on.'
			when 'needs_sign_in' then 'This coding session''s login needs a new sign-in, so its turn could not run. '
				|| 'The member can sign in to it again in Settings, AI subscriptions.'
			when 'not_allowed_away' then 'This coding session''s login no longer allows work while its member is away, so its '
				|| 'turn could not run. Once the member allows it again (Settings, AI subscriptions), they can choose it again '
				|| 'for this session on its card.'
			else 'This coding session''s login cannot pay for work right now, so its turn could not run.' end || v_tail;
		if v_wake.run_id is not null and octet_length(v_login || ' The turn''s own report: ' || p_summary) <= 4000 then
			v_login := v_login || ' The turn''s own report: ' || p_summary; end if;
		return jsonb_build_object('reason', 'login_' || v_state, 'summary', v_login);
	end if;
	-- 2. Its run stopped at the login's usage limit (20260930549300): those words, with the session's own place to choose.
	v_usage := public.qorpera_worker_usage_limit_text(v_occurrence);
	if v_usage is not null then
		return jsonb_build_object('reason', 'usage_limit', 'summary', replace(v_usage,
			'choose another of their logins for it (in the conversation''s Login menu)',
			'choose another of their logins for it (on the coding session''s card in the conversation)'));
	end if;
	-- 3. The wake never became a run because its payer had no authority at admission (a race with a sign-in, or a
	-- check the state above does not make): the login is the reason.
	if v_wake.id is not null and v_wake.run_id is null and v_wake.status in ('cancelled', 'failed', 'expired')
		and v_wake.blocked_reason in ('Wake execution authority is unavailable', 'Wake compute authority is unavailable') then
		return jsonb_build_object('reason', 'login_unavailable', 'summary',
			'This coding session''s login cannot pay for work right now, so its turn could not run.' || v_tail);
	end if;
	-- 4. Anything else keeps its summary, with the failure's own code.
	v_code := coalesce(substring(p_summary from '\[code=([A-Za-z0-9_.:-]{1,120})\]'),
		substring(v_job.last_error from '\[code=([A-Za-z0-9_.:-]{1,120})\]'),
		case when v_occurrence is null then 'turn_not_begun'
			when v_wake.run_id is null then 'run_not_started'
			when v_job.status = 'completed' then 'ended_without_submission'
			when v_job.status = 'cancelled' then 'stopped'
			else 'turn_failed' end);
	return jsonb_build_object('reason', v_code, 'summary', p_summary);
end
$$;
revoke all on function public.qorpera_coding_turn_failure(public.qorpera_runtime_workers, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.coding_login_20260930551000_patch(p_function regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare
	v_definition text := pg_get_functiondef(p_function);
	v_count integer := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
begin
	if v_count <> 1 then raise exception '% source differs (anchor matches % times)', p_function, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

-- A second run stops here, before anything changes.
do $$ begin
	if position('20260930551000' in pg_get_functiondef(
			'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure)) > 0
		or position('20260930551000' in pg_get_functiondef(
			'public.qorpera_coding_session_view(public.qorpera_coding_sessions,public.qorpera_runtime_workers)'::regprocedure)) > 0 then
		raise exception 'The coding session login (20260930551000) is already applied'; end if;
end $$;

-- The completion: a failed turn's summary and reason are qorpera_coding_turn_failure's.
select pg_temp.coding_login_20260930551000_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a1$	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb;
$a1$, $r1$	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb; v_failure jsonb;
$r1$);
select pg_temp.coding_login_20260930551000_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a2$	if p_outcome = 'failed' then
		v_summary := coalesce(public.qorpera_worker_usage_limit_text((select turn.occurrence_id
			from public.qorpera_coding_session_turns as turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence)), v_summary);
	end if;
$a2$, $r2$	-- 20260930551000: a login that cannot pay, then the usage limit, say so in plain words with their reason; any
	-- other failure keeps the executor's summary and reports its own code as the reason.
	if p_outcome = 'failed' then
		v_failure := public.qorpera_coding_turn_failure(v_worker, v_summary);
		v_summary := v_failure ->> 'summary';
	end if;
$r2$);
select pg_temp.coding_login_20260930551000_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a3$		|| case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end;
	update public.qorpera_runtime_workers set state = p_outcome, result = v_report,$a3$,
	$r3$		|| case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end
		-- 20260930551000: a failed turn's reason, which the settle trigger copies to the turn's outcome.
		|| case when v_failure is not null then jsonb_build_object('reason', v_failure ->> 'reason') else '{}'::jsonb end;
	update public.qorpera_runtime_workers set state = p_outcome, result = v_report,$r3$);
select pg_temp.coding_login_20260930551000_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a4$		|| case when p_outcome = 'failed' then public.qorpera_coding_turn_usage_limit(v_worker.occurrence_id) else '{}'::jsonb end);$a4$,
	$r4$		|| case when p_outcome = 'failed' then public.qorpera_coding_turn_usage_limit(v_worker.occurrence_id) else '{}'::jsonb end
		-- 20260930551000: and its reason, as `code` (a `reason` here is what the web reads as the executor's own).
		|| case when v_failure is not null then jsonb_build_object('code', v_failure ->> 'reason') else '{}'::jsonb end);$r4$);

-- The view: whether the session's login can pay now, and the last turn's reason.
select pg_temp.coding_login_20260930551000_patch(
	'public.qorpera_coding_session_view(public.qorpera_coding_sessions,public.qorpera_runtime_workers)'::regprocedure,
	$a5$		'busyAt',p_session.busy_at,
$a5$, $r5$		'busyAt',p_session.busy_at,
		-- 20260930551000.
		'loginState',public.qorpera_coding_session_login_state(p_worker),'reason',p_worker.result ->> 'reason',
$r5$);

-- The logins a coding session's owner may move it to: their own active login for the session's harness, in its
-- company, whose newest active version may work while they are away, not a ChatGPT plan (a plan pays for coding only
-- of work started on it, 20260929950000), with that version (20260930551000).
create function public.qorpera_coding_session_login_candidates(p_worker public.qorpera_runtime_workers, p_harness text)
returns table(connection_id uuid, connection_version bigint, provider_account_email text)
language sql stable security definer set search_path = '' as $$
	-- 20260930551000: qorpera_coding_owner_login's logins, all of them, without its order.
	select connection.id, version.version, version.provider_account_email
	from public.qorpera_provider_connections as connection
	cross join lateral (select v.version, v.allow_autonomous, v.authentication_mode, v.native_harness, v.provider_account_email,
			v.credential_capsule_id
		from public.qorpera_provider_connection_versions as v
		where v.connection_id = connection.id and v.authorization_state = 'active'
			and v.native_harness = case p_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end
		order by v.version desc limit 1) as version
	where connection.profile_id = p_worker.profile_id and connection.owner_user_id = p_worker.owner_user_id
		and connection.provider = case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end
		and connection.status = 'active' and version.allow_autonomous
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection.id and newer.version > version.version and not newer.allow_autonomous)
		and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
		and (version.authentication_mode <> 'native_subscription' or exists (select 1
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = version.credential_capsule_id and capsule.status = 'active'))
		and not public.qorpera_connection_is_chatgpt_plan(connection.id)
$$;
revoke all on function public.qorpera_coding_session_login_candidates(public.qorpera_runtime_workers, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The session's owner reads its login and the logins they may move it to (20260930551000).
create function public.qorpera_list_coding_session_logins(p_worker_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_current public.qorpera_execution_sponsor_versions%rowtype; v_state text;
begin
	-- 20260930551000: the owner only (qorpera_coding_session_owner_row checks the caller and the company).
	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	select * into v_current from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_worker.owner_sponsor_binding_id
		and sponsor.version = public.qorpera_live_sponsor_version(v_worker.owner_sponsor_binding_id, v_worker.owner_sponsor_version);
	v_state := public.qorpera_coding_session_login_state(v_worker);
	-- A login is the session's current one only while the session pays with that very version and can: the same login
	-- whose consent came back in a newer version is a choice (moving to it pays with that version).
	return jsonb_build_object('schema', 'qorpera.coding-session-logins/v1', 'workerId', v_worker.id,
		'current', jsonb_build_object('connectionId', v_current.provider_connection_id, 'state', v_state),
		'logins', coalesce((select jsonb_agg(jsonb_build_object('connectionId', candidate.connection_id,
				'email', candidate.provider_account_email, 'current', v_state = 'ready'
					and candidate.connection_id = v_current.provider_connection_id
					and candidate.connection_version = v_current.provider_connection_version)
				order by candidate.connection_id)
			from public.qorpera_coding_session_login_candidates(v_worker, v_session.harness) as candidate), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_coding_session_logins(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_list_coding_session_logins(uuid) to authenticated;

-- The session's owner moves it to another of their logins (20260930551000). Answers the session's view.
create function public.qorpera_choose_coding_session_login(p_worker_id uuid, p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_login record; v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_client uuid; v_current uuid; v_current_version bigint;
begin
	-- 20260930551000.
	if p_connection_id is null then raise exception 'Coding session login is invalid' using errcode = '22023'; end if;
	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);
	-- The owner again, now that the entry holds the owner's member row (as qorpera_archive_coding_session).
	perform public.qorpera_coding_session_owner_row(v_worker.id);
	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker.id for update;
	-- A turn in flight keeps the login it began with: its wake's payer is the worker's (qorpera_folder_wake_authorized).
	if v_session.phase in ('preparing', 'running', 'publishing') or (v_worker.state = 'active' and v_worker.occurrence_id is not null) then
		raise exception 'A coding session keeps its login while a turn runs; choose again when it stops' using errcode = '55000'; end if;
	select * into v_login from public.qorpera_coding_session_login_candidates(v_worker, v_session.harness) as candidate
	where candidate.connection_id = p_connection_id;
	if not found then raise exception 'This login cannot pay for this coding session' using errcode = '22023'; end if;
	select sponsor.provider_connection_id, sponsor.provider_connection_version into v_current, v_current_version
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_worker.owner_sponsor_binding_id
		and sponsor.version = public.qorpera_live_sponsor_version(v_worker.owner_sponsor_binding_id, v_worker.owner_sponsor_version);
	-- Already paying with that very version, and able to: nothing to move (the list calls exactly this one current).
	if v_current = p_connection_id and v_current_version = v_login.connection_version
		and public.qorpera_coding_session_login_state(v_worker) = 'ready' then
		return public.qorpera_coding_session_view(v_session, v_worker); end if;
	-- The binding qorpera_coding_owner_sponsor pays this login with: its active member binding on this version, else
	-- the one it makes under the same client id (so a later dispatch finds the same one).
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_execution_sponsor_bindings as binding on binding.id = sponsor.binding_id
	where binding.profile_id = v_worker.profile_id and binding.status = 'active' and sponsor.sponsor_kind = 'member_connection'
		and sponsor.provider_connection_id = p_connection_id and sponsor.provider_connection_version = v_login.connection_version
		and sponsor.created_by_user_id = v_worker.owner_user_id and sponsor.allow_autonomous
		and sponsor.version = (select max(later.version) from public.qorpera_execution_sponsor_versions as later
			where later.binding_id = binding.id)
	order by sponsor.created_at desc limit 1;
	if v_sponsor.binding_id is null then
		select (left(digest.hex, 8) || '-' || substr(digest.hex, 9, 4) || '-4' || substr(digest.hex, 14, 3) || '-8'
			|| substr(digest.hex, 18, 3) || '-' || substr(digest.hex, 21, 12))::uuid into v_client
		from (select encode(extensions.digest(convert_to('qorpera-coding-owner:' || p_connection_id::text || ':'
			|| v_login.connection_version::text, 'utf8'), 'sha256'), 'hex') as hex) as digest;
		select * into v_binding from public.qorpera_execution_sponsor_bindings
		where profile_id = v_worker.profile_id and client_binding_id = v_client for update;
		if v_binding.id is null then
			insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
			values (v_worker.profile_id, v_client, v_worker.owner_user_id) returning * into v_binding;
		elsif v_binding.created_by_user_id <> v_worker.owner_user_id or v_binding.status <> 'active' then
			raise exception 'This login cannot pay for this coding session' using errcode = '22023'; end if;
		select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_binding.id order by sponsor.version desc limit 1;
		if v_sponsor.binding_id is null or v_sponsor.provider_connection_id <> p_connection_id
			or v_sponsor.provider_connection_version <> v_login.connection_version or not v_sponsor.allow_autonomous then
			insert into public.qorpera_execution_sponsor_versions (binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id)
			values (v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'member_connection', p_connection_id,
				v_login.connection_version, true, v_worker.owner_user_id)
			returning * into v_sponsor;
		end if;
	end if;
	update public.qorpera_runtime_workers set owner_sponsor_binding_id = v_sponsor.binding_id,
		owner_sponsor_version = v_sponsor.version, updated_at = clock_timestamp()
	where id = v_worker.id returning * into v_worker;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'member',
		jsonb_build_object('loginChosen', true, 'text', 'Moved to another login', 'from', v_current, 'to', p_connection_id));
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;
revoke all on function public.qorpera_choose_coding_session_login(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_choose_coding_session_login(uuid, uuid) to authenticated;
