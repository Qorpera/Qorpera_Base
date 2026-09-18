-- 2026-09-17 amendment: a node retires login journals that never reserved a machine.
--
-- A login post that reaches a node which then cannot reserve (the login's
-- machine lives on another node, or the reservation was refused outright)
-- leaves a local journal with no backend request. The node's reconcile could
-- neither describe nor release it and reported it as unconfirmed forever.
-- The node may retire such a journal itself once the backend confirms there is
-- nothing to release: no request exists for the allocation, and the login is
-- over or holds its machine elsewhere. The node additionally requires that the
-- journal dispatched no physical operation and that no instance exists.

create function public.qorpera_runtime_login_journal_orphaned(p_allocation_id uuid, p_login_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_login public.qorpera_native_provider_login_sessions%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_login_id is null then
		raise exception 'Login machine supervisor required' using errcode = '42501'; end if;
	if exists(select 1 from public.qorpera_runtime_login_machine_requests where allocation_id = p_allocation_id)
		or exists(select 1 from public.qorpera_runtime_machine_allocations where id = p_allocation_id) then
		return false; end if;
	select * into v_login from public.qorpera_native_provider_login_sessions where id = p_login_id;
	if not found then return true; end if;
	return v_login.status <> 'pending' or v_login.expires_at <= clock_timestamp()
		or exists(select 1 from public.qorpera_runtime_login_machine_requests r
			where r.login_session_id = p_login_id and r.released_at is null);
end
$$;
revoke all on function public.qorpera_runtime_login_journal_orphaned(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_runtime_login_journal_orphaned(uuid, uuid) to service_role;
