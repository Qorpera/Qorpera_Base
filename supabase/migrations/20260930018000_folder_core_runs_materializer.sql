-- Company folder core, C4 (P28 part 1): runs on folder-v2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-RUNS.md).
--
-- Until now nothing turned a folder-v2 company's work into runs: creation writes the Co-Founder's kickoff and its turn
-- request, and posts, coworker messages and routine firing insert queued wakes, but the materializers inside the single
-- reconcile RPC skip folder-v2 (they take the company row FOR UPDATE NOWAIT and the Company File row, need a substrate,
-- and admit many companies in one transaction). Here folder-v2 gets its own materializer, one company per transaction:
-- * Jobs and runs no longer require a substrate or snapshot. A run carries company_seq instead: the folder clock's
--   last_seq when it was materialized (core §6, "The pin"). A run has exactly one of the two pins.
-- * qorpera_folder_materialize_due(after, limit): the folder-v2 companies with due work (a queued turn request whose
--   conversation is open and whose input is pending, or a queued wake that is due), not paused and not at zero hours,
--   paged by company id, without a lock. Service role.
-- * qorpera_folder_materialize_company(profile, limit): one company, in the caller's transaction, in core §3's order:
--   the folder fence KEY SHARE with the pause read again and the company row KEY SHARE (rank 0); the requesters, the
--   agents and their execution authorities KEY SHARE (ranks 1 to 3), a room wake's room FOR SHARE (rank 4, as posting
--   takes it), a routine wake's routine FOR NO KEY UPDATE (rank 5, as firing); then the work rows FOR UPDATE SKIP
--   LOCKED; the model logins (connections, then their versions) FOR UPDATE and the compute identities FOR SHARE NOWAIT,
--   as the reservation and the identity check take them; the conversations FOR UPDATE and the turn inputs FOR UPDATE,
--   in id order; then each item in its own subtransaction: the legacy checks, the job and run (no substrate,
--   company_seq), the reservation, the input claimed and its transcript events (the operation clock), admission, and
--   the run's queued event (whose trigger inserts a turn's first-run or human wake under that admission). A refusal
--   marks the item as the legacy materializers did; a stop that commits meanwhile leaves the item queued. Service role.
-- * The runner broker's folder-v2 description adds the run's company_seq.
-- The runner-orchestrator edge function gets the actions `folder_materialize_due` and `folder_materialize_company`, and
-- the orchestrator's reconcile lane calls them on every pass, one company per request. The legacy materializers are
-- left as they are (they skip folder-v2) until the cleanup pass removes them. Each inserted text names this migration
-- (20260930018000), for deploy guards.

set local lock_timeout = '3s';

-- 1. Runs without a snapshot --------------------------------------------------------------------------------------

alter table public.qorpera_runner_jobs alter column substrate_version_id drop not null;
alter table public.qorpera_execution_runs alter column substrate_version_id drop not null,
	alter column company_snapshot_id drop not null,
	add column company_seq bigint check (company_seq >= 0);
-- A snapshot-v1 run pins its substrate and snapshot; a folder-v2 run pins the folder clock.
alter table public.qorpera_execution_runs add constraint qorpera_execution_runs_company_pin check (
	(substrate_version_id is null) = (company_snapshot_id is null) and num_nonnulls(company_snapshot_id, company_seq) = 1);

-- 2. The companies with due work -----------------------------------------------------------------------------------

