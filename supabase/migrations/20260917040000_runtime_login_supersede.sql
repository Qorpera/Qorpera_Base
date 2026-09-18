-- 2026-09-17 amendment: a new provider sign-in replaces the member's unfinished one.
--
-- A member who starts a sign-in and loses the page (reload, closed tab, dropped
-- connection) holds a login machine until that login expires, and every new
-- attempt was refused with COMPUTE_IDENTITY_OCCUPIED for up to the login's
-- lifetime. The member's intent is unambiguous: the newest sign-in is the one
-- they want. So beginning a login cancels the same member's earlier pending
-- logins for the same compute identity. The node that holds the cancelled
-- login's machine already deletes it and releases the allocation on its next
-- reconcile (describe → cleanupRequired). While that happens, the new login's
-- reservation answers COMPUTE_IDENTITY_RELEASING, which a node waits on,
-- instead of COMPUTE_IDENTITY_OCCUPIED, which stays a refusal (a runner or
-- another member's live login really holds the identity).

create function public.qorpera_supersede_member_provider_logins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_native_provider_login_sessions as earlier
	set status = 'cancelled'
	where earlier.compute_identity_id = new.compute_identity_id
		and earlier.profile_id = new.profile_id
		and earlier.requested_by_user_id = new.requested_by_user_id
		and earlier.id <> new.id
		and earlier.status = 'pending'
		and earlier.created_at <= new.created_at;
	return null;
end
$$;
revoke all on function public.qorpera_supersede_member_provider_logins() from public, anon, authenticated;

create trigger qorpera_supersede_member_provider_logins
	after insert on public.qorpera_native_provider_login_sessions
	for each row when (new.status = 'pending')
	execute function public.qorpera_supersede_member_provider_logins();

alter table public.qorpera_runtime_login_machine_requests
	drop constraint qorpera_runtime_login_machine_requests_last_refusal_check,
	add constraint qorpera_runtime_login_machine_requests_last_refusal_check
		check(last_refusal in ('COMPANY_PAUSED','MACHINE_CAPACITY_EXHAUSTED','COMPUTE_IDENTITY_OCCUPIED',
			'COMPUTE_IDENTITY_RELEASING','NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE'));

-- Every occupant is a login machine whose login can no longer be used: its node is deleting it.
create function public.qorpera_login_identity_releasing(p_profile_id uuid, p_compute_identity_id uuid, p_allocation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select not exists (
		select 1
		from public.qorpera_runtime_machine_allocations a
		left join public.qorpera_runners r on r.id = a.runner_id
		left join public.qorpera_native_provider_login_sessions l on l.id = a.login_session_id
		where a.profile_id = p_profile_id and a.released_at is null and a.id <> p_allocation_id
			and (a.login_compute_identity_id = p_compute_identity_id or r.compute_identity_id = p_compute_identity_id)
			and not (
				a.login_compute_identity_id = p_compute_identity_id
				and l.id is not null
				and (l.status <> 'pending' or l.expires_at <= clock_timestamp())
			)
	)
$$;
revoke all on function public.qorpera_login_identity_releasing(uuid, uuid, uuid) from public, anon, authenticated;

do $patch$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure);
	v_old := 'v_reason:=''COMPUTE_IDENTITY_OCCUPIED'';';
	v_new := 'v_reason:=case when public.qorpera_login_identity_releasing(v_login.profile_id,v_identity.id,p_allocation_id) then ''COMPUTE_IDENTITY_RELEASING'' else ''COMPUTE_IDENTITY_OCCUPIED'' end;';
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'reserve_runtime_login_machine occupancy branch differs'; end if;
	execute replace(v_def, v_old, v_new);
end
$patch$;
