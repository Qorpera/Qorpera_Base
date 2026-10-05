-- Company folder core, C1c-3l part 2 (the coordinator's audit P06c): the office-activation wake on folder-v2. Once an
-- agent's start has brought the Company Computer up, a wake continues the agent's work (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-C1C.md §6.18; plan outputs/company-accounts/p06-office-folder-v2-plan.md). Builds on C1c-3l
-- part 1 (20260930030000).
--
-- Folder-v2 only (the founder's decision of 3 October): each patch is a folder-v2 branch or removes a folder-v2 refusal;
-- the statement that was there before stays untouched in its else.
-- * The drain: qorpera_folder_office_wakes_due and qorpera_folder_office_wakes_company, a pair in the shared
--   folder-drains step's shape (P29a, RUNTIME-COMPANY-FOLDER-LISTENER.md §9). A waiter is due once its start's turn has
--   ended and it can be delivered or must be cancelled (qorpera_folder_office_waiter_due). One company per request, in
--   its own transaction with a 2 s lock budget: the waiters' requesters, agents and execution authorities KEY SHARE
--   behind the folder fence and the company row (folder_company_enter), the waiters FOR UPDATE SKIP LOCKED, the
--   admission, then the wakes. A pause seen at any point leaves the waiter waiting. No computer row is locked: the wake's
--   authority is read again at materialization and on every tool call of the woken run. Since P28a nothing calls the
--   old drain (qorpera_drain_office_activation_wakes), which stays for the legacy removal.
-- * qorpera_folder_office_waiter_authorized(waiter): the waiter's authority as plain reads. qorpera_office_waiter_authorized
--   answers it on folder-v2 instead of taking the company row and every row NOWAIT, which would turn a screen heartbeat
--   (the computer FOR UPDATE) into a refused tool call of the woken run.
-- * The 'office-activation' source leaves the folder-v2 refusal lists of qorpera_pin_wake_occurrence (0A000),
--   qorpera_folder_wake_authorized and qorpera_folder_run_resolve (0A000); qorpera_folder_wake_authorized checks an
--   office-activation wake's ancestry. Each list is found by its own opening and its own raise or return; only the
--   'office-activation' token and its comma go, and a list left empty drops its whole statement. So 3i-b's
--   'machine-event' edit of the same lists (S3, 20260930058000) applies cleanly in either order.
--
-- Each patched function and new function names this migration (20260930030100) in its body, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.c1c3l2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3l part 2 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The waiter's authority as plain reads -----------------------------------------------------------------------------

create function public.qorpera_folder_office_waiter_authorized(p_waiter public.qorpera_runtime_office_start_waiters)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
	v_intent public.qorpera_runtime_office_start_intents%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_job_status text; v_parent_wake public.qorpera_wake_occurrences%rowtype;
begin
	-- C1c-3l (20260930030100): the checks of qorpera_office_waiter_authorized, read without a lock (folder-v2).
	select * into v_parent from public.qorpera_execution_runs where id = p_waiter.parent_run_id;
	if not found then return false; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents where id = p_waiter.intent_id;
	select status into v_job_status from public.qorpera_runner_jobs where id = v_parent.job_id;
	select * into v_office from public.qorpera_runtime_offices where id = v_intent.office_id;
	if v_office.id is null or v_intent.state <> 'reserved'
		or v_office.state <> 'active' or v_office.generation <> v_intent.computer_generation
		or v_office.image_sha256 <> v_intent.image_sha256 or v_office.bootstrap_sha256 <> v_intent.bootstrap_sha256
		or v_parent.profile_id <> v_office.profile_id or v_parent.environment_id <> v_office.environment_id
		or v_parent.audience_kind <> 'company' or v_parent.audience_user_id is not null
		or v_job_status is distinct from 'completed' or v_parent.staff_version <> p_waiter.staff_version
		or p_waiter.state = 'cancelled' or public.qorpera_company_execution_paused(v_parent.profile_id) then return false; end if;
	-- Bound repeated revivals, as the locked check does.
	if exists (with recursive ancestry(run_id, depth) as (
		select v_parent.id, 1 union all select w.parent_run_id, a.depth + 1 from ancestry a
		join public.qorpera_wake_occurrences w on w.run_id = a.run_id
		where w.source_kind = 'office-activation' and a.depth < 9
	) select 1 from ancestry where depth = 9) then return false; end if;
	select * into v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	if not found or public.qorpera_runtime_wake_policy_internal(v_parent.id) ->> 'kind' is distinct from v_parent_wake.wake_kind
		or not public.qorpera_wake_authorized(v_parent_wake) then return false; end if;
	return exists (select 1 from public.qorpera_profile_staff where profile_id = v_parent.profile_id
			and staff_agent_id = v_parent.staff_agent_id and version >= p_waiter.staff_version and employment_status = 'active')
		and exists (select 1 from public.qorpera_profile_members where profile_id = v_parent.profile_id
			and user_id = v_parent.requested_by_user_id)
		and exists (select 1 from public.qorpera_runtime_office_access where office_id = v_office.id and profile_id = v_parent.profile_id
			and staff_agent_id = v_parent.staff_agent_id and grant_id = p_waiter.grant_id and version = p_waiter.grant_version
			and state = 'active')
		and exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_intent.allocation_id and office_id = v_office.id
			and profile_id = v_office.profile_id and computer_generation = v_office.generation and released_at is null
			and instance_sha256 = v_intent.instance_sha256 and provider_adapter = 'lxd')
		and exists (select 1 from public.qorpera_logical_computers computer where id = v_office.logical_computer_id
			and status = 'active' and public.qorpera_runtime_office_matches(computer))
		and exists (select 1 from public.qorpera_company_files where environment_id = v_office.environment_id
			and profile_id = v_office.profile_id and state = 'ready' and core = 'folder-v2')
		and exists (select 1 from public.qorpera_runtime_office_activations where intent_id = v_intent.id
			and office_id = v_office.id and computer_generation = v_office.generation and state = 'active' and superseded_at is null
			and allocation_id = v_intent.allocation_id and instance_sha256 = v_intent.instance_sha256
			and provider_binding_sha256 = v_intent.provider_binding_sha256)
		and exists (select 1 from public.qorpera_run_operation_receipts where id = p_waiter.receipt_id
			and run_id = v_parent.id and status = 'completed' and operation_kind = 'cloud_tool'
			and logical_operation_key like 'computer_start:%' and not requires_company_revision)
		and not exists (select 1 from public.qorpera_run_operation_receipts where run_id = v_parent.id
			and (status <> 'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
				-- A folder-v2 write's receipt names its folder commit (#803 Astra r1 F1).
				or (requires_company_revision and output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null
					and folder_commit_id is null)));
end $$;
revoke all on function public.qorpera_folder_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)
	from public, anon, authenticated, service_role;

