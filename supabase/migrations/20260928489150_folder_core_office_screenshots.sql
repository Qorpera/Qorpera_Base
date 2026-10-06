-- Company folder core, P06d part 2 (A1; design approved by the coordinator on 4 October): Company Computer screenshots
-- on a folder-v2 company, stored nowhere (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.21). The runtime half
-- (P06d part 1, §6.19) carries the PNG from the office service to the native host in the screenshot's own perform
-- answer, and the host keeps it in memory until the model has it. This migration gives that path its authority and
-- lifts C1c-3l part 3's refusal (20260930030200). Apply it only once every office runs the P06d part 1 office code: an
-- older office service fails on `storage: none` and leaves its receipt open.
--
-- * The screenshot's receipt is its record. qorpera_native_office_capture's folder-v2 branch authorizes with
--   {state: authorized, storage: none} (no upload) and publishes the image's identity under the operation's receipt
--   (assetId = the receipt id). No artifact, capture row, retention hold or company object is created.
-- * At begin, a folder-v2 screenshot's office resource keeps the office resources it is taken under (target_resources:
--   the office grant and its version, the privacy version, and a browser grant if any).
-- * qorpera_folder_office_captures_checked(binding, authority, assets) checks a set of screenshots with one authority
--   read and plain reads: each is this run's completed receipt with exactly that answer, its resource drained on the
--   same run and screen, and the resources it was taken under still current (the agent's access at the same grant and
--   version, the computer still shared at the same privacy version, the browser grant still active). It does not ask
--   that the computer be running (the coordinator's decision of 4 October): an idle power-off must not end a run that
--   took a screenshot, while a grant change, a privacy change or a member's private session still withdraws it.
-- * The capture read, the capture-set check and the folder-v2 context view use it. The context view records a
--   screenshot output only when the set check holds (it refused every screenshot before).
--
-- Folder-v2 only (the founder's decision of 3 October): the statements that were there before stay in their else. Each
-- patched function and the new one name this migration (20260930057000) in their bodies, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.p06d2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'P06d part 2 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The resources a screenshot is taken under -------------------------------------------------------------------------

alter table public.qorpera_runtime_office_resources add column target_resources jsonb
	check (target_resources is null or jsonb_typeof(target_resources) = 'object');

-- 2. The set check -----------------------------------------------------------------------------------------------------

create function public.qorpera_folder_office_captures_checked(p_binding jsonb, p_authority jsonb, p_assets jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
	v_asset jsonb; v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_resource public.qorpera_runtime_office_resources%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_target jsonb; v_agent uuid := (p_authority #>> '{identity,staffAgentId}')::uuid;
begin
	-- P06d (20260930057000): plain reads, no lock; the caller read the run's authority once for the whole set.
	if p_authority #>> '{identity,audienceKind}' is distinct from 'company' or jsonb_typeof(p_assets) is distinct from 'array' then
		raise exception 'Office capture authority changed' using errcode = '42501'; end if;
	for v_asset in select value from jsonb_array_elements(p_assets) loop
		if jsonb_typeof(v_asset) is distinct from 'object'
			or (select string_agg(key, ',' order by key) from jsonb_object_keys(v_asset) as key)
				is distinct from 'assetId,bytes,height,mediaType,screenId,sha256,surface,width'
			or coalesce(v_asset ->> 'assetId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Native capture invalid' using errcode = '22023'; end if;
		select * into v_receipt from public.qorpera_run_operation_receipts where id = (v_asset ->> 'assetId')::uuid;
		select * into v_resource from public.qorpera_runtime_office_resources where receipt_id = (v_asset ->> 'assetId')::uuid;
		select * into v_office from public.qorpera_runtime_offices where id = v_resource.office_id;
		v_target := v_resource.target_resources;
		if v_receipt.id is null or v_receipt.run_id::text is distinct from p_binding ->> 'runId' or v_receipt.status <> 'completed'
			or v_receipt.operation_kind <> 'cloud_tool' or v_receipt.logical_operation_key not like 'computer_screenshot:%'
			or v_receipt.result is distinct from jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1',
				'inputSha256', v_receipt.input_sha256, 'content', jsonb_build_object('kind', 'json', 'value', v_asset))
			or v_resource.id is null or v_resource.state <> 'drained' or v_resource.run_id is distinct from v_receipt.run_id
			or v_resource.screen_id::text is distinct from v_asset ->> 'screenId' or jsonb_typeof(v_target) is distinct from 'object'
			-- The computer is still the company's and shared, at the privacy version the screenshot was taken under.
			or v_office.id is null or v_office.profile_id::text is distinct from p_authority #>> '{identity,companyId}'
			or v_office.privacy_state <> 'shared' or v_office.privacy_version::text is distinct from v_target ->> 'officePrivacyVersion'
			-- The agent still has its access, at the same grant and version.
			or not exists (select 1 from public.qorpera_runtime_office_access as access where access.office_id = v_office.id
				and access.staff_agent_id = v_agent and access.state = 'active'
				and access.grant_id::text = v_target ->> 'officeGrantId' and access.version::text = v_target ->> 'officeGrantVersion')
			-- A browser screenshot's browser grant is still active, at the same version, on the same prepared profile.
			or (v_target ? 'browserGrantId' and not exists (select 1 from public.qorpera_runtime_browser_grants as g
				join public.qorpera_runtime_browser_profiles as p on p.id = g.profile_id and p.office_id = g.office_id
				left join public.qorpera_profile_members as m on m.profile_id = v_office.profile_id and m.user_id = p.owner_user_id
				where g.office_id = v_office.id and g.staff_agent_id = v_agent and g.state = 'active'
					and g.id::text = v_target ->> 'browserGrantId' and g.version::text = v_target ->> 'browserGrantVersion'
					and g.profile_id::text = v_target ->> 'browserProfileId' and p.prepared and g.profile_version = p.version
					and (p.company_owned or (m.user_id is not null and g.owner_membership_version = coalesce((select r.version
						from public.qorpera_runtime_browser_membership_revocations as r
						where r.profile_id = v_office.profile_id and r.user_id = p.owner_user_id), 0))))) then
			raise exception 'Office capture authority changed' using errcode = '42501'; end if;
	end loop;
end $$;
revoke all on function public.qorpera_folder_office_captures_checked(jsonb, jsonb, jsonb)
	from public, anon, authenticated, service_role;

-- 3. The operation: screenshots serve folder-v2, and keep the resources they are taken under ---------------------------

do $$
begin
	perform pg_temp.p06d2_replace('public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)',
		E'\t-- C1c-3l (20260930030200): no screenshot on folder-v2 yet. Its authorize, before the receipt begins, answers a\n'
		|| E'\t-- refusal in words for the model; every later step raises.\n'
		|| E'\tif v_operation#>>''{arguments,kind}''=''screenshot'' and public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tif p_action=''authorize'' then\n'
		|| E'\t\t\treturn jsonb_build_object(''state'',''refused'',''message'',\n'
		|| E'\t\t\t\t''Screenshots are not available on this computer yet. For a web page, use a browser snapshot instead.'');\n'
		|| E'\t\tend if;\n'
		|| E'\t\traise exception ''Screenshots are not available on this computer yet'' using errcode=''0A000'';\n'
		|| E'\tend if;\n',
		E'\t-- P06d (20260930057000): screenshots serve folder-v2 (C1c-3l part 3''s refusal, 20260930030200, is lifted).\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)',
		E'\t\t\tp_binding,p_lease-''validForMs'',v_sha,p_idempotency_sha256,''active'',v_until) returning * into v_resource;\n',
		E'\t\t\tp_binding,p_lease-''validForMs'',v_sha,p_idempotency_sha256,''active'',v_until) returning * into v_resource;\n'
		|| E'\t\t-- P06d (20260930057000): a folder-v2 screenshot keeps the office resources it is taken under: its record''s check.\n'
		|| E'\t\tif v_operation#>>''{arguments,kind}''=''screenshot'' and public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\t\tupdate public.qorpera_runtime_office_resources set target_resources=v_operation#>''{target,resources}''\n'
		|| E'\t\t\twhere id=v_resource.id returning * into v_resource;\n'
		|| E'\t\tend if;\n', 1);
end $$;

-- 4. The capture, its read and the capture-set check on folder-v2 -------------------------------------------------------

do $$
begin
	perform pg_temp.p06d2_replace('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- P06d (20260930057000): serves folder-v2; a screenshot there is stored nowhere (below).\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)',
		E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>''sha256'',(p_image->>''bytes'')::bigint);\n',
		E'\t-- P06d (20260930057000): on folder-v2 nothing is stored and no artifact is registered. The office service keeps the\n'
		|| E'\t-- pixels for the perform answer, and the answer names the operation''s receipt, which the operation completes with\n'
		|| E'\t-- it: the receipt is the capture''s record.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tif p_action=''authorize'' then return ''{"state":"authorized","storage":"none"}''::jsonb; end if;\n'
		|| E'\t\tv_result:=jsonb_build_object(''assetId'',p_receipt_id,''sha256'',p_image->>''sha256'',''bytes'',(p_image->>''bytes'')::bigint,\n'
		|| E'\t\t\t''mediaType'',''image/png'',''screenId'',p_lease#>>''{binding,screenId}'',''surface'',v_operation#>>''{arguments,surface}'',\n'
		|| E'\t\t\t''width'',(p_image->>''width'')::integer,''height'',(p_image->>''height'')::integer);\n'
		|| E'\t\tperform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,''check'',p_receipt_id,p_idempotency_sha256);\n'
		|| E'\t\treturn v_result;\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_authorize_native_company_object_upload(p_binding,v_company,p_image->>''sha256'',(p_image->>''bytes'')::bigint);\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_read_native_office_capture(jsonb,uuid)',
		E'\tperform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>''{identity,companyId}'')::uuid);\n',
		E'\t-- P06d (20260930057000): on folder-v2 the screenshot''s receipt is its record.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tselect result#>''{content,value}'' into v_result from public.qorpera_run_operation_receipts\n'
		|| E'\t\twhere id=p_asset_id and run_id::text=p_binding->>''runId'';\n'
		|| E'\t\tif jsonb_typeof(v_result) is distinct from ''object'' or v_result->>''assetId'' is distinct from p_asset_id::text then\n'
		|| E'\t\t\traise exception ''Office capture authority changed'' using errcode=''42501''; end if;\n'
		|| E'\t\tperform public.qorpera_folder_office_captures_checked(p_binding,v_authority,jsonb_build_array(v_result));\n'
		|| E'\t\tperform public.qorpera_describe_native_tool_authority(p_binding);\n'
		|| E'\t\treturn v_result;\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>''{identity,companyId}'')::uuid);\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_assert_native_office_captures(jsonb,jsonb)',
		E'\t-- Run-level authority, office and object access once for the whole set.\n',
		E'\t-- P06d (20260930057000): on folder-v2 each screenshot''s receipt is its record, checked as one set.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tperform public.qorpera_folder_office_captures_checked(p_binding,v_authority,p_assets);\n'
		|| E'\t\tif (select sum((value->>''bytes'')::bigint) from jsonb_array_elements(p_assets))>134217728 then\n'
		|| E'\t\t\traise exception ''Native capture byte budget exceeded'' using errcode=''54000''; end if;\n'
		|| E'\t\tperform public.qorpera_describe_native_tool_authority(p_binding);\n'
		|| E'\t\treturn jsonb_build_object(''state'',''authorized'',''assets'',p_assets);\n'
		|| E'\tend if;\n'
		|| E'\t-- Run-level authority, office and object access once for the whole set.\n', 1);
end $$;

-- 5. The folder-v2 context view records a screenshot it can check -------------------------------------------------------

do $$
begin
	-- The declaration first: each patch recreates the function, which must compile.
	perform pg_temp.p06d2_replace('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)',
		E'\tv_output jsonb; v_output_sha text;\n',
		E'\tv_output jsonb; v_output_sha text; v_captures jsonb := ''[]''::jsonb; /* P06d 20260930057000 */\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)',
		E'\t\tif v_output ? ''capture'' then\n'
		|| E'\t\t\traise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t\t-- P06d (20260930057000): a screenshot output is checked with the others after the loop.\n'
		|| E'\t\tif v_output ? ''capture'' then\n'
		|| E'\t\t\tif jsonb_typeof(v_output -> ''capture'') is distinct from ''object'' or coalesce(v_output #>> ''{capture,assetId}'', '''')\n'
		|| E'\t\t\t\t\t!~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'' then\n'
		|| E'\t\t\t\traise exception ''Native capture invalid'' using errcode = ''22023''; end if;\n'
		|| E'\t\t\tv_captures := v_captures || jsonb_build_array(v_output -> ''capture'');\n'
		|| E'\t\tend if;\n', 1);
	perform pg_temp.p06d2_replace('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)',
		E'\t\traise exception ''Duplicate context output'' using errcode = ''22023''; end if;\n',
		E'\t\traise exception ''Duplicate context output'' using errcode = ''22023''; end if;\n'
		|| E'\t-- P06d (20260930057000): the view''s screenshots, as one set, with the run''s authority read once.\n'
		|| E'\tif jsonb_array_length(v_captures) > 0 then\n'
		|| E'\t\tperform public.qorpera_folder_office_captures_checked(p_binding, public.qorpera_describe_native_tool_authority(p_binding),\n'
		|| E'\t\t\tv_captures);\n'
		|| E'\tend if;\n', 1);
end $$;

drop function pg_temp.p06d2_replace(regprocedure, text, text, integer);
