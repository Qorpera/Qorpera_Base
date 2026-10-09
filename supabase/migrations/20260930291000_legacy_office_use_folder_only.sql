-- 20260930291000: the legacy sweep, step F2b (a company computer in use). Seventeen functions keep only their folder-v2
-- path (folder-v2 only, the founder's decision of 3 October). Each is patched in place from its live text, so its
-- header, its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 1. A member's computer panel and catalog, a member's screen, the access grant and its status, a new agent's default
--    access, an agent's start and its descriptor, and the screen observer's events and retention take the folder fence
--    and the folder-v2 locks on every company; the snapshot-v1 branch, the profile gc fence, goes. A company without a
--    folder now fails in the fence ("Company folder is unavailable", 42501) or in the folder tool run.
-- 2. The Company File a computer needs (the shared surface, an agent's screen, the start descriptor) is the folder
--    core's (core = 'folder-v2'); the old path gateway's file (path_gateway_version = 1) goes.
-- 3. A screenshot's receipt is its record on every company: the capture stores nothing, and reading or checking
--    captures uses the receipts. The snapshot-v1 tails (the refusal of 20260930190000 and its dead artifact code, and
--    the object reads) go.
-- 4. Shell check-ins ask on every company, not only on folder-v2.
-- Every patched body names this migration (20260930291000).

set local lock_timeout = '3s';

create function pg_temp.f2b_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep F2b anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The folder fence and the folder-v2 locks, without their test or the profile gc fence. ----------------------------

select pg_temp.f2b_patch('public.qorpera_member_agent_office(uuid,uuid)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_company) then
			perform public.qorpera_folder_machine_fence(v_company);
		else
		perform public.qorpera_lock_profile_gc_fence(v_company);
		end if;
$old$,
$new$		-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
		perform public.qorpera_folder_machine_fence(v_company);
$new$);

select pg_temp.f2b_patch('public.qorpera_member_agent_office(uuid,uuid)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_company) then
			perform 1 from public.qorpera_profile_staff where profile_id=v_company order by staff_agent_id for key share;
		end if;
$old$,
$new$		-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
		perform 1 from public.qorpera_profile_staff where profile_id=v_company order by staff_agent_id for key share;
$new$);

select pg_temp.f2b_patch('public.qorpera_member_office_catalog(uuid,uuid)'::regprocedure,
$old$ if public.qorpera_company_is_folder_v2(v_company) then
  perform public.qorpera_folder_machine_fence(v_company);
 else
 perform public.qorpera_lock_profile_gc_fence(v_company);
 end if;
$old$,
$new$ -- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
 perform public.qorpera_folder_machine_fence(v_company);
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(v_company) then
			perform 1 from public.qorpera_profile_staff where profile_id=v_company and employment_status='active'
				order by staff_agent_id for key share;
		else
		perform public.qorpera_lock_profile_gc_fence(v_company);
		end if;
$old$,
$new$		-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
		perform 1 from public.qorpera_profile_staff where profile_id=v_company and employment_status='active'
			order by staff_agent_id for key share;
$new$);

select pg_temp.f2b_patch('public.qorpera_open_runtime_office_screen(jsonb,uuid)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		if not public.qorpera_can_write_profile(v_office.profile_id) then
			raise exception 'Office member unavailable' using errcode = '42501'; end if;
		perform public.qorpera_folder_machine_fence(v_office.profile_id);
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	end if;
$old$,
$new$	-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
	if not public.qorpera_can_write_profile(v_office.profile_id) then
		raise exception 'Office member unavailable' using errcode = '42501'; end if;
	perform public.qorpera_folder_machine_fence(v_office.profile_id);
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
$new$);

select pg_temp.f2b_patch('public.qorpera_record_runtime_screen_event(jsonb,jsonb,jsonb,jsonb)'::regprocedure,
$old$  if public.qorpera_company_is_folder_v2(v_office.profile_id) then
   perform public.qorpera_folder_machine_fence(v_office.profile_id);
  else
  perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
  end if;
$old$,
$new$  -- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
  perform public.qorpera_folder_machine_fence(v_office.profile_id);
$new$);

select pg_temp.f2b_patch('public.qorpera_retain_runtime_screen_observation(text)'::regprocedure,
$old$ if public.qorpera_company_is_folder_v2(o.profile_id) then
  perform public.qorpera_folder_machine_fence(o.profile_id);
 else
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 end if;
$old$,
$new$ -- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
 perform public.qorpera_folder_machine_fence(o.profile_id);
$new$);

select pg_temp.f2b_patch('public.qorpera_runtime_office_default_access_for_staff()'::regprocedure,
$old$		if public.qorpera_company_is_folder_v2(new.profile_id) then
			perform public.qorpera_lock_runtime_office_seats(environment.id) from public.qorpera_company_environments as environment
			where environment.profile_id = new.profile_id order by environment.id;
		end if;
$old$,
$new$		-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
		perform public.qorpera_lock_runtime_office_seats(environment.id) from public.qorpera_company_environments as environment
		where environment.profile_id = new.profile_id order by environment.id;
$new$);

select pg_temp.f2b_patch('public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean)'::regprocedure,
$old$	if public.qorpera_company_is_folder_v2(v_office.profile_id) then
		perform public.qorpera_folder_machine_fence(v_office.profile_id);
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
		perform 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id for share;
		perform public.qorpera_lock_runtime_office_seats(v_office.environment_id);
		perform 1 from public.qorpera_runtime_offices where environment_id=v_office.environment_id and state<>'retired'
			order by id for update;
	else
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	end if;
$old$,
$new$	-- 20260930291000 (legacy sweep F2b): folder-v2 only, so every company takes this path.
	perform public.qorpera_folder_machine_fence(v_office.profile_id);
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	perform 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id for share;
	perform public.qorpera_lock_runtime_office_seats(v_office.environment_id);
	perform 1 from public.qorpera_runtime_offices where environment_id=v_office.environment_id and state<>'retired'
		order by id for update;
$new$);

select pg_temp.f2b_patch('public.qorpera_runtime_office_access_status(jsonb,uuid)'::regprocedure,
$old$ -- C1c-3k (20260930019100): plain reads on folder-v2 (the setter checks again under its locks).
 if not public.qorpera_company_is_folder_v2(v_office.profile_id) then
 perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
 end if;
$old$,
$new$ -- C1c-3k (20260930019100): plain reads (the setter checks again under its locks). Legacy sweep F2b
 -- (20260930291000) removed the gc fence a snapshot-v1 company took here.
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
$old$	-- C1c-3l (20260930030000): on folder-v2 the start's members and agents FOR SHARE, before the seat lock and computers.
	if public.qorpera_binding_is_folder_v2(p_binding) then
		perform public.qorpera_folder_office_start_enter(p_binding);
	end if;
$old$,
$new$	-- C1c-3l (20260930030000): the start's members and agents FOR SHARE, before the seat lock and computers (on every
	-- company since legacy sweep F2b, 20260930291000).
	perform public.qorpera_folder_office_start_enter(p_binding);
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_start(jsonb,text,text,uuid,text)'::regprocedure,
$old$	-- C1c-3l (20260930030000): on folder-v2 the tool run holds the folder fence and the company row KEY SHARE.
	if not public.qorpera_binding_is_folder_v2(p_binding) then
	perform public.qorpera_lock_profile_gc_fence((v_authority#>>'{identity,companyId}')::uuid);
	end if;
$old$,
$new$	-- C1c-3l (20260930030000): the tool run holds the folder fence and the company row KEY SHARE. Legacy sweep F2b
	-- (20260930291000) removed the profile gc fence a snapshot-v1 start took here.
$new$);

-- 2. The Company File a computer needs is the folder core's. ----------------------------------------------------------

select pg_temp.f2b_patch('public.qorpera_check_runtime_office_shared_surface(jsonb)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3k 20260930019000 */)$old$,
$new$core='folder-v2' /* C1c-3k 20260930019000; only it since 20260930291000 */$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3k 20260930019000 */)$old$,
$new$core='folder-v2' /* C1c-3k 20260930019000; only it since 20260930291000 */$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_start_descriptor(jsonb,boolean)'::regprocedure,
$old$(path_gateway_version=1 or core='folder-v2' /* C1c-3l 20260930030000 */)$old$,
$new$core='folder-v2' /* C1c-3l 20260930030000; only it since 20260930291000 */$new$);

-- 3. A screenshot's receipt is its record on every company. -----------------------------------------------------------

select pg_temp.f2b_patch('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)'::regprocedure,
$old$	-- Shares Company File/principal/GC locks with the existing staging gateway.
	-- P06d (20260930057000): on folder-v2 nothing is stored and no artifact is registered. The office service keeps the
	-- pixels for the perform answer, and the answer names the operation's receipt, which the operation completes with
	-- it: the receipt is the capture's record.
	if public.qorpera_binding_is_folder_v2(p_binding) then
		if p_action='authorize' then return '{"state":"authorized","storage":"none"}'::jsonb; end if;
		v_result:=jsonb_build_object('assetId',p_receipt_id,'sha256',p_image->>'sha256','bytes',(p_image->>'bytes')::bigint,
			'mediaType','image/png','screenId',p_lease#>>'{binding,screenId}','surface',v_operation#>>'{arguments,surface}',
			'width',(p_image->>'width')::integer,'height',(p_image->>'height')::integer);
		perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
		return v_result;
	end if;
	-- 20260930190000: company objects are gone, so a snapshot-v1 screenshot is refused.
	raise exception 'Company objects are no longer served' using errcode='0A000';
	if p_action='authorize' then return '{"state":"authorized"}'::jsonb; end if;
	perform public.qorpera_lock_profile_gc_fence(v_company);
	if not exists(select 1 from public.qorpera_profile_objects where profile_id=v_company
		and sha256=p_image->>'sha256' and bytes=(p_image->>'bytes')::bigint)
		or not public.qorpera_object_exists(v_company,p_image->>'sha256') then
		raise exception 'Office capture object unavailable' using errcode='42501'; end if;
	select * into v_capture from public.qorpera_runtime_office_captures where receipt_id=p_receipt_id;
	if found then
		v_result:=public.qorpera_runtime_office_capture_json(v_capture);
		if v_capture.operation_envelope<>p_envelope or
			v_result-'assetId'-'screenId'-'surface' is distinct from p_image or
			v_result->>'screenId' is distinct from p_lease#>>'{binding,screenId}' or
			v_result->>'surface' is distinct from v_operation#>>'{arguments,surface}' then
			raise exception 'Office capture receipt already bound' using errcode='23505'; end if;
	else
		insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,owner_staff_agent_id,
			artifact_type,name,root_object_sha256,root_contract,content_sha256,bytes,media_type,created_by_user_id)
		values(v_company,(v_authority#>>'{identity,environmentId}')::uuid,p_receipt_id,
			(v_authority#>>'{identity,sessionId}')::uuid,(v_authority#>>'{identity,staffAgentId}')::uuid,
			'office_screenshot','Company Computer screenshot',p_image->>'sha256','qorpera.object/v1',
			p_image->>'sha256',(p_image->>'bytes')::bigint,'image/png',v_actor) returning * into v_asset;
		insert into public.qorpera_runtime_office_captures(receipt_id,artifact_id,operation_envelope,surface,width,height)
		values(p_receipt_id,v_asset.id,p_envelope,v_operation#>>'{arguments,surface}',
			(p_image->>'width')::integer,(p_image->>'height')::integer) returning * into v_capture;
		-- Retain immutable receipt evidence through the existing GC hold mechanism.
		-- No private bytes or model-supplied names enter the audit fields.
		insert into public.qorpera_artifact_retention_holds(profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
		values(v_company,v_asset.id,p_receipt_id,'Company Computer capture receipt',v_actor);
		v_result:=public.qorpera_runtime_office_capture_json(v_capture);
	end if;
	-- Lock waits and object catalog checks cannot extend the effect's validity.
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	return v_result;
$old$,
$new$	-- P06d (20260930057000): nothing is stored and no artifact is registered. The office service keeps the pixels for
	-- the perform answer, and the answer names the operation's receipt, which the operation completes with it: the
	-- receipt is the capture's record. 20260930190000 refused a snapshot-v1 screenshot (company objects are gone);
	-- legacy sweep F2b (20260930291000) removed that path, so every company takes this one.
	if p_action='authorize' then return '{"state":"authorized","storage":"none"}'::jsonb; end if;
	v_result:=jsonb_build_object('assetId',p_receipt_id,'sha256',p_image->>'sha256','bytes',(p_image->>'bytes')::bigint,
		'mediaType','image/png','screenId',p_lease#>>'{binding,screenId}','surface',v_operation#>>'{arguments,surface}',
		'width',(p_image->>'width')::integer,'height',(p_image->>'height')::integer);
	perform public.qorpera_native_office_operation(p_binding,p_scope,p_lease,p_envelope,'check',p_receipt_id,p_idempotency_sha256);
	return v_result;
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)'::regprocedure,
$old$	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_company:=(v_authority#>>'{identity,companyId}')::uuid;
	v_actor:=(v_authority#>>'{identity,requesterUserId}')::uuid;
$old$,
$new$	perform public.qorpera_describe_native_tool_authority(p_binding);
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_capture(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)'::regprocedure,
$old$declare v_operation jsonb; v_authority jsonb; v_capture public.qorpera_runtime_office_captures%rowtype;
	v_asset public.qorpera_artifacts%rowtype; v_company uuid; v_actor uuid; v_result jsonb;
$old$,
$new$declare v_operation jsonb; v_result jsonb;
$new$);

select pg_temp.f2b_patch('public.qorpera_assert_native_office_captures(jsonb,jsonb)'::regprocedure,
$old$	-- P06d (20260930057000): on folder-v2 each screenshot's receipt is its record, checked as one set.
	if public.qorpera_binding_is_folder_v2(p_binding) then
		perform public.qorpera_folder_office_captures_checked(p_binding,v_authority,p_assets);
		if (select sum((value->>'bytes')::bigint) from jsonb_array_elements(p_assets))>134217728 then
			raise exception 'Native capture byte budget exceeded' using errcode='54000'; end if;
		perform public.qorpera_describe_native_tool_authority(p_binding);
		return jsonb_build_object('state','authorized','assets',p_assets);
	end if;
	-- Run-level authority, office and object access once for the whole set.
	perform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>'{identity,companyId}')::uuid);
	v_descriptor:=public.qorpera_native_office_descriptor(p_binding);
	for v_asset in select value from jsonb_array_elements(p_assets) loop
		if jsonb_typeof(v_asset) is distinct from 'object' or coalesce(v_asset->>'assetId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Native capture invalid' using errcode='22023'; end if;
		v_current:=public.qorpera_native_office_capture_checked((v_asset->>'assetId')::uuid,p_binding,v_authority,v_descriptor);
		if v_current is distinct from v_asset then raise exception 'Native capture evidence changed' using errcode='42501'; end if;
		v_bytes:=v_bytes+(v_current->>'bytes')::bigint;
		if v_bytes>134217728 then raise exception 'Native capture byte budget exceeded' using errcode='54000'; end if;
	end loop;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','authorized','assets',p_assets);
$old$,
$new$	-- P06d (20260930057000): each screenshot's receipt is its record, checked as one set (on every company since
	-- legacy sweep F2b, 20260930291000).
	perform public.qorpera_folder_office_captures_checked(p_binding,v_authority,p_assets);
	if (select sum((value->>'bytes')::bigint) from jsonb_array_elements(p_assets))>134217728 then
		raise exception 'Native capture byte budget exceeded' using errcode='54000'; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','authorized','assets',p_assets);
$new$);

select pg_temp.f2b_patch('public.qorpera_assert_native_office_captures(jsonb,jsonb)'::regprocedure,
$old$declare v_asset jsonb; v_current jsonb; v_bytes bigint:=0; v_authority jsonb; v_descriptor jsonb;
$old$,
$new$declare v_authority jsonb;
$new$);

select pg_temp.f2b_patch('public.qorpera_read_native_office_capture(jsonb,uuid)'::regprocedure,
$old$	-- P06d (20260930057000): on folder-v2 the screenshot's receipt is its record.
	if public.qorpera_binding_is_folder_v2(p_binding) then
		select result#>'{content,value}' into v_result from public.qorpera_run_operation_receipts
		where id=p_asset_id and run_id::text=p_binding->>'runId';
		if jsonb_typeof(v_result) is distinct from 'object' or v_result->>'assetId' is distinct from p_asset_id::text then
			raise exception 'Office capture authority changed' using errcode='42501'; end if;
		perform public.qorpera_folder_office_captures_checked(p_binding,v_authority,jsonb_build_array(v_result));
		perform public.qorpera_describe_native_tool_authority(p_binding);
		return v_result;
	end if;
	perform public.qorpera_native_company_object_actor(p_binding,(v_authority#>>'{identity,companyId}')::uuid);
	v_result:=public.qorpera_native_office_capture_checked(p_asset_id,p_binding,v_authority,public.qorpera_native_office_descriptor(p_binding));
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return v_result;
$old$,
$new$	-- P06d (20260930057000): the screenshot's receipt is its record (on every company since legacy sweep F2b,
	-- 20260930291000).
	select result#>'{content,value}' into v_result from public.qorpera_run_operation_receipts
	where id=p_asset_id and run_id::text=p_binding->>'runId';
	if jsonb_typeof(v_result) is distinct from 'object' or v_result->>'assetId' is distinct from p_asset_id::text then
		raise exception 'Office capture authority changed' using errcode='42501'; end if;
	perform public.qorpera_folder_office_captures_checked(p_binding,v_authority,jsonb_build_array(v_result));
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return v_result;
$new$);

select pg_temp.f2b_patch('public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure,
$old$		-- P06d (20260930057000): a folder-v2 screenshot keeps the office resources it is taken under: its record's check.
		if v_operation#>>'{arguments,kind}'='screenshot' and public.qorpera_binding_is_folder_v2(p_binding) then
$old$,
$new$		-- P06d (20260930057000): a screenshot keeps the office resources it is taken under: its record's check (on every
		-- company since legacy sweep F2b, 20260930291000).
		if v_operation#>>'{arguments,kind}'='screenshot' then
$new$);

-- 4. Shell check-ins ask on every company. ----------------------------------------------------------------------------

select pg_temp.f2b_patch('public.qorpera_office_shell_checkins_unasked(uuid)'::regprocedure,
$old$	-- 20260930098000.
$old$,
$new$	-- 20260930098000; legacy sweep F2b (20260930291000) asks on every company (folder-v2 only).
$new$);

select pg_temp.f2b_patch('public.qorpera_office_shell_checkins_unasked(uuid)'::regprocedure,
$old$			and public.qorpera_environment_is_folder_v2(office.environment_id)
$old$,
$new$$new$);