do $$
begin
	perform pg_temp.c1c3l2_replace('public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)',
		E' select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id;\n'
		|| E' if not found then return false; end if;\n',
		E' select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id;\n'
		|| E' if not found then return false; end if;\n'
		|| E' -- C1c-3l (20260930030100): on folder-v2 the same checks as plain reads, no lock.\n'
		|| E' if public.qorpera_company_is_folder_v2(v_parent.profile_id) then\n'
		|| E'  return public.qorpera_folder_office_waiter_authorized(p_waiter);\n'
		|| E' end if;\n', 1);
end $$;

-- 2. The wake source on folder-v2 --------------------------------------------------------------------------------------

-- Removes 'office-activation' from the one source list that p_head opens and ')' || p_tail closes, keeping every other
-- token and its spacing, with a marker line before the statement. A list left empty drops its whole statement, which
-- p_statement says p_head and p_tail are; the marker then takes its place on its line. A list left empty in a clause
-- of a larger condition (p_statement false) drops that clause only: the marker takes its line and the statement's end
-- (p_tail) follows on the next, so this applies in any order with the other sources' edits of the same list (S3's
-- 'machine-event', Q1's 'event'). p_tail stops at the statement's own end, so a note after it on the same line (S3's
-- 3i-b adds one there) stays.
create function pg_temp.c1c3l2_drop_source(p_target regprocedure, p_indent text, p_head text, p_tail text,
	p_statement boolean) returns void
language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_at integer; v_list text; v_kept text; v_token text;
	v_marker text := p_indent || '-- C1c-3l (20260930030100): office-activation serves folder-v2.' || E'\n';
