-- 20260930450000: the legacy sweep, step E3 (the object gateway's raw object functions). Snapshot-v1 only (folder-v2
-- only, the founder's decision of 3 October): a member read or uploaded a company object by its hash, a read lease
-- handed such a read to the gateway, and a member listed and read the office's shared file exports. A folder-v2
-- company keeps its bytes in its company folder, which only the folder core serves (C1c-1, 20260928259430, made the raw
-- read, the upload and the read lease refuse it). E3 (#1128) removed the gateway's GET and PUT /v1/profile-objects, its
-- read leases and their revocation, the verifier token, and the member file export route with the bridge's; nothing
-- else calls these functions, so they go whole.
-- 1. Dropped: the member's raw object download and upload authorizations (20260828005000, 20260822004000), the read
--    lease (20260828007000), and the member's shared export source and list (20260908003400, on the run actor since
--    20260928279470).
-- 2. The snapshot-v1 office capture check (qorpera_native_office_capture_checked, 20260924130000) still called the
--    download for its object. Its call becomes a 0A000 refusal, as 20260928519150 did for the native object routes, so
--    no body names a dropped function. Legacy sweep F2b (20260930291000) took its other callers; the one left is the
--    snapshot-v1 tail of qorpera_record_native_context_view, which serves folder-v2 first (20260928279560) and whose
--    text the runtime bundle activation pins, so it stays as it is.
-- Kept: qorpera_authorize_profile_object_deletion (DELETE /v1/profile-objects, for folder GC and erasure), the upload
-- confirmation, the replication functions and the replica guard the gateway still uses, the folder-v2 member object
-- routes, the office's file exports, and the helpers the dropped functions shared with others
-- (qorpera_can_read_profile, qorpera_company_uses_path_gateway, qorpera_profile_object_writes_allowed,
-- qorpera_profile_storage_is_unlimited, qorpera_company_run_actor, qorpera_lock_profile_gc_fence,
-- qorpera_runtime_office_file_export_json, qorpera_object_exists). Read leases had no table: the gateway kept them in
-- its own journal.
-- The patched body names this migration (20260930450000).
set local lock_timeout = '3s';

-- 2. The snapshot-v1 office capture check refuses instead of calling the download. -----------------------------------

do $$
declare
	v_target constant regprocedure := 'public.qorpera_native_office_capture_checked(uuid,jsonb,jsonb,jsonb)'::regprocedure;
	v_old constant text := E'\tperform public.qorpera_authorize_profile_object_download(v_asset.profile_id,v_asset.content_sha256);\n';
	v_definition text := pg_get_functiondef(v_target);
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Legacy sweep E3 anchor found % time(s) in %, expected 1',
			(length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old), v_target; end if;
	execute replace(v_definition, v_old,
		E'\t-- 20260930450000 (legacy sweep E3): raw object reads are gone, so a snapshot-v1 capture check is refused.\n'
		|| E'\traise exception ''Company objects are no longer served'' using errcode=''0A000'';\n');
end $$;

-- 1. The member's raw object reads and uploads, the read lease, and the member's shared exports. -------------------

drop function public.qorpera_issue_profile_object_read_lease(uuid,text,integer);
drop function public.qorpera_authorize_profile_object_download(uuid,text);
drop function public.qorpera_authorize_profile_object_upload(uuid,text,bigint);
drop function public.qorpera_list_member_file_exports(uuid,uuid,integer);
drop function public.qorpera_member_file_export_source(uuid,jsonb);

-- Nothing by these names is left (no other overload), nothing that runs still names one, and the patch landed.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and (procedure.proname in ('qorpera_authorize_profile_object_download', 'qorpera_authorize_profile_object_upload',
					'qorpera_issue_profile_object_read_lease', 'qorpera_member_file_export_source',
					'qorpera_list_member_file_exports')
				or procedure.prosrc ~ ('qorpera_authorize_profile_object_(download|upload)\M'
					|| '|qorpera_issue_profile_object_read_lease\M|qorpera_member_file_export_source\M'
					|| '|qorpera_list_member_file_exports\M'))
	loop
		raise exception 'Function % is or names a function legacy sweep E3 dropped', v_name;
	end loop;
	if pg_get_functiondef('public.qorpera_native_office_capture_checked(uuid,jsonb,jsonb,jsonb)'::regprocedure)
			not like '%20260930450000%' then
		raise exception 'Legacy sweep E3: the office capture check patch did not land'; end if;
end $$;