create function public.qorpera_folder_materialize_due(p_after_profile_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid; v_has_more boolean; v_now timestamptz := clock_timestamp();
begin
	-- 20260930018000: folder core C4 (P28).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Run materialization requires control-plane authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Run materialization page limit is invalid' using errcode = '22023'; end if;
	with due as (
		select request.profile_id from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		join public.qorpera_session_inputs as input on input.id = request.input_id and input.session_id = request.session_id
		where request.status = 'queued' and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
		union
		select wake.profile_id from public.qorpera_wake_occurrences as wake
		where wake.status = 'queued' and wake.not_before <= v_now
	), page as (
		select due.profile_id from due
		join public.qorpera_company_files as file on file.profile_id = due.profile_id and file.core = 'folder-v2'
		where (p_after_profile_id is null or due.profile_id > p_after_profile_id)
			and not public.qorpera_company_execution_paused(due.profile_id)
			and not public.qorpera_company_at_zero(due.profile_id, v_now)
		order by due.profile_id
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

-- 3. One company's runs ---------------------------------------------------------------------------------------------

create function public.qorpera_folder_materialize_company(p_profile_id uuid, p_limit integer default 16)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_env uuid; v_now timestamptz := clock_timestamp();
	v_request_ids uuid[]; v_wake_ids uuid[]; v_targets jsonb; v_locked_requests uuid[]; v_locked_wakes uuid[];
	v_identity uuid; v_unavailable uuid[] := '{}'::uuid[]; v_seq bigint;
	v_request public.qorpera_session_turn_requests%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_session public.qorpera_shared_sessions%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_compute public.qorpera_member_compute_identities%rowtype; v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_payload jsonb; v_capability text; v_job_type text; v_publication text; v_review text; v_reviewers uuid[];
	v_compute_id uuid; v_mode text; v_worker_class text; v_sequence bigint; v_claimed integer; v_reason text;
	v_runs uuid[] := '{}'::uuid[]; v_failed integer := 0; v_cancelled integer := 0; v_blocked integer := 0;
	v_skipped integer := 0;
begin
	-- 20260930018000: folder core C4 (P28).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Run materialization requires control-plane authority' using errcode = '42501'; end if;
	if p_profile_id is null or p_limit is null or p_limit not between 1 and 16 then
		raise exception 'Run materialization is invalid' using errcode = '22023'; end if;
	select environment_id into v_env from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2';
	if not found then return jsonb_build_object('state', 'not_folder'); end if;
	if public.qorpera_company_execution_paused(p_profile_id) then return jsonb_build_object('state', 'paused'); end if;
	if public.qorpera_company_at_zero(p_profile_id, v_now) then return jsonb_build_object('state', 'at_zero'); end if;

	-- The work, oldest scan first, read without a lock: it names the rows to lock in rank order.
	v_request_ids := array(select request.id from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
			and session.environment_id = v_env
		join public.qorpera_session_inputs as input on input.id = request.input_id and input.session_id = request.session_id
		where request.profile_id = p_profile_id and request.status = 'queued' and input.completed_at is null
			and input.failed_at is null and input.execution_run_id is null and input.turn_id is null
		order by request.admission_scan_at, request.created_at, request.id limit p_limit);
	v_wake_ids := array(select wake.id from public.qorpera_wake_occurrences as wake
		where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.not_before <= v_now
		order by wake.admission_scan_at, wake.not_before, wake.created_at, wake.id
		limit p_limit - cardinality(v_request_ids));
	if cardinality(v_request_ids) + cardinality(v_wake_ids) = 0 then return jsonb_build_object('state', 'idle'); end if;

	-- Ranks 1 to 5: the requesters, the agents and their execution authorities KEY SHARE; a room wake's room FOR SHARE
	-- (a group chat's save takes it FOR NO KEY UPDATE first, as for a post); a routine wake's routine FOR NO KEY UPDATE
	-- (the wake's status trigger updates its authorization count, as routine firing locks it).
	select coalesce(jsonb_agg(t), '[]'::jsonb) into v_targets from (
		select jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', p_profile_id::text || ':' || request.requested_by_user_id::text, 'mode', 'keyshare') as t
		from public.qorpera_session_turn_requests as request where request.id = any(v_request_ids)
		union all
		select jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', p_profile_id::text || ':' || session.staff_agent_id, 'mode', 'keyshare')
		from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id
		where request.id = any(v_request_ids)
			and session.staff_agent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		union all
		select x.t from public.qorpera_wake_occurrences as wake, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', p_profile_id::text || ':' || wake.requested_by_user_id::text, 'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
				'key', p_profile_id::text || ':' || wake.staff_agent_id::text, 'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', p_profile_id::text || ':' || wake.staff_agent_id::text, 'mode', 'keyshare'))) as x(t)
		where wake.id = any(v_wake_ids) and wake.requested_by_user_id is not null and wake.staff_agent_id is not null
		union all
		select jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', room.id::text, 'mode', 'share')
		from public.qorpera_wake_occurrences as wake
		join public.qorpera_company_rooms as room on room.session_id = wake.session_id and room.profile_id = p_profile_id
		where wake.id = any(v_wake_ids) and wake.wake_kind = 'room'
		union all
		select jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', wake.routine_id::text, 'mode', 'nokeyupdate')
		from public.qorpera_wake_occurrences as wake where wake.id = any(v_wake_ids) and wake.routine_id is not null
	) as targets;
	-- The fence KEY SHARE with the pause read again, the company row KEY SHARE, then the ranks. A stop that committed
	-- its pause meanwhile answers paused.
	begin
		perform public.qorpera_folder_company_enter(v_env, p_profile_id, v_targets, true);
	exception when sqlstate '55000' then
		return jsonb_build_object('state', 'paused');
	end;

	-- The work rows, after the ranks: a row another materializer holds is its work this pass. Each scanned row moves
	-- to the back of the scan order, so a row that waits never starves the others.
	v_locked_requests := array(select request.id from public.qorpera_session_turn_requests as request
		where request.id = any(v_request_ids) and request.status = 'queued' order by request.id for update skip locked);
	v_locked_wakes := array(select wake.id from public.qorpera_wake_occurrences as wake
		where wake.id = any(v_wake_ids) and wake.status = 'queued' order by wake.id for update skip locked);
	update public.qorpera_session_turn_requests set admission_scan_at = clock_timestamp() where id = any(v_locked_requests);
	update public.qorpera_wake_occurrences set admission_scan_at = clock_timestamp() where id = any(v_locked_wakes);

	-- The model logins, as the reservation locks them (connections, then their versions, FOR UPDATE), then the compute
	-- identities FOR SHARE NOWAIT (one that is busy or recovering leaves its items queued).
	perform 1 from public.qorpera_provider_connections as connection
	where connection.profile_id = p_profile_id and connection.id in (select sponsor.provider_connection_id
		from public.qorpera_execution_sponsor_versions as sponsor
		where (sponsor.binding_id, sponsor.version) in (
			select request.sponsor_binding_id, request.sponsor_version from public.qorpera_session_turn_requests as request
			where request.id = any(v_locked_requests)
			union select wake.sponsor_binding_id, wake.sponsor_version from public.qorpera_wake_occurrences as wake
			where wake.id = any(v_locked_wakes)))
	order by connection.id for update;
	perform 1 from public.qorpera_provider_connection_versions as version
	where (version.connection_id, version.version) in (select sponsor.provider_connection_id, sponsor.provider_connection_version
		from public.qorpera_execution_sponsor_versions as sponsor
		join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
			and connection.profile_id = p_profile_id
		where (sponsor.binding_id, sponsor.version) in (
			select request.sponsor_binding_id, request.sponsor_version from public.qorpera_session_turn_requests as request
			where request.id = any(v_locked_requests)
			union select wake.sponsor_binding_id, wake.sponsor_version from public.qorpera_wake_occurrences as wake
			where wake.id = any(v_locked_wakes)))
	order by version.connection_id, version.version for update;
	for v_identity in
		select distinct identity_id from (
			select request.compute_identity_id as identity_id from public.qorpera_session_turn_requests as request
			where request.id = any(v_locked_requests)
			union all
			select coalesce(capsule.compute_identity_id, computer.compute_identity_id)
			from public.qorpera_wake_occurrences as wake
			join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = wake.sponsor_binding_id
				and sponsor.version = wake.sponsor_version
			join public.qorpera_provider_connection_versions as version on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			left join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
				and capsule.status = 'active'
			left join public.qorpera_logical_computers as computer on computer.id = wake.logical_computer_id
			where wake.id = any(v_locked_wakes)) as identities
		where identity_id is not null order by identity_id
	loop
		if not public.qorpera_try_lock_execution_identity(p_profile_id, v_identity) then
			v_unavailable := v_unavailable || v_identity; end if;
	end loop;

	-- The conversations FOR UPDATE, then the turn inputs FOR UPDATE, in id order, before any write to them.
	perform 1 from public.qorpera_shared_sessions as session
	where session.id in (select request.session_id from public.qorpera_session_turn_requests as request
			where request.id = any(v_locked_requests)
		union select wake.session_id from public.qorpera_wake_occurrences as wake where wake.id = any(v_locked_wakes))
	order by session.id for update;
	perform 1 from public.qorpera_session_inputs as input
	where input.id in (select request.input_id from public.qorpera_session_turn_requests as request
		where request.id = any(v_locked_requests))
	order by input.id for update;
	v_seq := (select clock.last_seq from public.qorpera_folder_clocks as clock where clock.environment_id = v_env);

	-- Turn requests (a first run's, and a conversation's once it has a folder-v2 path): the legacy turn materializer's
	-- checks and refusals.
	for v_request in select * from public.qorpera_session_turn_requests where id = any(v_locked_requests)
		order by admission_scan_at, created_at, id
	loop
		begin
			select * into v_session from public.qorpera_shared_sessions where id = v_request.session_id;
			select * into v_input from public.qorpera_session_inputs where id = v_request.input_id;
			-- One turn at a time per conversation, in request order; an input that moved on is not this request's.
			if v_session.status <> 'open' or v_input.session_id is distinct from v_session.id
				or v_input.completed_at is not null or v_input.failed_at is not null
				or v_input.execution_run_id is not null or v_input.turn_id is not null
				or exists (select 1 from public.qorpera_session_turn_requests as earlier
					join public.qorpera_session_inputs as earlier_input on earlier_input.id = earlier.input_id
					where earlier.session_id = v_request.session_id and earlier.status = 'queued'
						and (earlier.created_at, earlier.id) < (v_request.created_at, v_request.id)
						and earlier_input.completed_at is null and earlier_input.failed_at is null
						and earlier_input.execution_run_id is null and earlier_input.turn_id is null)
				or exists (select 1 from public.qorpera_execution_runs as run
					join public.qorpera_runner_jobs as job on job.id = run.job_id
					where run.session_id = v_session.id and run.source_kind = 'session_turn' and job.status in ('queued', 'leased'))
				or v_request.compute_identity_id = any(v_unavailable) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_reason := null;
			select * into v_staff from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id::text = v_session.staff_agent_id
				and staff.employment_status = 'active';
			if not exists (select 1 from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id and member.user_id = v_request.requested_by_user_id
					and member.role in ('owner', 'admin', 'contributor')
					and (v_session.audience_kind = 'company'
						or (v_session.audience_kind = 'member_private' and v_session.audience_user_id = v_request.requested_by_user_id)))
				or v_input.author_user_id is distinct from v_request.requested_by_user_id then
				v_reason := 'The input author no longer has session write access';
			elsif v_staff.staff_agent_id is null then
				v_reason := 'The agent is no longer available';
			end if;
			if v_reason is null then
				select * into v_binding from public.qorpera_execution_sponsor_bindings as binding
				where binding.id = v_request.sponsor_binding_id and binding.profile_id = p_profile_id and binding.status = 'active';
				select * into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
				where sponsor.binding_id = v_request.sponsor_binding_id and sponsor.version = v_request.sponsor_version;
				select * into v_connection from public.qorpera_provider_connections as connection
				where connection.id = v_sponsor.provider_connection_id and connection.profile_id = p_profile_id
					and connection.status = 'active';
				select * into v_connection_version from public.qorpera_provider_connection_versions as version
				where version.connection_id = v_sponsor.provider_connection_id and version.version = v_sponsor.provider_connection_version
					and version.authorization_state = 'active';
				v_compute := null;
				if v_request.compute_identity_id is not null then
					select * into v_compute from public.qorpera_member_compute_identities as identity
					where identity.id = v_request.compute_identity_id and identity.profile_id = p_profile_id
						and identity.status = 'active';
				end if;
				if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
					or v_connection_version.connection_id is null
					or not public.qorpera_sponsor_serves_requester(p_profile_id, v_request.sponsor_binding_id,
						v_request.sponsor_version, v_request.requested_by_user_id)
					or (v_request.sponsor_mode in ('member_connection', 'sponsorship_request') and (
						v_sponsor.sponsor_kind <> 'member_connection'
						or v_connection.owner_user_id is distinct from v_request.sponsored_by_user_id
						or v_compute.ownership_kind <> 'member'
						or v_compute.owner_user_id is distinct from v_request.sponsored_by_user_id
						or not exists (select 1 from public.qorpera_profile_members as member
							where member.profile_id = p_profile_id and member.user_id = v_request.sponsored_by_user_id)))
					or (v_request.sponsor_mode = 'company_connection' and (v_sponsor.sponsor_kind = 'member_connection'
						or v_compute.id is null or v_compute.ownership_kind = 'member'))
					or (v_request.logical_computer_id is not null and not exists (
						select 1 from public.qorpera_logical_computers as computer
						where computer.id = v_request.logical_computer_id and computer.profile_id = p_profile_id
							and computer.status = 'active' and computer.computer_class = v_request.worker_class
							and computer.compute_identity_id is not distinct from v_request.compute_identity_id
							and computer.capabilities ? v_request.required_capability)) then
					v_reason := 'The selected execution sponsor or computer is no longer available';
				elsif v_connection_version.authentication_mode = 'native_subscription' then
					select * into v_capsule from public.qorpera_native_credential_capsules as capsule
					where capsule.id = v_connection_version.credential_capsule_id
						and capsule.compute_identity_id = v_request.compute_identity_id
						and capsule.ownership_kind = v_compute.ownership_kind
						and capsule.owner_user_id is not distinct from v_compute.owner_user_id
						and capsule.owner_scope_key is not distinct from v_compute.owner_scope_key
						and capsule.status = 'active';
					if v_capsule.id is null or not public.qorpera_provider_execution_enabled(
						v_connection.provider, 'native_subscription', v_connection_version.native_harness) then
						v_reason := 'The selected native provider connection is not enabled';
					end if;
				end if;
			end if;
			if v_reason is not null then
				update public.qorpera_session_turn_requests set status = 'failed', failure_reason = v_reason where id = v_request.id;
				update public.qorpera_session_inputs set failed_at = statement_timestamp(), failure_reason = v_reason
				where id = v_input.id;
				v_failed := v_failed + 1;
				continue;
			end if;
			v_payload := jsonb_build_object('schema', 'qorpera.sponsored-session-turn/v1', 'turn_request_id', v_request.id,
				'session_id', v_session.id, 'input_ids', jsonb_build_array(v_input.id),
				'requested_by_user_id', v_request.requested_by_user_id, 'sponsored_by_user_id', v_request.sponsored_by_user_id,
				'sponsor_mode', v_request.sponsor_mode, 'compute_identity_id', v_request.compute_identity_id,
				'worker_class', v_request.worker_class);
			insert into public.qorpera_runner_jobs(profile_id, environment_id, session_id, client_job_id, required_capability,
				job_type, payload, created_by_user_id)
			values (p_profile_id, v_env, v_session.id, v_request.id, v_request.required_capability, v_request.job_type, v_payload,
				v_request.requested_by_user_id)
			returning * into v_job;
			insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
				company_seq, staff_agent_id, staff_version, input_ids, sponsor_binding_id, sponsor_version, required_capability,
				job_type, payload_sha256, publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
				compute_identity_id, worker_class, requested_by_user_id, sponsored_by_user_id, transcript_start_sequence,
				created_by_user_id)
			values (v_request.id, p_profile_id, v_env, 'session_turn', v_request.id, v_session.id, v_job.id, v_seq,
				v_staff.staff_agent_id, v_staff.version, array[v_input.id], v_request.sponsor_binding_id, v_request.sponsor_version,
				v_request.required_capability, v_request.job_type,
				encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex'),
				v_request.publication_mode, v_request.review_policy_key, v_request.reviewer_staff_ids,
				v_request.logical_computer_id, v_request.compute_identity_id, v_request.worker_class,
				v_request.requested_by_user_id, v_request.sponsored_by_user_id,
				(select coalesce(max(event.sequence), 0) from public.qorpera_session_events as event
					where event.session_id = v_session.id),
				v_request.requested_by_user_id)
			returning * into v_run;
			update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
			if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
				-- A refusal after the item's writes (QFM01): the subtransaction is undone and the item marked.
				raise exception 'The selected sponsor quota or model authority is unavailable' using errcode = 'QFM01';
			end if;
			update public.qorpera_session_inputs set execution_run_id = v_run.id
			where id = v_input.id and execution_run_id is null and turn_id is null and completed_at is null and failed_at is null;
			get diagnostics v_claimed = row_count;
			if v_claimed <> 1 then raise exception 'The turn input changed under its lock' using errcode = 'XX000'; end if;
			-- The transcript events take the operation clock; admission comes after it, last.
			v_sequence := public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);
			update public.qorpera_execution_runs set transcript_start_sequence = v_sequence where id = v_run.id;
			update public.qorpera_session_turn_requests set status = 'materialized', run_id = v_run.id,
				materialized_at = statement_timestamp()
			where id = v_request.id;
			update public.qorpera_shared_sessions set staff_version = v_staff.version where id = v_session.id;
			if current_setting('qorpera.folder_wake_admission', true) is distinct from p_profile_id::text then
				perform public.qorpera_folder_admit_wakes(p_profile_id); end if;
			-- Its trigger inserts the turn's first-run or human wake, under the admission above.
			insert into public.qorpera_execution_run_events(run_id, event_type, payload)
			values (v_run.id, 'queued', jsonb_build_object('input_count', 1, 'turn_request_id', v_request.id,
				'requested_by_user_id', v_request.requested_by_user_id, 'sponsored_by_user_id', v_request.sponsored_by_user_id,
				'sponsor_binding_id', v_request.sponsor_binding_id, 'sponsor_version', v_request.sponsor_version));
			v_runs := v_runs || v_run.id;
		exception
			-- A stop or zero hours that arrived meanwhile, or a busy row: the request stays queued.
			when sqlstate '55000' or lock_not_available then
				v_skipped := v_skipped + 1;
			-- The run's own refusals (no model authority, the payer, the audience, a first run already woken) end it.
			when sqlstate 'QFM01' or sqlstate '42501' or sqlstate '23505' or sqlstate 'P0002' then
				v_reason := case when sqlstate = 'QFM01' then sqlerrm else left('The run could not start: ' || sqlerrm, 1000) end;
				update public.qorpera_session_turn_requests set status = 'failed', failure_reason = v_reason where id = v_request.id;
				update public.qorpera_session_inputs set failed_at = statement_timestamp(), failure_reason = v_reason
				where id = v_request.input_id;
				v_failed := v_failed + 1;
		end;
	end loop;

	-- Queued wakes (room posts, coworker messages, routines): the legacy wake materializer's checks and refusals.
	for v_wake in select * from public.qorpera_wake_occurrences where id = any(v_locked_wakes)
		order by admission_scan_at, not_before, created_at, id
	loop
		begin
			if v_wake.wake_kind not in ('routine', 'agent', 'room') or not public.qorpera_wake_authorized(v_wake) then
				update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
					blocked_reason = 'Wake recipient or source authority is unavailable' where id = v_wake.id;
				v_cancelled := v_cancelled + 1;
				continue;
			end if;
			v_capability := 'agent_turn'; v_job_type := 'agent_turn';
			v_publication := 'automatic'; v_review := null; v_reviewers := '{}'::uuid[];
			if v_wake.wake_kind = 'routine' then
				select * into strict v_version from public.qorpera_cloud_routine_versions
				where routine_id = v_wake.routine_id and version = v_wake.routine_version;
				v_capability := v_version.required_capability; v_job_type := v_version.job_type;
				v_publication := v_version.publication_mode; v_review := v_version.review_policy_key;
				v_reviewers := v_version.reviewer_staff_ids;
			elsif v_wake.source_kind in ('worker-dispatch', 'worker-completion') then
				-- Continuing protected work cannot downgrade its publication policy.
				select required_capability, job_type, publication_mode, review_policy_key, reviewer_staff_ids
				into strict v_capability, v_job_type, v_publication, v_review, v_reviewers
				from public.qorpera_execution_runs where id = v_wake.parent_run_id;
			end if;
			if not exists (select 1 from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
					and sponsor.version = v_wake.sponsor_version
				join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
				where binding.id = v_wake.sponsor_binding_id and binding.profile_id = p_profile_id and binding.status = 'active'
					and (v_wake.wake_kind = 'room' or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority(
						sponsor.provider_connection_id, sponsor.provider_connection_version)))
					and connection.profile_id = p_profile_id and connection.status = 'active') then
				update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
					blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
				v_cancelled := v_cancelled + 1;
				continue;
			end if;
			if v_wake.logical_computer_id is not null and not exists (select 1 from public.qorpera_logical_computers
				where id = v_wake.logical_computer_id and profile_id = p_profile_id and status = 'active'
					and capabilities ? v_capability) then
				update public.qorpera_wake_occurrences set blocked_reason = 'Pinned computer is unavailable' where id = v_wake.id;
				v_blocked := v_blocked + 1;
				continue;
			end if;
			-- Compute from the authorized sponsor's capsule; the native provenance trigger verifies ownership.
			select capsule.compute_identity_id, version.authentication_mode into v_compute_id, v_mode
			from public.qorpera_execution_sponsor_versions as sponsor
			join public.qorpera_provider_connection_versions as version on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			left join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
				and capsule.status = 'active'
			where sponsor.binding_id = v_wake.sponsor_binding_id and sponsor.version = v_wake.sponsor_version;
			v_worker_class := 'managed_sandbox';
			if v_wake.logical_computer_id is not null then
				select computer_class into v_worker_class from public.qorpera_logical_computers
				where id = v_wake.logical_computer_id and (v_compute_id is null or compute_identity_id = v_compute_id);
				if v_compute_id is null then
					select compute_identity_id into v_compute_id from public.qorpera_logical_computers
					where id = v_wake.logical_computer_id;
				end if;
			end if;
			if (v_mode = 'native_subscription' and v_compute_id is null) or v_worker_class is null then
				update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
					blocked_reason = 'Wake compute authority is unavailable' where id = v_wake.id;
				v_cancelled := v_cancelled + 1;
				continue;
			end if;
			if v_compute_id = any(v_unavailable) then
				update public.qorpera_wake_occurrences set blocked_reason = 'Compute identity is unavailable or recovering'
				where id = v_wake.id;
				v_blocked := v_blocked + 1;
				continue;
			end if;
			-- A room post's transcript events were appended when it was posted (C1c-3a).
			v_payload := jsonb_build_object('schema', 'qorpera.wake-run/v1', 'occurrenceId', v_wake.id);
			insert into public.qorpera_runner_jobs(profile_id, environment_id, session_id, client_job_id, required_capability,
				job_type, payload, created_by_user_id)
			values (p_profile_id, v_env, v_wake.session_id, extensions.gen_random_uuid(), v_capability, v_job_type, v_payload,
				v_wake.requested_by_user_id)
			returning * into v_job;
			insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
				company_seq, staff_agent_id, staff_version, input_ids, sponsor_binding_id, sponsor_version, required_capability,
				job_type, payload_sha256, publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
				compute_identity_id, worker_class, transcript_start_sequence, created_by_user_id)
			values (v_job.client_job_id, p_profile_id, v_env,
				case when v_wake.wake_kind = 'room' then 'room_delivery' else 'wake' end, v_wake.id, v_wake.session_id, v_job.id,
				v_seq, v_wake.staff_agent_id,
				-- A wake that waited through an edit is this agent's next run and takes the current version.
				(select staff.version from public.qorpera_profile_staff as staff
					where staff.profile_id = p_profile_id and staff.staff_agent_id = v_wake.staff_agent_id),
				'{}'::uuid[], v_wake.sponsor_binding_id, v_wake.sponsor_version, v_capability, v_job_type,
				encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex'),
				v_publication, v_review, v_reviewers, v_wake.logical_computer_id, v_compute_id, v_worker_class,
				(select coalesce(max(event.sequence), 0) from public.qorpera_session_events as event
					where event.session_id = v_wake.session_id),
				v_wake.requested_by_user_id)
			returning * into v_run;
			update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
			if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
				raise exception 'Execution sponsor authority or quota is unavailable' using errcode = 'QFM01';
			end if;
			update public.qorpera_wake_occurrences set status = 'materialized', run_id = v_run.id, blocked_reason = null
			where id = v_wake.id;
			if current_setting('qorpera.folder_wake_admission', true) is distinct from p_profile_id::text then
				perform public.qorpera_folder_admit_wakes(p_profile_id); end if;
			insert into public.qorpera_execution_run_events(run_id, event_type) values (v_run.id, 'queued');
			v_runs := v_runs || v_run.id;
		exception
			when sqlstate '55000' or lock_not_available then
				v_skipped := v_skipped + 1;
			-- A quota that is full waits; the run's own refusals (no model authority, the payer, the audience) end it.
			when sqlstate 'QFM01' then
				update public.qorpera_wake_occurrences set blocked_reason = sqlerrm where id = v_wake.id;
				v_blocked := v_blocked + 1;
			when sqlstate '42501' or sqlstate '23505' or sqlstate 'P0002' then
				update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
					blocked_reason = left('The run could not start: ' || sqlerrm, 1000) where id = v_wake.id;
				v_cancelled := v_cancelled + 1;
		end;
	end loop;
	return jsonb_build_object('state', 'done', 'run_ids', to_jsonb(v_runs), 'failed', v_failed, 'cancelled', v_cancelled,
		'blocked', v_blocked, 'skipped', v_skipped);
end $$;

revoke all on function public.qorpera_folder_materialize_due(uuid, integer) from public, anon, authenticated;
revoke all on function public.qorpera_folder_materialize_company(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_folder_materialize_due(uuid, integer) to service_role;
grant execute on function public.qorpera_folder_materialize_company(uuid, integer) to service_role;

-- 4. The broker's description carries the pin -------------------------------------------------------------------------

do $$
declare v_target constant regprocedure := 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)';
	v_definition text := pg_get_functiondef(v_target);
	c_old constant text := $old$'run', public.qorpera_execution_run_json(v_run) || jsonb_build_object('substrate_version_id', null, 'company_snapshot_id', null),$old$;
	c_new constant text := $new$-- 20260930018000 (P28): the run's folder pin.
		'run', public.qorpera_execution_run_json(v_run) || jsonb_build_object('substrate_version_id', null, 'company_snapshot_id', null,
			'company_seq', v_run.company_seq),$new$;
begin
	if (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old) <> 1 then
		raise exception 'P28 patch anchor not found in %', v_target; end if;
	execute replace(v_definition, c_old, c_new);
end $$;