begin
	if (length(v_definition) - length(replace(v_definition, p_head, ''))) / length(p_head) <> 1 then
		raise exception 'C1c-3l part 2: the source list is not found once in %', p_target; end if;
	v_at := strpos(v_definition, p_head) + length(p_head);
	v_list := substr(v_definition, v_at, strpos(substr(v_definition, v_at), ')') - 1);
	if substr(v_definition, v_at + length(v_list), 1 + length(p_tail)) is distinct from ')' || p_tail then
		raise exception 'C1c-3l part 2: the source list of % ends unexpectedly', p_target; end if;
	foreach v_token in array array[$t$'office-activation', $t$, $t$'office-activation',$t$, $t$, 'office-activation'$t$,
		$t$,'office-activation'$t$, $t$'office-activation'$t$] loop
		if (length(v_list) - length(replace(v_list, v_token, ''))) / length(v_token) = 1 then
			v_kept := replace(v_list, v_token, ''); exit; end if;
	end loop;
	if v_kept is null then raise exception 'C1c-3l part 2: office-activation is not once in the list of %', p_target; end if;
	execute replace(v_definition, p_head || v_list || ')' || p_tail,
		case when btrim(v_kept) <> '' then v_marker || p_head || v_kept || ')' || p_tail
			when p_statement then rtrim(v_marker, E'\n')
			else v_marker || p_indent || ltrim(p_tail) end);
end $$;

do $$
begin
	-- The pin's folder-v2 refusal list.
	perform pg_temp.c1c3l2_drop_source('public.qorpera_pin_wake_occurrence()', E'\t\t', E'\t\tif new.source_kind in (',
		E' then\n\t\t\traise exception ''This wake source does not serve folder-v2 yet'' using errcode = ''0A000''; end if;',
		true);
	-- The folder wake check: the source leaves the refused list, and its ancestry is checked as the agent sources' are.
	perform pg_temp.c1c3l2_drop_source('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)', E'\t\t',
		E'\t\tor p_wake.source_kind in (', ' then return false; end if;', false);
	perform pg_temp.c1c3l2_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
		E'\t\telse return false; end if;\n',
		E'\t\telsif p_wake.source_kind = ''office-activation'' then\n'
		|| E'\t\t\tv_ancestry := public.qorpera_office_activation_wake_ancestry(p_wake); /* C1c-3l 20260930030100 */\n'
		|| E'\t\telse return false; end if;\n', 1);
	-- The run resolve: a run woken by its computer coming up runs.
	perform pg_temp.c1c3l2_drop_source('public.qorpera_folder_run_resolve(uuid,uuid,jsonb)', E'\t', E'\tif v_wake.source_kind in (',
		E' then\n\t\traise exception ''Folder writes by this kind of run are not available yet'' using errcode = ''0A000''; end if;',
		true);
end $$;

drop function pg_temp.c1c3l2_drop_source(regprocedure, text, text, text, boolean);

-- 3. The drain ----------------------------------------------------------------------------------------------------------

-- Plain reads: a waiting waiter whose start's turn has ended, which the drain can deliver (its computer is up under the
-- start's activation) or must cancel (the turn failed or was cancelled, the start is gone or cancelled, or the computer
-- was replaced). A waiter whose computer is still coming up waits for a later pass, so the due list does not name its
-- company on every pass.
create function public.qorpera_folder_office_waiter_due(p_waiter public.qorpera_runtime_office_start_waiters)
returns boolean language sql stable security definer set search_path = '' as $$
	-- C1c-3l (20260930030100)
	select p_waiter.state = 'waiting' and exists (
		select 1 from public.qorpera_execution_runs as parent
		join public.qorpera_runner_jobs as job on job.id = parent.job_id
		left join public.qorpera_runtime_office_start_intents as intent on intent.id = p_waiter.intent_id
		where parent.id = p_waiter.parent_run_id
			and (job.status in ('failed', 'cancelled')
				or (job.status = 'completed' and (intent.id is null or intent.state = 'cancelled'
					or not exists (select 1 from public.qorpera_runtime_offices as office where office.id = intent.office_id
						and office.generation = intent.computer_generation)
					or (exists (select 1 from public.qorpera_runtime_offices as office where office.id = intent.office_id
							and office.state = 'active')
						and exists (select 1 from public.qorpera_runtime_office_activations as activation
							where activation.intent_id = intent.id and activation.state = 'active' and activation.superseded_at is null))))))
$$;
revoke all on function public.qorpera_folder_office_waiter_due(public.qorpera_runtime_office_start_waiters)
	from public, anon, authenticated, service_role;

