-- Real member, session and canonical-input functions; no substituted
-- authority helpers. Service confirmations stand in only for verified bytes.
begin;

insert into auth.users(id,email) values
	('29600000-0000-4000-8000-000000000001','path-owner@example.test'),
	('29600000-0000-4000-8000-000000000002','path-member@example.test'),
	('29600000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29600000-0000-4000-8000-000000000010','Path gateway fixture','29600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('29600000-0000-4000-8000-000000000010','29600000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('29600000-0000-4000-8000-000000000010','29600000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('29600000-0000-4000-8000-000000000010','29600000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('29600000-0000-4000-8000-000000000020','29600000-0000-4000-8000-000000000010','Environment',1,'29600000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29600000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29600000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('29600000-0000-4000-8000-000000000010',v_manifest);
	return jsonb_build_object('path',p_path,'kind','file','executable',false,'file',jsonb_build_object(
		'manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),'mediaType','application/octet-stream'));
end
$$;

create function pg_temp.path_stage_tree(p_entries jsonb)
returns text language plpgsql security definer as $$
declare v_manifest text; v_sha text;
begin
	v_manifest := jsonb_build_object('schema','qorpera.company-tree/v1','contractVersion',3,'omittedLayers',
		'["company-git-history","session-trail","staff-registry","product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb,
		'entries',p_entries)::text;
	v_sha := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29600000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('29600000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '29600000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'29600000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '29600000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('29600000-0000-4000-8000-000000000025','29600000-0000-4000-8000-000000000010',
	'29600000-0000-4000-8000-000000000020','29600000-0000-4000-8000-000000000023',
	'29600000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'29600000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '29600000-0000-4000-8000-000000000027',profile_id,'29600000-0000-4000-8000-000000000020','company_snapshot',
	'29600000-0000-4000-8000-000000000023','29600000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'29600000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '29600000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '29600000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('29600000-0000-4000-8000-000000000027','29600000-0000-4000-8000-000000000010',
	'29600000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'29600000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '29600000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '29600000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '29600000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '29600000-0000-4000-8000-000000000020');
set local role service_role;
select public.qorpera_enable_company_path_gateway('29600000-0000-4000-8000-000000000020',
	'29600000-0000-4000-8000-000000000023','29600000-0000-4000-8000-000000000001');
reset role;


create function pg_temp.attachment_denied(p_statement text,p_code text default '42501')
returns void language plpgsql as $$
declare v_state text;
begin
	begin execute p_statement;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate;
		if v_state = p_code then return; end if;
		raise;
	end;
	raise exception 'Statement unexpectedly succeeded: %',p_statement;
end
$$;

create function pg_temp.attachment_body(p_hash text,p_media text default 'image/png',p_bytes bigint default 9)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.session-prompt/v1','text','Inspect this attachment',
		'images',jsonb_build_array(jsonb_build_object('objectSha256',p_hash,'bytes',p_bytes,'mediaType',p_media)))
$$;

insert into public.qorpera_shared_sessions(id,profile_id,environment_id,title,created_by_user_id,client_session_id)
values ('29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000010',
	'29600000-0000-4000-8000-000000000020','Attachment fixture','29600000-0000-4000-8000-000000000001',
	'29600000-0000-4000-8000-000000000061');

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_table_privilege(v_role,'public.qorpera_member_session_attachment_uploads','SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Attachment proof ledger is exposed to %',v_role; end if;
	end loop;
	if has_function_privilege('authenticated','public.qorpera_stage_member_session_attachment(uuid,boolean)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_authorize_member_session_attachment(uuid,uuid,text)','EXECUTE') then
		raise exception 'Member intent and cloud verification authority are not separate'; end if;
end
$$;

-- A known catalog hash, including Company File bytes, grants no attachment.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.image_hash',pg_temp.path_stage_file('private-image','PNG_BYTES') #>> '{file,fileSha256}',true);
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.attachment_denied(format('select public.qorpera_append_session_input(%L,%L,%L,%L::jsonb)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash'))));
select set_config('qorpera_test.upload',public.qorpera_begin_member_session_attachment_upload(
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070',
	current_setting('qorpera_test.image_hash'),9,'image/png')::text,true);
select pg_temp.attachment_denied(format('select public.qorpera_append_session_input(%L,%L,%L,%L::jsonb)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash'))));
select pg_temp.attachment_denied(format('select public.qorpera_begin_member_session_attachment_upload(%L,%L,%L,9,%L)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070',
	current_setting('qorpera_test.image_hash'),'image/jpeg'),'23505');
reset role;

-- The gateway has now actually received and hashed these exact bytes.
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_stage_member_session_attachment(
	(current_setting('qorpera_test.upload')::jsonb ->> 'uploadId')::uuid,false);
select public.qorpera_stage_member_session_attachment(
	(current_setting('qorpera_test.upload')::jsonb ->> 'uploadId')::uuid,true);
reset role;

-- The proof cannot be borrowed by another human, input, or media type.
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.attachment_denied(format('select public.qorpera_append_session_input(%L,%L,%L,%L::jsonb)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash'))));
reset role;
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.attachment_denied(format('select public.qorpera_append_session_input(%L,%L,%L,%L::jsonb)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000071','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash'))));
select pg_temp.attachment_denied(format('select public.qorpera_append_session_input(%L,%L,%L,%L::jsonb)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash'),'image/jpeg')));
select set_config('qorpera_test.input',public.qorpera_append_session_input(
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000070','user_message',
	pg_temp.attachment_body(current_setting('qorpera_test.image_hash')))::text,true);
