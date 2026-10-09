-- Legacy removal, step C: the native host's company object route is gone from both ends. The object gateway's
-- /v1/native-company-objects route and its authority methods, and the runtime's HttpNativeCompanyObjectTransport, go in
-- the same pull request. This migration drops what they called (20260828008000):
-- qorpera_authorize_native_company_object_upload, qorpera_confirm_native_company_object_upload and
-- qorpera_authorize_native_company_object_download.
--
-- They served snapshot-v1 only: each refuses a folder-v2 company (20260928259430), and a folder-v2 run's bytes go
-- through the object gateway's folder route. Three snapshot-v1 tails still call one of them:
-- * the office screenshot (qorpera_native_office_capture), after its folder-v2 branch (20260928489150);
-- * the office file export (qorpera_native_office_file_export), which refuses folder-v2 first (20260928279470);
-- * its shared source (qorpera_native_shared_file_export_source), which refuses folder-v2 first (20260928279470).
-- Each call becomes a 0A000 refusal, so those snapshot-v1 tails now refuse, and folder-v2 behaves exactly as before.
-- Step F removes the tails. The object RPC lock budget (20260928339630) drops the three names.
-- qorpera_native_company_object_actor stays: the snapshot-v1 capture read and capture-set check still call it.
--
-- Every patched body carries the marker 20260930190000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.objects_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Native company object removal: patch anchor not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
begin
	perform pg_temp.objects_replace('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>''sha256'',(p_image->>''bytes'')::bigint);\n',
		E'\t-- 20260930190000: company objects are gone, so a snapshot-v1 screenshot is refused.\n'
		|| E'\traise exception ''Company objects are no longer served'' using errcode=''0A000'';\n');
	perform pg_temp.objects_replace('public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_file->>''sha256'',(p_file->>''bytes'')::bigint);\n',
		E'\t-- 20260930190000: company objects are gone, so a snapshot-v1 file export is refused.\n'
		|| E'\traise exception ''Company objects are no longer served'' using errcode=''0A000'';\n');
	perform pg_temp.objects_replace('public.qorpera_native_shared_file_export_source(jsonb,jsonb)',
		E' v_download:=public.qorpera_authorize_native_company_object_download(p_binding,v_asset.profile_id,v_asset.content_sha256);\n',
		E' -- 20260930190000: company objects are gone, so a snapshot-v1 shared export source is refused.\n'
		|| E' raise exception ''Company objects are no longer served'' using errcode=''0A000'';\n');
	perform pg_temp.objects_replace('public.qorpera_object_rpc_lock_budget()',
		E'\t\t''qorpera_authorize_native_company_object_upload'',\n'
		|| E'\t\t''qorpera_confirm_native_company_object_upload'',\n'
		|| E'\t\t''qorpera_authorize_native_company_object_download'',\n',
		E'\t\t-- 20260930190000: the native company object RPCs are gone.\n');
end $$;

drop function public.qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint);
drop function public.qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint);
drop function public.qorpera_authorize_native_company_object_download(jsonb,uuid,text);

-- No function calls the dropped ones (PL/pgSQL bodies are not dependency-tracked), and the four patches landed.
do $$
begin
	if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
			and (p.proname like 'qorpera\_%native\_company\_object\_upload' or p.proname = 'qorpera_authorize_native_company_object_download'
				or p.prosrc like '%qorpera\_authorize\_native\_company\_object\_%' or p.prosrc like '%qorpera\_confirm\_native\_company\_object\_%')) then
		raise exception 'Native company object removal left a function or a caller'; end if;
	if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%20260930190000%'
			and p.oid in ('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)'::regprocedure,
				'public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)'::regprocedure,
				'public.qorpera_native_shared_file_export_source(jsonb,jsonb)'::regprocedure,
				'public.qorpera_object_rpc_lock_budget()'::regprocedure)) <> 4 then
		raise exception 'Native company object removal: a patch did not land'; end if;
end $$;
