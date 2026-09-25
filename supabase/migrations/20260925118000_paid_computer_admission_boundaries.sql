-- Operator-selected paid admission is opt-in per company. The default stays
-- shadow, including explicitly complimentary/internal companies. This is a
-- fail-closed physical coding-VM pilot, NOT full paid company execution:
-- native agent sandboxes (including the coding harness) and company offices
-- do not yet have funded physical lifetimes, so they cannot start in paid mode.
-- Login and account-refresh helpers remain exempt so model setup still works.
-- This migration does not enable global accounting readiness or checkout.

create table public.qorpera_company_computer_billing_modes (
    profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
    mode text not null check (mode in ('shadow','paid')),
    updated_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_company_computer_billing_modes enable row level security;
revoke all on public.qorpera_company_computer_billing_modes from public,anon,authenticated,service_role,qorpera_secret_broker;
comment on table public.qorpera_company_computer_billing_modes is
    'Database-operator configuration only. No row means shadow. Paid is a coding-VM pilot; native/shared agent sandboxes and offices remain unsupported.';

create function public.qorpera_company_paid_computer_mode(p_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.qorpera_company_computer_billing_modes
        where profile_id=p_profile_id and mode='paid')
$$;
revoke all on function public.qorpera_company_paid_computer_mode(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_company_paid_computer_mode(uuid) to service_role;

-- A mode cannot change beneath old admission receipts. Reservations and mode
-- changes share the profile fence. Login-only allocations need no paid permit;
-- a sleeping coding VM is safe only after its last 5-second run receipt expires.
-- Native/shared reservations have no bounded receipt lifetime and must be
-- physically released, not merely timed out or marked as an ended run.
create function public.qorpera_guard_company_computer_billing_mode()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_profile uuid; v_previous text; v_next text;
begin
    if tg_op='UPDATE' and new.profile_id is distinct from old.profile_id then
        raise exception 'Computer billing company cannot change' using errcode='42501'; end if;
    v_profile:=case when tg_op='DELETE' then old.profile_id else new.profile_id end;
    -- Parent deletion already owns the profile lock and its own retirement
    -- checks. A cascading row cleanup is not a switch to a runnable company.
    if tg_op='DELETE' and not exists(select 1 from public.qorpera_profiles where id=v_profile) then return old; end if;
    v_previous:=case when tg_op='INSERT' then 'shadow' else old.mode end;
    v_next:=case when tg_op='DELETE' then 'shadow' else new.mode end;
    perform public.qorpera_lock_profile_gc_fence(v_profile);
    if v_previous is distinct from v_next then
        if exists(select 1 from public.qorpera_runtime_machine_allocations allocation
            left join public.qorpera_runtime_node_demands demand on demand.allocation_id=allocation.id
            where allocation.profile_id=v_profile and allocation.released_at is null
                and allocation.login_session_id is null and allocation.account_refresh_request_id is null
                and not coalesce((allocation.coding_machine_id is not null and demand.suspended_at is not null
                    and demand.last_checked_at<clock_timestamp()-interval '5 seconds'),false))
            or exists(select 1 from public.qorpera_runner_jobs where profile_id=v_profile and status in ('leased','running'))
            or exists(select 1 from public.qorpera_coding_computer_permits permit
                where permit.profile_id=v_profile and (permit.state<>'closed' or exists(
                    select 1 from public.qorpera_coding_computer_windows permit_window
                    join public.qorpera_computer_allowance_reservations reservation on reservation.id=permit_window.reservation_id
                    where permit_window.permit_id=permit.id and reservation.settled_at is null))) then
            raise exception 'Stop and reconcile company computers before changing paid mode' using errcode='55000';
        end if;
    end if;
    if tg_op='DELETE' then return old; end if;
    new.updated_at:=clock_timestamp();
    return new;
end
$$;
revoke all on function public.qorpera_guard_company_computer_billing_mode() from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_guard_company_computer_billing_mode
before insert or update or delete on public.qorpera_company_computer_billing_modes
for each row execute function public.qorpera_guard_company_computer_billing_mode();

create function pg_temp.paid_admission_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
    if p_old='' or (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Paid admission integration differs: % near %',p_target,left(p_old,90); end if;
    execute replace(v_definition,p_old,p_new);
end
$$;

-- Native per-run VMs AND shared-systemd sandboxes reserve here before their
-- first physical effect. Offices reserve here too. Preserve their existing
-- scope/authority checks and refuse before allocating physical resources.
select pg_temp.paid_admission_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
    $old$	-- The same identity disk cannot be attached to a login and a job VM.$old$,
    $new$	if public.qorpera_company_paid_computer_mode(v_profile) then
		return '{"state":"refused","reason":"PAID_COMPUTER_PATH_UNSUPPORTED"}'::jsonb; end if;
	-- The same identity disk cannot be attached to a login and a job VM.$new$);

-- Node admission is an independent boundary for replay/resume and imported
-- allocations. A caller cannot label a native allocation as login or coding:
-- the existing exact source/provider checks execute first. Current member
-- coding machines may reserve capacity; that alone is NOT physical authority.
-- They still need a protected 117 permit before create/start/commands.
select pg_temp.paid_admission_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
    $old$  raise exception 'Node provider allocation differs' using errcode='42501'; end if;
 select * into strict v_node$old$,
    $new$  raise exception 'Node provider allocation differs' using errcode='42501'; end if;
 if public.qorpera_company_paid_computer_mode(v_profile)
  and not (p_provider_kind='login' and num_nonnulls(v_allocation.login_session_id,v_allocation.account_refresh_request_id)=1
   and v_allocation.login_compute_identity_id is not null)
  and not (p_provider_kind='coding' and v_allocation.coding_machine_id is not null) then
  return '{"state":"refused","reason":"PAID_COMPUTER_PATH_UNSUPPORTED"}'::jsonb; end if;
 select * into strict v_node$new$);

-- Fail closed even when an older/native executor reaches model launch without
-- a new physical reservation. There is deliberately no coding-wake exemption:
-- its model harness is still an unmetered agent sandbox in this pilot.
select pg_temp.paid_admission_patch('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)',
    $old$	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);$old$,
    $new$	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_lock_profile_gc_fence(v_run.profile_id);
	if public.qorpera_company_paid_computer_mode(v_run.profile_id) then
		raise exception 'Paid native agent sandbox admission is not supported' using errcode='42501'; end if;
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);$new$);