do $$
begin
	if public.qorpera_append_session_input('29600000-0000-4000-8000-000000000060',
		'29600000-0000-4000-8000-000000000070','user_message',pg_temp.attachment_body(current_setting('qorpera_test.image_hash')))
		<> current_setting('qorpera_test.input')::jsonb then raise exception 'Input retry lost its canonical identity'; end if;
end
$$;
select pg_temp.attachment_denied(format('select public.qorpera_authorize_member_session_attachment(%L,%L,%L)',
	'29600000-0000-4000-8000-000000000060',current_setting('qorpera_test.input')::jsonb ->> 'input_id',current_setting('qorpera_test.image_hash')));
reset role;

-- Only an input published into the canonical transcript may be downloaded.
select pg_temp.path_claims('service_role');
-- Exercise the unchanged private canonical-event producer as the database
-- fixture owner. Its application entrypoint is the existing run materializer.
select public.qorpera_append_execution_input_events('29600000-0000-4000-8000-000000000060',
	array[(current_setting('qorpera_test.input')::jsonb ->> 'input_id')::uuid]);
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000003');
set local role authenticated;
do $$
declare v_read jsonb;
begin
	v_read := public.qorpera_authorize_member_session_attachment('29600000-0000-4000-8000-000000000060',
		(current_setting('qorpera_test.input')::jsonb ->> 'input_id')::uuid,current_setting('qorpera_test.image_hash'));
	if v_read ->> 'companyId' <> '29600000-0000-4000-8000-000000000010' or v_read ->> 'bytes' <> '9'
		or v_read ->> 'mediaType' <> 'image/png' then raise exception 'Canonical attachment identity changed'; end if;
end
$$;
select pg_temp.attachment_denied(format('select public.qorpera_authorize_member_session_attachment(%L,%L,%L)',
	'29600000-0000-4000-8000-000000000060',current_setting('qorpera_test.input')::jsonb ->> 'input_id',repeat('a',64)));
select pg_temp.attachment_denied(format('select public.qorpera_begin_member_session_attachment_upload(%L,%L,%L,9,%L)',
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000072',current_setting('qorpera_test.image_hash'),'image/png'));
reset role;
do $$
begin
	if (select count(*) from public.qorpera_session_inputs where session_id = '29600000-0000-4000-8000-000000000060') <> 1 then
		raise exception 'Rejected/replayed attachment produced extra input'; end if;
	if not exists (select 1 from public.qorpera_company_additional_retained_object_hashes('29600000-0000-4000-8000-000000000010')
		where object_sha256 = current_setting('qorpera_test.image_hash')) then raise exception 'Accepted attachment is not retained'; end if;
end
$$;

-- Replayed old rows cannot change immutable input provenance.
select pg_temp.attachment_denied(format('update public.qorpera_session_inputs set body = %L::jsonb where id = %L',
	pg_temp.attachment_body(repeat('a',64)),current_setting('qorpera_test.input')::jsonb ->> 'input_id'));
delete from public.qorpera_profile_members where profile_id = '29600000-0000-4000-8000-000000000010'
	and user_id = '29600000-0000-4000-8000-000000000003';
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.attachment_denied(format('select public.qorpera_authorize_member_session_attachment(%L,%L,%L)',
	'29600000-0000-4000-8000-000000000060',current_setting('qorpera_test.input')::jsonb ->> 'input_id',current_setting('qorpera_test.image_hash')));
reset role;

-- Expiry and later membership changes also stop upload verification.
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.expired_upload',public.qorpera_begin_member_session_attachment_upload(
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000073',
	current_setting('qorpera_test.image_hash'),9,'image/png')::text,true);
reset role;
update public.qorpera_member_session_attachment_uploads set expires_at = clock_timestamp() - interval '1 second'
	where id = (current_setting('qorpera_test.expired_upload')::jsonb ->> 'uploadId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.attachment_denied(format('select public.qorpera_stage_member_session_attachment(%L,true)',
	current_setting('qorpera_test.expired_upload')::jsonb ->> 'uploadId'));
reset role;
select pg_temp.path_claims('authenticated','29600000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_begin_member_session_attachment_upload(
	'29600000-0000-4000-8000-000000000060','29600000-0000-4000-8000-000000000073',current_setting('qorpera_test.image_hash'),9,'image/png');
reset role;
delete from public.qorpera_profile_members where profile_id = '29600000-0000-4000-8000-000000000010'
	and user_id = '29600000-0000-4000-8000-000000000002';
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.attachment_denied(format('select public.qorpera_stage_member_session_attachment(%L,true)',
	current_setting('qorpera_test.expired_upload')::jsonb ->> 'uploadId'));
reset role;
rollback;
