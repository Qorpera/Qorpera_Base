-- 20260930290000: the legacy sweep, step F2a (a company computer's start). Twenty-one functions keep only their folder-v2
-- path (folder-v2 only, the founder's decision of 3 October). Each is patched in place from its live text, so its
-- header, its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 1. The start prelude. Fifteen functions (a start's activation, check, reservation and startup lock, a member's start,
--    wake, cancellation and withdrawal, the provider, the fleet offer and placement, and registration) take the folder
--    fence (qorpera_folder_office_enter or qorpera_folder_machine_fence) on every company; the snapshot-v1 branch, the
--    profile gc fence, goes. A company without a folder now fails in the fence ("Company folder is unavailable",
--    42501). A computer that does not exist still gets the scope refusal it got before.
-- 2. The Company File a start needs (registration, start source, guest binding, restart surfaces) is the folder core's
--    (core = 'folder-v2'); the old path gateway's file (path_gateway_version = 1) goes.
-- 3. An agent's start source shares the agent and its access without waiting, as on folder-v2; the waiting share goes.
-- 4. qorpera_office_waiter_authorized answers with qorpera_folder_office_waiter_authorized (plain reads); its locked
--    snapshot-v1 checks go.
-- 5. A member's start status poll is plain reads; its locked snapshot-v1 reads go.
-- 6. qorpera_check_runtime_office_adoption refuses every mapping (0A000), as a folder-v2 company did, so its mapping
--    checks go.
-- Every patched body names this migration (20260930290000).

set local lock_timeout = '3s';

create function pg_temp.f2a_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep F2a anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The start prelude: the folder-v2 branch, without its test or the profile gc fence. -------------------------------

select pg_temp.f2a_patch('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id=(p_scope->>'companyComputerId')::uuid)) then
		perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,uuid,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id=(p_scope->>'companyComputerId')::uuid)) then
		perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id=(p_scope->>'companyComputerId')::uuid)) then
		perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter((p_scope->>'companyComputerId')::uuid, null, p_intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id=(p_startup#>>'{scope,companyComputerId}')::uuid)) then
		perform public.qorpera_folder_office_enter((p_startup#>>'{scope,companyComputerId}')::uuid, null, v_activation.intent_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter((p_startup#>>'{scope,companyComputerId}')::uuid, null, v_activation.intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_machine_fence(v_office.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_office.profile_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);
$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_profile) then
		perform public.qorpera_folder_machine_fence(v_profile);
		perform 1 from public.qorpera_profile_members where profile_id=v_profile and user_id=auth.uid() for share;
		-- C1c-3k (20260930019100): the company's agents KEY SHARE before the seat lock.
		perform 1 from public.qorpera_profile_staff where profile_id=v_profile order by staff_agent_id for key share;
		perform public.qorpera_lock_runtime_office_seats(p_environment_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_profile);
	perform 1 from public.qorpera_profile_members where profile_id=v_profile and user_id=auth.uid() for share;
	-- C1c-3k (20260930019100): the company's agents KEY SHARE before the seat lock.
	perform 1 from public.qorpera_profile_staff where profile_id=v_profile order by staff_agent_id for key share;
	perform public.qorpera_lock_runtime_office_seats(p_environment_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_request_runtime_office_start(jsonb,bigint,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(o.profile_id) then
		perform public.qorpera_folder_office_enter(o.id, auth.uid(), null);
	else
	perform public.qorpera_lock_profile_gc_fence(o.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(o.id, auth.uid(), null);
$new$);

select pg_temp.f2a_patch('public.qorpera_request_runtime_office_start_before_idle(jsonb,bigint,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);
$new$);

select pg_temp.f2a_patch('public.qorpera_reserve_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text,text,text)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_machine_fence(v_office.profile_id);
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_office.profile_id);
$new$);

select pg_temp.f2a_patch('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(o.profile_id) then
		perform public.qorpera_folder_office_enter(o.id, auth.uid(), null);
	else
	perform public.qorpera_lock_profile_gc_fence(o.profile_id);
	end if;
$old$,
$new$	-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_office_enter(o.id, auth.uid(), null);
$new$);

select pg_temp.f2a_patch('public.qorpera_offer_runtime_office_fleet(jsonb)'::regprocedure,
$old$ if public.qorpera_company_is_folder_v2(o.profile_id) then
  perform public.qorpera_folder_office_enter(o.id, null, (p_offer->>'intentId')::uuid);
 else
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 end if;
$old$,
$new$ -- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
 perform public.qorpera_folder_office_enter(o.id, null, (p_offer->>'intentId')::uuid);
$new$);

select pg_temp.f2a_patch('public.qorpera_place_runtime_office_fleet(jsonb,bigint)'::regprocedure,
$old$ if public.qorpera_company_is_folder_v2(o.profile_id) then
  perform public.qorpera_folder_office_enter(o.id, null, null);
 else
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 end if;
$old$,
$new$ -- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
 perform public.qorpera_folder_office_enter(o.id, null, null);
$new$);

-- 2. The Company File a start needs is the folder core's. -------------------------------------------------------------

select pg_temp.f2a_patch('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3j 20260930012000 */)$old$,
$new$core='folder-v2' /* C1c-3j 20260930012000; only it since 20260930290000 */$new$);

select pg_temp.f2a_patch('public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3j 20260930012000 */)$old$,
$new$core='folder-v2' /* C1c-3j 20260930012000; only it since 20260930290000 */$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3j 20260930012000 */)$old$,
$new$core='folder-v2' /* C1c-3j 20260930012000; only it since 20260930290000 */$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3k 20260930019000 */)$old$,
$new$core='folder-v2' /* C1c-3k 20260930019000; only it since 20260930290000 */$new$);

-- 3. An agent's start source shares the agent and its access without waiting. -----------------------------------------

select pg_temp.f2a_patch('public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(p_office.profile_id) then
			perform 1 from public.qorpera_runtime_office_access access
				join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
				where access.office_id=p_office.id and access.profile_id=p_office.profile_id
				and access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id
				and access.version=p_intent.grant_version and access.state='active' and staff.employment_status='active'
				for share of access for share of staff nowait;
		else
		perform 1 from public.qorpera_runtime_office_access access
			join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
			where access.office_id=p_office.id and access.profile_id=p_office.profile_id
			and access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id
			and access.version=p_intent.grant_version and access.state='active' and staff.employment_status='active'
			for share of access,staff;
		end if;
$old$,
$new$		-- 20260930290000 (legacy sweep F2a): folder-v2 only, so every company takes this path.
		perform 1 from public.qorpera_runtime_office_access access
			join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
			where access.office_id=p_office.id and access.profile_id=p_office.profile_id
			and access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id
			and access.version=p_intent.grant_version and access.state='active' and staff.employment_status='active'
			for share of access for share of staff nowait;
$new$);

-- 4. A start waiter's check is the folder core's. ---------------------------------------------------------------------

select pg_temp.f2a_patch('public.qorpera_office_waiter_authorized(public.qorpera_runtime_office_start_waiters)'::regprocedure,
$old$declare v_intent public.qorpera_runtime_office_start_intents%rowtype;
 v_parent public.qorpera_execution_runs%rowtype; v_office public.qorpera_runtime_offices%rowtype; v_job_status text;
 v_parent_wake public.qorpera_wake_occurrences%rowtype;
begin
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id;
 if not found then return false; end if;
 -- C1c-3l (20260930030100): on folder-v2 the same checks as plain reads, no lock.
 if public.qorpera_company_is_folder_v2(v_parent.profile_id) then
  return public.qorpera_folder_office_waiter_authorized(p_waiter);
 end if;
 -- Standalone effect validators may already hold a job lock. Acquire the
 -- common profile fence without waiting before taking any office/grant lock.
 if public.qorpera_company_fence_shared() then
  perform 1 from public.qorpera_profiles where id=v_parent.profile_id for share nowait;
 else
  perform 1 from public.qorpera_profiles where id=v_parent.profile_id for update nowait;
 end if;
 if not found then return false; end if;
 select * into v_intent from public.qorpera_runtime_office_start_intents where id=p_waiter.intent_id for share nowait;
 select * into v_parent from public.qorpera_execution_runs where id=p_waiter.parent_run_id for share nowait;
 select status into v_job_status from public.qorpera_runner_jobs where id=v_parent.job_id for share nowait;
 select * into v_office from public.qorpera_runtime_offices where id=v_intent.office_id for share nowait;
 if v_office.id is null or v_parent.id is null or v_intent.state<>'reserved'
  or v_office.state<>'active' or v_office.generation<>v_intent.computer_generation
  or v_office.image_sha256<>v_intent.image_sha256 or v_office.bootstrap_sha256<>v_intent.bootstrap_sha256
  or v_parent.profile_id<>v_office.profile_id or v_parent.environment_id<>v_office.environment_id
  or v_parent.audience_kind<>'company' or v_parent.audience_user_id is not null
  or v_job_status is distinct from 'completed' or v_parent.staff_version<>p_waiter.staff_version
  or p_waiter.state='cancelled' or public.qorpera_company_execution_paused(v_parent.profile_id) then return false; end if;
 -- Bound repeated internal revivals before admission, rather than launching
 -- a run whose complete historical context cannot be read. Source authority
 -- remains current, including room membership and revoked routine intent.
 if exists(with recursive ancestry(run_id,depth) as (
  select v_parent.id,1 union all select w.parent_run_id,a.depth+1 from ancestry a
  join public.qorpera_wake_occurrences w on w.run_id=a.run_id
  where w.source_kind='office-activation' and a.depth<9
 ) select 1 from ancestry where depth=9) then return false; end if;
 select * into v_parent_wake from public.qorpera_wake_occurrences where run_id=v_parent.id;
 if not found or public.qorpera_runtime_wake_policy_internal(v_parent.id)->>'kind' is distinct from v_parent_wake.wake_kind
  or not public.qorpera_wake_authorized(v_parent_wake) then return false; end if;
 perform 1 from public.qorpera_profile_staff where profile_id=v_parent.profile_id and staff_agent_id=v_parent.staff_agent_id
  and version>=p_waiter.staff_version and employment_status='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_profile_members where profile_id=v_parent.profile_id and user_id=v_parent.requested_by_user_id for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_office_access where office_id=v_office.id and profile_id=v_parent.profile_id
  and staff_agent_id=v_parent.staff_agent_id and grant_id=p_waiter.grant_id and version=p_waiter.grant_version and state='active' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_runtime_machine_allocations where id=v_intent.allocation_id and office_id=v_office.id
  and profile_id=v_office.profile_id and computer_generation=v_office.generation and released_at is null
  and instance_sha256=v_intent.instance_sha256 and provider_adapter='lxd' for share nowait;
 if not found then return false; end if;
 perform 1 from public.qorpera_logical_computers computer where id=v_office.logical_computer_id
  and status='active' and public.qorpera_runtime_office_matches(computer) for share nowait;
 if not found then return false; end if;
 if not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
  and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
  or not exists(select 1 from public.qorpera_runtime_office_activations where intent_id=v_intent.id
   and office_id=v_office.id and computer_generation=v_office.generation and state='active' and superseded_at is null
   and allocation_id=v_intent.allocation_id and instance_sha256=v_intent.instance_sha256
   and provider_binding_sha256=v_intent.provider_binding_sha256)
  or not exists(select 1 from public.qorpera_run_operation_receipts where id=p_waiter.receipt_id
   and run_id=v_parent.id and status='completed' and operation_kind='cloud_tool'
   and logical_operation_key like 'computer_start:%' and not requires_company_revision)
  or exists(select 1 from public.qorpera_run_operation_receipts where run_id=v_parent.id
   and (status<>'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
    or (requires_company_revision and output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null))) then return false; end if;
 return true;
$old$,
$new$begin
 -- C1c-3l (20260930030100): the folder-v2 checks, as plain reads with no lock; legacy sweep F2a (20260930290000)
 -- leaves only these.
 return public.qorpera_folder_office_waiter_authorized(p_waiter);
$new$);

-- 5. A member's start status is plain reads. --------------------------------------------------------------------------

select pg_temp.f2a_patch('public.qorpera_runtime_office_start_status(jsonb)'::regprocedure,
$old$	-- C1c-3j (20260930012000) took the folder fence and the start's members and agent here on folder-v2; C1c-3k
	-- makes a folder-v2 poll plain reads instead (below). Snapshot-v1 keeps the gc fence.
$old$,
$new$	-- C1c-3j (20260930012000) took the folder fence and the start's members and agent here; C1c-3k makes a poll plain
	-- reads instead (below), and legacy sweep F2a (20260930290000) leaves only that.
$new$);

select pg_temp.f2a_patch('public.qorpera_runtime_office_start_status(jsonb)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		-- C1c-3k (20260930019000): a status poll is plain reads on folder-v2 (no fence, no row lock), so it never
		-- waits for a folder stop or a start in flight; the membership check above is the authority.
		if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
			raise exception 'Office start scope differs' using errcode='42501'; end if;
		select * into v_intent from public.qorpera_runtime_office_start_intents
			where office_id=v_office.id and computer_generation=v_office.generation;
		return jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
			'officeState',v_office.state,'intent',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end,
			'maintenance',public.qorpera_runtime_office_maintenance(v_office));
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for share;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	if not found then raise exception 'Office start status requires membership' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation for share;
	return jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
		'officeState',v_office.state,'intent',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end,
		'maintenance',public.qorpera_runtime_office_maintenance(v_office));
$old$,
$new$	-- C1c-3k (20260930019000): a status poll is plain reads on folder-v2 (no fence, no row lock), so it never
	-- waits for a folder stop or a start in flight; the membership check above is the authority.
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation;
	return jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
		'officeState',v_office.state,'intent',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end,
		'maintenance',public.qorpera_runtime_office_maintenance(v_office));
