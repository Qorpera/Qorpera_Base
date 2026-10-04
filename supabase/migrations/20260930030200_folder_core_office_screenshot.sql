-- Company folder core, C1c-3l part 3 (the coordinator's audit P06c): an agent's screenshot of the Company Computer on a
-- folder-v2 company goes back to the model only (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.15; plan
-- outputs/company-accounts/p06-office-folder-v2-plan.md).
--
-- Before, qorpera_native_office_capture refused folder-v2 with 0A000 after the screenshot operation's receipt had begun:
-- the model got an unconfirmed outcome and the open receipt blocked the run's later operations. On folder-v2 now:
-- * The capture stores nothing and registers no artifact: its authorize answers {state: authorized, storage: none} (the
--   runtime then uploads no object), and its publish answers the image's identity under the operation's receipt (the
--   asset id is the receipt id). The operation completes its receipt with that answer, as for any other tool.
-- * qorpera_folder_office_capture(binding, asset): the identity back from the completed receipt of this run, its
--   computer resource drained and the computer still the agent's. The capture read and the capture-set check use it, so
--   the runtime keeps checking a screenshot's authority before each model request; the pixels never leave the host,
--   which keeps them only until it has handed them to the model.
-- Saving a screenshot into the company folder stays with capture and export (C1d, C3). Folder-v2 only (the founder's
-- decision of 3 October): the statements that were there before stay in their else. Each patched function and the new
-- helper name this migration (20260930030200) in their bodies, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.c1c3l3_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3l part 3 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A screenshot's identity from its receipt --------------------------------------------------------------------------

create function public.qorpera_folder_office_capture(p_binding jsonb, p_asset_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority jsonb := public.qorpera_describe_native_tool_authority(p_binding);
	v_descriptor jsonb := public.qorpera_native_office_descriptor(p_binding);
	v_receipt public.qorpera_run_operation_receipts%rowtype; v_resource public.qorpera_runtime_office_resources%rowtype;
	v_asset jsonb;
begin
	-- C1c-3l (20260930030200): a folder-v2 screenshot is its completed receipt's answer; nothing else is stored.
	select * into v_receipt from public.qorpera_run_operation_receipts where id = p_asset_id;
	select * into v_resource from public.qorpera_runtime_office_resources where receipt_id = p_asset_id;
	v_asset := v_receipt.result #> '{content,value}';
	if v_receipt.id is null or v_receipt.run_id::text is distinct from p_binding ->> 'runId' or v_receipt.status <> 'completed'
		or v_receipt.operation_kind <> 'cloud_tool' or v_receipt.logical_operation_key not like 'computer_screenshot:%'
		or v_receipt.result is distinct from jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1',
			'inputSha256', v_receipt.input_sha256, 'content', jsonb_build_object('kind', 'json', 'value', v_asset))
		or jsonb_typeof(v_asset) is distinct from 'object'
		or (select string_agg(key, ',' order by key) from jsonb_object_keys(v_asset) as key)
			is distinct from 'assetId,bytes,height,mediaType,screenId,sha256,surface,width'
		or v_asset ->> 'assetId' is distinct from p_asset_id::text
		or v_resource.id is null or v_resource.state <> 'drained' or v_resource.run_id is distinct from v_receipt.run_id
		or v_resource.screen_id::text is distinct from v_asset ->> 'screenId'
		or v_authority #>> '{identity,audienceKind}' is distinct from 'company'
		or v_descriptor ->> 'state' is distinct from 'available'
		or v_descriptor #>> '{scope,companyComputerId}' is distinct from v_resource.office_id::text then
		raise exception 'Office capture authority changed' using errcode = '42501'; end if;
	return v_asset;
end $$;
revoke all on function public.qorpera_folder_office_capture(jsonb, uuid) from public, anon, authenticated, service_role;

-- 2. The capture, its read and the capture-set check on folder-v2 -------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3l3_replace('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- C1c-3l (20260930030200): serves folder-v2; a screenshot there goes back to the model only (below).\n', 1);
	perform pg_temp.c1c3l3_replace('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>''sha256'',(p_image->>''bytes'')::bigint);\n',
		E'\t-- C1c-3l (20260930030200): on folder-v2 nothing is stored and no artifact is registered; the answer names the\n'
		|| E'\t-- operation\'s receipt, which the operation completes with it.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tif p_action=''authorize'' then return ''{"state":"authorized","storage":"none"}''::jsonb; end if;\n'
		|| E'\t\tv_result:=jsonb_build_object(''assetId'',p_receipt_id,''sha256'',p_image->>''sha256'',''bytes'',(p_image->>''bytes'')::bigint,\n'
		|| E'\t\t\t''mediaType'',''image/png'',''screenId'',p_lease#>>''{binding,screenId}'',''surface'',v_operation#>>''{arguments,surface}'',\n'
		|| E'\t\t\t''width'',(p_image->>''width'')::integer,''height'',(p_image->>''height'')::integer);\n'
		|| E'\t\tperform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,''check'',p_receipt_id,p_idempotency_sha256);\n'
		|| E'\t\treturn v_result;\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>''sha256'',(p_image->>''bytes'')::bigint);\n', 1);
	perform pg_temp.c1c3l3_replace('public.qorpera_read_native_office_capture(jsonb,uuid)',
		E'\tperform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>''{identity,companyId}'')::uuid);\n',
		E'\t-- C1c-3l (20260930030200): on folder-v2 the screenshot\'s receipt is its record.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tv_result:=public.qorpera_folder_office_capture(p_binding,p_asset_id);\n'
		|| E'\t\tperform public.qorpera_describe_native_tool_authority(p_binding);\n'
		|| E'\t\treturn v_result;\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>''{identity,companyId}'')::uuid);\n', 1);
	perform pg_temp.c1c3l3_replace('public.qorpera_assert_native_office_captures(jsonb,jsonb)',
		E'\t-- Run-level authority, office and object access once for the whole set.\n',
		E'\t-- C1c-3l (20260930030200): on folder-v2 each screenshot\'s receipt is its record.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tfor v_asset in select value from jsonb_array_elements(p_assets) loop\n'
		|| E'\t\t\tif jsonb_typeof(v_asset) is distinct from ''object'' or coalesce(v_asset->>''assetId'','''')!~''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'' then\n'
		|| E'\t\t\t\traise exception ''Native capture invalid'' using errcode=''22023''; end if;\n'
		|| E'\t\t\tv_current:=public.qorpera_folder_office_capture(p_binding,(v_asset->>''assetId'')::uuid);\n'
		|| E'\t\t\tif v_current is distinct from v_asset then raise exception ''Native capture evidence changed'' using errcode=''42501''; end if;\n'
		|| E'\t\t\tv_bytes:=v_bytes+(v_current->>''bytes'')::bigint;\n'
		|| E'\t\t\tif v_bytes>134217728 then raise exception ''Native capture byte budget exceeded'' using errcode=''54000''; end if;\n'
		|| E'\t\tend loop;\n'
		|| E'\t\tperform public.qorpera_describe_native_tool_authority(p_binding);\n'
		|| E'\t\treturn jsonb_build_object(''state'',''authorized'',''assets'',p_assets);\n'
		|| E'\tend if;\n'
		|| E'\t-- Run-level authority, office and object access once for the whole set.\n', 1);
end $$;

drop function pg_temp.c1c3l3_replace(regprocedure, text, text, integer);