create function public.qorpera_folder_office_wakes_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_next uuid; v_count integer;
begin
	-- C1c-3l (20260930030100): the folder-v2 companies with a due waiter, in the shared folder-drains step's shape (P29a):
	-- has_more when the page is full, and then the next cursor, else none. Paused and deleting companies are left out:
	-- the drain does nothing for them.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office wake admission requires control-plane authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Office wake page limit is invalid' using errcode = '22023'; end if;
	with page as (
		select distinct file.environment_id from public.qorpera_runtime_office_start_waiters as waiter
		join public.qorpera_execution_runs as parent on parent.id = waiter.parent_run_id
		join public.qorpera_company_files as file on file.profile_id = parent.profile_id and file.environment_id = parent.environment_id
			and file.core = 'folder-v2'
		where waiter.state = 'waiting' and public.qorpera_folder_office_waiter_due(waiter)
			and (p_after_environment is null or file.environment_id > p_after_environment)
			and not public.qorpera_company_execution_paused(parent.profile_id)
			and not public.qorpera_company_deleting(parent.profile_id)
		order by file.environment_id
		limit p_limit
	)
	select coalesce(jsonb_agg(jsonb_build_object('environment_id', environment_id) order by environment_id), '[]'::jsonb),
		max(environment_id::text)::uuid, count(*)
	into v_items, v_next, v_count from page;
	return jsonb_build_object('items', v_items, 'has_more', v_count = p_limit,
		'next_after_environment_id', case when v_count = p_limit then v_next end);
