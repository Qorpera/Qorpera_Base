-- Company folder core, C1d-2c part 1: bytes with no catalog row (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9.9).
-- A NAS put whose confirm never ran (a stop or a lock timeout at confirm, or a writer that gave up) leaves the object's
-- bytes outside the catalog, and the object gateway's journal entry ends `blocked`, since folder replication refuses a
-- missing row. The gateway's folder GC asks, under the object's journal lock (an upload holds it from its put to its
-- confirm), what the catalog says of each blocked object, and removes a folder-v2 object's bytes once it has been
-- missing for the grace window. Inert: no folder-v2 company exists yet.

set local lock_timeout = '3s';

-- What the catalog says of an object the gateway holds bytes or a blocked entry for:
-- * 'catalogued': it has a catalog row; its entry is blocked for another reason, and folder GC leaves it;
-- * 'other': no row, in a company folder GC does not serve (snapshot-v1, mixed, being deleted, or purged:
--   qorpera_folder_gc_company); left as it is (a deleted company's leftovers are part 2's);
-- * 'listed': no row, but an upload intent that is open, or that ended less than the grace window ago, lists it: the
--   same window in which the intent roots its objects (qorpera_folder_object_rooted), kept here so folder GC's two
--   views of an object's roots agree (a writer can confirm only while its intent is open);
-- * 'missing': none of these.
-- Service role only; plain reads through the catalog key and the intent objects' hash index; no locks.
create function public.qorpera_folder_gc_catalog_state(p_profile_id uuid, p_sha256 text)
returns text language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_profile_id is null or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Folder object is invalid' using errcode = '22023'; end if;
	if exists (select 1 from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256) then
		return 'catalogued'; end if;
	if not public.qorpera_folder_gc_company(p_profile_id) then return 'other'; end if;
	if exists (select 1 from public.qorpera_folder_upload_intent_objects o
		join public.qorpera_folder_upload_intents i on i.id = o.intent_id
		where o.profile_id = p_profile_id and o.sha256 = p_sha256
			and i.expires_at > clock_timestamp() - interval '24 hours') then
		return 'listed'; end if;
	return 'missing';
end $$;

revoke all on function public.qorpera_folder_gc_catalog_state(uuid, text) from public, anon, authenticated;
grant execute on function public.qorpera_folder_gc_catalog_state(uuid, text) to service_role;
