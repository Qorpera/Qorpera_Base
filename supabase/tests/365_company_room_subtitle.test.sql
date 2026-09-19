-- Exercise canonical room projection and the member-readable room contract.
-- An archived room avoids unrelated conversation/bootstrap setup; its document
-- uses the same production validation and revision rules as an active room.
begin;

insert into auth.users(id,email) values
	('36500000-0000-4000-8000-000000000001','room-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('36500000-0000-4000-8000-000000000010','Room subtitle fixture','36500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('36500000-0000-4000-8000-000000000010','36500000-0000-4000-8000-000000000001',
		'room-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('36500000-0000-4000-8000-000000000020','36500000-0000-4000-8000-000000000010',
		'Environment',1,'36500000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims',
	'{"role":"authenticated","sub":"36500000-0000-4000-8000-000000000001"}',true);

create function pg_temp.project_room_subtitle(p_document jsonb)
returns void language plpgsql as $$
declare v_text text := p_document::text;
begin
	perform public.qorpera_project_organization_document(
		'{"companyId":"36500000-0000-4000-8000-000000000010","environmentId":"36500000-0000-4000-8000-000000000020","userId":"36500000-0000-4000-8000-000000000001"}',
		jsonb_build_object('path','organization/rooms/36500000-0000-4000-8000-000000000030.json',
			'entry',jsonb_build_object('kind','file','file',jsonb_build_object(
				'fileSha256',encode(extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')))),
		v_text,'36500000-0000-4000-8000-000000000040',extensions.gen_random_uuid());
end
$$;

do $$
declare
	v_document jsonb := '{"schema":"qorpera.company-room/v1","roomId":"36500000-0000-4000-8000-000000000030","key":"subtitle-test","name":"Planning","purpose":"Plan the launch","status":"archived","projectId":null,"members":[],"version":1}';
	v_read jsonb;
	v_invalid jsonb;
begin
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read is null or v_read ? 'subtitle' then
		raise exception 'Rooms without a subtitle must retain the client default'; end if;

	v_document := v_document || '{"subtitle":"Launch coordination","version":2}';
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read->>'subtitle' is distinct from 'Launch coordination' or v_read->>'version' is distinct from '2' then
		raise exception 'Canonical subtitle write must survive a new member read'; end if;

	v_document := v_document || '{"name":"Launch planning","version":3}';
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read->>'name' is distinct from 'Launch planning' or v_read->>'subtitle' is distinct from 'Launch coordination' then
		raise exception 'Renaming a canonical room must preserve its subtitle'; end if;

	v_document := v_document || '{"subtitle":"","version":4}';
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read->>'subtitle' is distinct from '' then
		raise exception 'An explicitly cleared subtitle must remain empty'; end if;

	v_document := (v_document - 'subtitle') || '{"version":5}';
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read is null or v_read ? 'subtitle' then
		raise exception 'Removing the optional subtitle must restore the default'; end if;

	-- JSON null, nonstrings, excessive length and unknown document fields are
	-- rejected before either the projection or its revision can advance.
	for v_invalid in select value from jsonb_array_elements(jsonb_build_array(
		'{"subtitle":null}'::jsonb,'{"subtitle":42}'::jsonb,'{"subtitle":[]}'::jsonb,
		'{"subtitle":{}}'::jsonb,jsonb_build_object('subtitle',repeat('x',257)),
		'{"subtitle":"Valid","unsupported":true}'::jsonb)) loop
		begin
			perform pg_temp.project_room_subtitle(v_document || v_invalid || '{"version":6}');
			raise exception 'Invalid room subtitle document was accepted: %',v_invalid;
		exception when sqlstate '22023' then null;
		end;
	end loop;
	if public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0 is distinct from v_read then
		raise exception 'Rejected subtitle edits must leave room content and revision unchanged'; end if;

	-- The SQL and web bounds count Unicode characters, rather than UTF-8 bytes.
	v_document := v_document || jsonb_build_object('subtitle',repeat('é',256),'version',6);
	perform pg_temp.project_room_subtitle(v_document);
	v_read := public.qorpera_list_company_rooms('36500000-0000-4000-8000-000000000010')->0;
	if v_read->>'subtitle' is distinct from repeat('é',256) then
		raise exception 'A 256-character Unicode subtitle must round-trip'; end if;
end
$$;

rollback;