end $$;
revoke all on function public.qorpera_folder_office_wakes_due(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_folder_office_wakes_due(uuid, integer) to service_role;

create function public.qorpera_folder_office_wakes_company(p_environment_id uuid, p_limit integer default 16)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_profile uuid; v_ids uuid[]; v_targets jsonb; v_locked uuid[];
	v_waiter public.qorpera_runtime_office_start_waiters%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_intent public.qorpera_runtime_office_start_intents%rowtype; v_job_status text; v_at timestamptz;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_delivered integer := 0; v_cancelled integer := 0; v_skipped integer := 0;
begin
	-- C1c-3l (20260930030100): one company's due office-activation waiters, in its own transaction. A lock held past the
	-- 2 s budget answers busy. At most 40 waiters: each writes in its own subtransaction, under core §3's budget of 64.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Office wake admission requires control-plane authority' using errcode = '42501'; end if;
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 40 then
		raise exception 'Office wake admission is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if not found then return jsonb_build_object('state', 'not_folder'); end if;
	if public.qorpera_company_deleting(v_profile) then return jsonb_build_object('state', 'deleting'); end if;
	if public.qorpera_company_execution_paused(v_profile) then return jsonb_build_object('state', 'paused'); end if;
	-- The work, read without a lock: it names the rows to lock in rank order.
	select coalesce(array_agg(waiter.id order by waiter.scanned_at, waiter.created_at, waiter.id), '{}') into v_ids
	from (select waiter.* from public.qorpera_runtime_office_start_waiters as waiter
		join public.qorpera_execution_runs as parent on parent.id = waiter.parent_run_id
			and parent.profile_id = v_profile and parent.environment_id = p_environment_id
		where waiter.state = 'waiting' and public.qorpera_folder_office_waiter_due(waiter)
		order by waiter.scanned_at, waiter.created_at, waiter.id limit p_limit) as waiter;
	if cardinality(v_ids) = 0 then return jsonb_build_object('state', 'idle'); end if;
	-- Ranks 1 to 3: the starts' requesters, agents and their execution authorities KEY SHARE (as the materializer).
	select coalesce(jsonb_agg(x.t), '[]'::jsonb) into v_targets
	from public.qorpera_runtime_office_start_waiters as waiter
	join public.qorpera_execution_runs as parent on parent.id = waiter.parent_run_id, lateral (values
		(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_profile::text || ':' || parent.requested_by_user_id::text, 'mode', 'keyshare')),
		(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', v_profile::text || ':' || parent.staff_agent_id::text, 'mode', 'keyshare')),
		(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_profile::text || ':' || parent.staff_agent_id::text, 'mode', 'keyshare'))) as x(t)
	where waiter.id = any (v_ids);
	begin
		-- The fence KEY SHARE with the pause read again, the company row KEY SHARE, then ranks 1 to 3.
		begin
			perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, true);
		exception
			-- A lock past the budget (55P03) is busy; only the pause itself (55000) is paused. Order matters: a
			-- class code such as '55000' also matches every code of its class.
			when lock_not_available then return jsonb_build_object('state', 'busy');
			when sqlstate '55000' then return jsonb_build_object('state', 'paused');
		end;
		-- The waiters (still waiting), each once: a second drain of the company skips them.
		select coalesce(array_agg(id order by id), '{}') into v_locked from (
			select waiter.id from public.qorpera_runtime_office_start_waiters as waiter
			where waiter.id = any (v_ids) and waiter.state = 'waiting' order by waiter.id for update skip locked) as locked;
		if cardinality(v_locked) = 0 then return jsonb_build_object('state', 'idle'); end if;
		update public.qorpera_runtime_office_start_waiters set scanned_at = clock_timestamp() where id = any (v_locked);
		perform public.qorpera_folder_admit_wakes(v_profile);
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('state', 'busy');
	end;
	for v_waiter in select * from public.qorpera_runtime_office_start_waiters where id = any (v_locked)
		order by scanned_at, created_at, id loop
		begin
			select * into strict v_parent from public.qorpera_execution_runs where id = v_waiter.parent_run_id;
			select status into strict v_job_status from public.qorpera_runner_jobs where id = v_parent.job_id;
			select * into strict v_intent from public.qorpera_runtime_office_start_intents where id = v_waiter.intent_id;
			if v_job_status in ('failed', 'cancelled') or v_intent.state = 'cancelled'
				or not exists (select 1 from public.qorpera_runtime_offices where id = v_intent.office_id
					and generation = v_intent.computer_generation) then
				update public.qorpera_runtime_office_start_waiters set state = 'cancelled' where id = v_waiter.id;
				v_cancelled := v_cancelled + 1; continue;
			end if;
			-- A computer not up yet, or a pause that committed since the fence (a stop's first phase does not wait for
			-- it), leaves the waiter waiting for a later pass, as the old drain does.
			if v_job_status <> 'completed'
				or not exists (select 1 from public.qorpera_runtime_offices where id = v_intent.office_id and state = 'active')
				or not exists (select 1 from public.qorpera_runtime_office_activations where intent_id = v_intent.id
					and state = 'active' and superseded_at is null)
				or public.qorpera_company_execution_paused(v_profile) then
				v_skipped := v_skipped + 1; continue;
			end if;
			if not public.qorpera_folder_office_waiter_authorized(v_waiter) then
				-- The check also fails on a pause; one that committed in between is not a cancellation.
				if public.qorpera_company_execution_paused(v_profile) then v_skipped := v_skipped + 1; continue; end if;
				update public.qorpera_runtime_office_start_waiters set state = 'cancelled' where id = v_waiter.id;
				v_cancelled := v_cancelled + 1; continue;
			end if;
			select activated_at into strict v_at from public.qorpera_runtime_office_activations
			where intent_id = v_intent.id and superseded_at is null;
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (extensions.gen_random_uuid(), v_parent.profile_id, v_parent.environment_id, 'agent', 'office-activation', v_waiter.id,
				v_parent.staff_agent_id, v_parent.id, 'office-activation',
				'office-activation:' || v_intent.id::text || ':' || v_parent.id::text, v_at, clock_timestamp(),
				public.qorpera_office_activation_wake_payload(v_waiter))
			returning * into v_wake;
			-- A pause that committed meanwhile makes the pin cancel the wake. Undo it (the handler below rolls the insert
			-- back and counts the waiter skipped), so the waiter waits for the next pass and its key stays free.
			if v_wake.status is distinct from 'queued' then
				raise exception 'Company execution is paused' using errcode = '55000'; end if;
			update public.qorpera_runtime_office_start_waiters set state = 'delivered', occurrence_id = v_wake.id where id = v_waiter.id;
			v_delivered := v_delivered + 1;
		exception
			when lock_not_available or sqlstate '55000' then v_skipped := v_skipped + 1;
			when insufficient_privilege or no_data_found then
				update public.qorpera_runtime_office_start_waiters set state = 'cancelled' where id = v_waiter.id;
				v_cancelled := v_cancelled + 1;
		end;
	end loop;
	return jsonb_build_object('state', 'drained', 'delivered', v_delivered, 'cancelled', v_cancelled, 'skipped', v_skipped);
end $$;
revoke all on function public.qorpera_folder_office_wakes_company(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_folder_office_wakes_company(uuid, integer) to service_role;

drop function pg_temp.c1c3l2_replace(regprocedure, text, text, integer);
