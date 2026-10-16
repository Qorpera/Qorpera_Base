-- 20260930398000: step 5e (coordinator decision D3), a deleted company's code hosts go with it
-- (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "The code host"; runner-orchestrator code-host.ts). A code host
-- is no allocation, and its code area is erased with the company folder, so the company's deletion does not wait for
-- it. Instead each node's coding executor asks, at its start and every minute after, which of the companies with a code
-- host project on the node are being deleted, and removes those code hosts with their projects; one still in a job goes
-- on a later pass.
-- qorpera_code_hosts_deleting tells the executor only which of the companies it names have a deletion request (purged
-- or not): the service role still cannot call qorpera_company_deleting, and learns nothing else about a company. It is
-- read-only and the service role's only, with the coding executor's custody check (as qorpera_list_coding_machines),
-- at most 500 companies a call.

set local lock_timeout = '3s';

create function public.qorpera_code_hosts_deleting(p_owner text, p_machine_id_sha256 text, p_company_ids uuid[])
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	if p_company_ids is null or coalesce(array_ndims(p_company_ids), 1) <> 1 or cardinality(p_company_ids) > 500 then
		raise exception 'Code host companies invalid' using errcode = '22023'; end if;
	-- A separate check: array_position refuses an array of more than one dimension.
	if array_position(p_company_ids, null) is not null then
		raise exception 'Code host companies invalid' using errcode = '22023'; end if;
	return array(select deletion.profile_id from public.qorpera_company_deletions deletion
		where deletion.profile_id = any(p_company_ids) order by deletion.profile_id);
end
$$;
revoke all on function public.qorpera_code_hosts_deleting(text, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_code_hosts_deleting(text, text, uuid[]) to service_role;