-- The older public runner claim path must not hand a paid company's job to
-- a pre-existing unmetered runner. Resolve the profile before locking its
-- runner row, so the mode fence precedes that row lock.
select pg_temp.paid_admission_patch('public.qorpera_claim_runner_job(uuid,text,uuid,text)',
    $old$	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;$old$,
    $new$	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_runners where id=p_runner_id));
	if public.qorpera_company_paid_computer_mode((select profile_id from public.qorpera_runners where id=p_runner_id)) then
		raise exception 'Paid native agent sandbox admission is not supported' using errcode='42501'; end if;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;$new$);

-- A paid run receives a different schema, not an ignorable extra field on
-- v1. Older hosts reject it. New hosts must acquire their protected 117
-- permit before physical effects. Custody stop/detach/delete keeps v1 so
-- cleanup remains possible even after funding or membership changes.
select pg_temp.paid_admission_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)',
    $old$	return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_machine.id,'workerId',v_worker.id,$old$,
    $new$	if public.qorpera_company_paid_computer_mode(v_worker.profile_id) then
		return jsonb_build_object('schema','qorpera.coding-machine-admission/v2','fundingRequired',true,
			'machineId',v_machine.id,'workerId',v_worker.id,'instanceSha256',v_digest,'intent','run',
			'guestUid',v_volume.guest_uid,'validForMs',v_valid,'nodeId',v_node -> 'nodeId','nodeVersion',v_node -> 'nodeVersion');
	end if;
	return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_machine.id,'workerId',v_worker.id,$new$);
