-- Company folder core: which files one commit kept as conflict copies (P17, 20260930042000), for the node's folder
-- service (F3 step 3c-2, deploy/first-node/RUNTIME-FOLDER-WRITES.md "A boundary"). The service drops a conflicting
-- save's pending bytes only once every file of the unit is on the receipt. The commit's answer cannot say (P17 leaves its
-- units JSON unchanged), and an object's download check cannot either: the platform may download any catalogued object,
-- and a member any object some readable path names. So the service asks for the receipt's rows.
-- * Service role only. It reads one commit's rows in one environment, by the commit's key (the table's primary key
--   starts with the commit), and returns them in unit and file order: {unit, file, path, manifestSha256}.
-- * A plain read: no lock beyond the snapshot, no write.

set local lock_timeout = '3s';

create function public.qorpera_folder_conflict_copies_of(p_environment_id uuid, p_commit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or p_commit_id is null then raise exception 'Environment and commit are required' using errcode = '22023'; end if;
	return (select coalesce(jsonb_agg(jsonb_build_object('unit', k.unit_no, 'file', k.file_no, 'path', k.path,
			'manifestSha256', k.manifest_sha256) order by k.unit_no, k.file_no), '[]'::jsonb)
		from public.qorpera_folder_conflict_copies k
		where k.commit_id = p_commit_id and k.environment_id = p_environment_id);
end $$;

revoke all on function public.qorpera_folder_conflict_copies_of(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_conflict_copies_of(uuid, uuid) to service_role;