$new$);

-- 6. Adoption refuses every mapping. ----------------------------------------------------------------------------------

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)'::regprocedure,
$old$	if jsonb_typeof(p_mappings)='array' and jsonb_array_length(p_mappings)>0
		and public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
			where office.id=(p_scope->>'companyComputerId')::uuid)) then
$old$,
$new$	-- Legacy sweep F2a (20260930290000): folder-v2 only, so every company refuses one, and the mapping checks are gone.
	if jsonb_typeof(p_mappings)='array' and jsonb_array_length(p_mappings)>0 then
$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)'::regprocedure,
$old$	if jsonb_array_length(p_mappings)>32 then
		raise exception 'Invalid office adoption mappings' using errcode='22023'; end if;
$old$,
$new$$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)'::regprocedure,
$old$	for v_mapping in select value from jsonb_array_elements(p_mappings) loop
		if jsonb_typeof(v_mapping) is distinct from 'object'
			or v_mapping-array['binding','browserProfile']<>'{}'::jsonb
			or not (v_mapping ?& array['binding','browserProfile']) then
			raise exception 'Invalid office adoption mapping' using errcode='22023'; end if;
		select * into v_screen from public.qorpera_runtime_office_screens
			where office_id=v_office.id and id=(v_mapping#>>'{binding,screenId}')::uuid for share;
		if not found or v_screen.id=any(v_screens)
			or v_mapping->'binding' is distinct from public.qorpera_runtime_office_scope(v_office)||jsonb_build_object(
				'computerGeneration',v_office.generation,'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,
				'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id) then
			raise exception 'Office adoption screen differs' using errcode='42501'; end if;
		v_screens:=array_append(v_screens,v_screen.id);
		perform 1 from public.qorpera_runtime_office_access access
			join public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id
			where access.office_id=v_office.id and access.profile_id=v_office.profile_id and access.staff_agent_id=v_screen.staff_agent_id
			and access.state='active' and staff.employment_status='active' for share of access,staff;
		if not found then raise exception 'Office adoption staff access unavailable' using errcode='42501'; end if;
		if v_mapping->'browserProfile'<>'null'::jsonb then
			select g.* into v_grant from public.qorpera_runtime_browser_grants g
				join public.qorpera_runtime_browser_profiles p on p.id=g.profile_id and p.office_id=g.office_id
				join public.qorpera_profile_members m on m.profile_id=v_office.profile_id and m.user_id=p.owner_user_id
				where g.office_id=v_office.id and g.staff_agent_id=v_screen.staff_agent_id and g.state='active'
				and p.prepared and p.verified_version=p.version and g.profile_version=p.version
				and g.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations
					where profile_id=v_office.profile_id and user_id=p.owner_user_id),0) for share of g,p,m;
			if not found or v_grant.profile_id=any(v_profiles)
				or v_mapping->'browserProfile' is distinct from jsonb_build_object('profileId',v_grant.profile_id,
					'grantId',v_grant.id,'version',v_grant.version) then
				raise exception 'Office adoption browser grant unavailable' using errcode='42501'; end if;
			v_profiles:=array_append(v_profiles,v_grant.profile_id);
		end if;
	end loop;
$old$,
$new$$new$);

select pg_temp.f2a_patch('public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)'::regprocedure,
$old$declare v_result jsonb; v_office public.qorpera_runtime_offices%rowtype;
	v_mapping jsonb; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_grant public.qorpera_runtime_browser_grants%rowtype;
	v_screens uuid[]:='{}'; v_profiles uuid[]:='{}';
$old$,
$new$declare v_result jsonb; v_office public.qorpera_runtime_offices%rowtype;
$new$);
