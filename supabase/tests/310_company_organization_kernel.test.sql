-- Runtime Order 0 organization kernel: one company Co-Founder, private
-- member conversations, Company File-bound organizational projections, and
-- responsibility-scoped authority. Storage rows below stand in only for exact
-- immutable bytes; all admission and publication paths are the real RPCs.
begin;

create function pg_temp.org_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object(
		'role',p_role,'sub',p_user,
		'email',(select email from auth.users where id = p_user),
		'user_metadata',coalesce((select raw_user_meta_data from auth.users where id = p_user),'{}'::jsonb)
	)::text,true)::text::void
$$;

do $$
declare v_entry_owner name; v_retained_owner name; v_staff_writer_owner name; v_staff_delete_owner name;
begin
	select role.rolname into strict v_entry_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_create_cloud_company(uuid,text,integer)'::regprocedure;
	if not has_function_privilege(
		v_entry_owner,'public.qorpera_seed_company_cofounder(uuid,uuid)','EXECUTE'
	) or not has_function_privilege(
		v_entry_owner,'public.qorpera_enqueue_company_bootstrap(uuid,boolean)','EXECUTE'
	) or has_function_privilege(
		'authenticated','public.qorpera_seed_company_cofounder(uuid,uuid)','EXECUTE'
	) or has_function_privilege(
		'authenticated','public.qorpera_enqueue_company_bootstrap(uuid,boolean)','EXECUTE'
	) or has_function_privilege(
		'service_role','public.qorpera_seed_company_cofounder(uuid,uuid)','EXECUTE'
	) or has_function_privilege(
		'service_role','public.qorpera_enqueue_company_bootstrap(uuid,boolean)','EXECUTE'
	) then
		raise exception 'Company bootstrap helper privilege boundary is invalid';
	end if;
	select role.rolname into strict v_retained_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_company_retained_object_hashes(uuid)'::regprocedure;
	if not has_function_privilege(
		v_retained_owner,'public.qorpera_company_additional_retained_object_hashes(uuid)','EXECUTE'
	) or has_function_privilege(
		'authenticated','public.qorpera_company_additional_retained_object_hashes(uuid)','EXECUTE'
	) or has_function_privilege(
		'service_role','public.qorpera_company_additional_retained_object_hashes(uuid)','EXECUTE'
	) then
		raise exception 'Company retention helper privilege boundary is invalid';
	end if;
	select role.rolname into strict v_staff_writer_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_put_profile_staff(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,bigint)'::regprocedure;
	if not has_function_privilege(
		v_staff_writer_owner,'public.qorpera_company_path_key(text)','EXECUTE'
	) or has_function_privilege(
		'authenticated','public.qorpera_company_path_key(text)','EXECUTE'
	) or has_function_privilege(
		'service_role','public.qorpera_company_path_key(text)','EXECUTE'
	) then
		raise exception 'Company agent path-key privilege boundary is invalid';
	end if;
	select role.rolname into strict v_staff_delete_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_delete_profile_staff(uuid,uuid,bigint)'::regprocedure;
	if not has_function_privilege(
		v_staff_delete_owner,'public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)','EXECUTE'
	) or has_function_privilege(
		'authenticated','public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)','EXECUTE'
	) or has_function_privilege(
		'service_role','public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)','EXECUTE'
	) then
		raise exception 'Company agent tombstone privilege boundary is invalid';
	end if;
end
$$;

insert into auth.users(id,email,raw_user_meta_data) values
	('31000000-0000-4000-8000-000000000001','founder@example.test','{"full_name":"Founder"}'),
	('31000000-0000-4000-8000-000000000002','builder@example.test','{"full_name":"Builder"}'),
	('31000000-0000-4000-8000-000000000003','viewer@example.test','{"full_name":"Viewer"}');

-- Earlier suite fixtures leave durable bootstrap work. Hold their claims on
-- another worker before creating this company; the final rollback restores
-- those jobs. All claims and finalizations below still use the real worker RPCs.
select pg_temp.org_claims('service_role');
set local role service_role;
do $$
begin
	while public.qorpera_claim_company_bootstrap('31000000-0000-4000-8000-000000000099',300) is not null loop
		null;
	end loop;
end
$$;
reset role;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.org_company',public.qorpera_create_cloud_company(
	'31000000-0000-4000-8000-000000000010','Organization kernel fixture',2)::text,true);
reset role;

-- The company is not visible or runnable until the cloud bootstrap worker has
-- uploaded and atomically finalized the canonical organization tree.
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.bootstrap_worker','31000000-0000-4000-8000-000000000012',true);
select set_config('qorpera_test.bootstrap_claim',public.qorpera_claim_company_bootstrap(
	current_setting('qorpera_test.bootstrap_worker')::uuid,60)::text,true);
do $$
begin
	if current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'profileId'
		is distinct from current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' then
		raise exception 'Bootstrap worker claimed a different fixture company';
	end if;
end
$$;
select set_config('qorpera_test.bootstrap_document',
	current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'formationDocument',true);
select set_config('qorpera_test.bootstrap_agent_document',
	current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'cofounderAgentDocument',true);
select set_config('qorpera_test.bootstrap_content_sha',encode(extensions.digest(
	convert_to(current_setting('qorpera_test.bootstrap_document'),'utf8'),'sha256'),'hex'),true);
select set_config('qorpera_test.bootstrap_file_manifest',jsonb_build_object(
	'schema','qorpera.cloud-file-manifest/v1','fileSha256',current_setting('qorpera_test.bootstrap_content_sha'),
	'bytes',octet_length(current_setting('qorpera_test.bootstrap_document')),'mediaType','application/octet-stream',
	'chunks',jsonb_build_array(jsonb_build_object('sha256',current_setting('qorpera_test.bootstrap_content_sha'),
		'bytes',octet_length(current_setting('qorpera_test.bootstrap_document')))))::text,true);
select set_config('qorpera_test.bootstrap_file_manifest_sha',encode(extensions.digest(
	convert_to(current_setting('qorpera_test.bootstrap_file_manifest'),'utf8'),'sha256'),'hex'),true);
select set_config('qorpera_test.bootstrap_agent_content_sha',encode(extensions.digest(
	convert_to(current_setting('qorpera_test.bootstrap_agent_document'),'utf8'),'sha256'),'hex'),true);
select set_config('qorpera_test.bootstrap_agent_manifest',jsonb_build_object(
	'schema','qorpera.cloud-file-manifest/v1','fileSha256',current_setting('qorpera_test.bootstrap_agent_content_sha'),
	'bytes',octet_length(current_setting('qorpera_test.bootstrap_agent_document')),'mediaType','application/octet-stream',
	'chunks',jsonb_build_array(jsonb_build_object('sha256',current_setting('qorpera_test.bootstrap_agent_content_sha'),
		'bytes',octet_length(current_setting('qorpera_test.bootstrap_agent_document')))))::text,true);
select set_config('qorpera_test.bootstrap_agent_manifest_sha',encode(extensions.digest(
	convert_to(current_setting('qorpera_test.bootstrap_agent_manifest'),'utf8'),'sha256'),'hex'),true);
-- The Co-Founder's four company-level responsibilities are minted with the
-- job and staged like the formation and agent documents.
select set_config('qorpera_test.responsibility_documents',
	(current_setting('qorpera_test.bootstrap_claim')::jsonb -> 'cofounderResponsibilityDocuments')::text,true);
do $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_job uuid := (current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid;
	v_worker uuid := current_setting('qorpera_test.bootstrap_worker')::uuid;
	v_doc record; v_hash text; v_manifest text; v_manifest_hash text; v_entries jsonb := '[]'::jsonb;
begin
	if (select count(*) from jsonb_object_keys(current_setting('qorpera_test.responsibility_documents')::jsonb)) <> 4 then
		raise exception 'Bootstrap job did not mint the four company-level responsibilities'; end if;
	for v_doc in select key,value from jsonb_each_text(current_setting('qorpera_test.responsibility_documents')::jsonb)
		order by key collate "C" loop
		v_hash := encode(extensions.digest(convert_to(v_doc.value,'utf8'),'sha256'),'hex');
		v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
			'bytes',octet_length(v_doc.value),'mediaType','application/octet-stream',
			'chunks',jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(v_doc.value))))::text;
		v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
		insert into storage.objects(bucket_id,name,metadata) values
			('qorpera-profile-objects',v_profile::text || '/' || v_hash,jsonb_build_object('size',octet_length(v_doc.value))),
			('qorpera-profile-objects',v_profile::text || '/' || v_manifest_hash,jsonb_build_object('size',octet_length(v_manifest)));
		perform public.qorpera_stage_company_bootstrap_object(v_job,v_worker,'cofounder_responsibility_content',
			v_hash,octet_length(v_doc.value),true);
		perform public.qorpera_stage_company_bootstrap_object(v_job,v_worker,'cofounder_responsibility_manifest',
			v_manifest_hash,octet_length(v_manifest),true,v_doc.key);
		perform public.qorpera_verify_company_path_file(v_profile,v_manifest);
		v_entries := v_entries || jsonb_build_object('path',v_doc.key,'kind','file','executable',false,'file',
			jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(v_doc.value),
				'mediaType','application/octet-stream'));
	end loop;
	begin
		perform public.qorpera_stage_company_bootstrap_object(v_job,v_worker,'cofounder_responsibility_content',
			encode(extensions.digest('{"schema":"qorpera.responsibility/v1"}'::bytea,'sha256'),'hex'),40,false);
		raise exception 'Bootstrap accepted a responsibility document it did not mint';
	exception when invalid_parameter_value then null; end;
	perform set_config('qorpera_test.responsibility_entries',v_entries::text,true);
end
$$;
select set_config('qorpera_test.bootstrap_tree',jsonb_build_object(
	'schema','qorpera.company-tree/v1','contractVersion',3,'omittedLayers',
	'[
		"company-git-history","session-trail","staff-registry","product-git-checkouts",
		"dependency-caches","staff-instructions","system-metadata"
	]'::jsonb,'entries',jsonb_build_array(
		jsonb_build_object('path','organization','kind','directory'),
		jsonb_build_object('path','organization/agents','kind','directory'),
		jsonb_build_object('path','organization/agents/' ||
			(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'cofounderStaffAgentId') || '.json',
			'kind','file','executable',false,'file',jsonb_build_object(
				'manifestSha256',current_setting('qorpera_test.bootstrap_agent_manifest_sha'),
				'fileSha256',current_setting('qorpera_test.bootstrap_agent_content_sha'),
				'bytes',octet_length(current_setting('qorpera_test.bootstrap_agent_document')),
				'mediaType','application/octet-stream')),
		jsonb_build_object('path','organization/formation.json','kind','file','executable',false,'file',jsonb_build_object(
			'manifestSha256',current_setting('qorpera_test.bootstrap_file_manifest_sha'),
			'fileSha256',current_setting('qorpera_test.bootstrap_content_sha'),
			'bytes',octet_length(current_setting('qorpera_test.bootstrap_document')),
			'mediaType','application/octet-stream')),
		jsonb_build_object('path','organization/projects','kind','directory'),
		jsonb_build_object('path','organization/responsibilities','kind','directory'))
		|| current_setting('qorpera_test.responsibility_entries')::jsonb)::text,true);
select set_config('qorpera_test.bootstrap_tree_sha',encode(extensions.digest(
	convert_to(current_setting('qorpera_test.bootstrap_tree'),'utf8'),'sha256'),'hex'),true);
insert into storage.objects(bucket_id,name,metadata) values
	('qorpera-profile-objects',current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' || '/' ||
		current_setting('qorpera_test.bootstrap_content_sha'),jsonb_build_object(
			'size',octet_length(current_setting('qorpera_test.bootstrap_document')))),
	('qorpera-profile-objects',current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' || '/' ||
		current_setting('qorpera_test.bootstrap_file_manifest_sha'),jsonb_build_object(
			'size',octet_length(current_setting('qorpera_test.bootstrap_file_manifest')))),
	('qorpera-profile-objects',current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' || '/' ||
		current_setting('qorpera_test.bootstrap_agent_content_sha'),jsonb_build_object(
			'size',octet_length(current_setting('qorpera_test.bootstrap_agent_document')))),
	('qorpera-profile-objects',current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' || '/' ||
		current_setting('qorpera_test.bootstrap_agent_manifest_sha'),jsonb_build_object(
			'size',octet_length(current_setting('qorpera_test.bootstrap_agent_manifest')))),
	('qorpera-profile-objects',current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id' || '/' ||
		current_setting('qorpera_test.bootstrap_tree_sha'),jsonb_build_object(
			'size',octet_length(current_setting('qorpera_test.bootstrap_tree'))));
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_content',
	current_setting('qorpera_test.bootstrap_content_sha'),octet_length(current_setting('qorpera_test.bootstrap_document')),false);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_content',
	current_setting('qorpera_test.bootstrap_content_sha'),octet_length(current_setting('qorpera_test.bootstrap_document')),true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_manifest',
	current_setting('qorpera_test.bootstrap_file_manifest_sha'),octet_length(current_setting('qorpera_test.bootstrap_file_manifest')),false);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_manifest',
	current_setting('qorpera_test.bootstrap_file_manifest_sha'),octet_length(current_setting('qorpera_test.bootstrap_file_manifest')),true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'cofounder_agent_content',
	current_setting('qorpera_test.bootstrap_agent_content_sha'),
		octet_length(current_setting('qorpera_test.bootstrap_agent_document')),true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'cofounder_agent_manifest',
	current_setting('qorpera_test.bootstrap_agent_manifest_sha'),
		octet_length(current_setting('qorpera_test.bootstrap_agent_manifest')),true);
select public.qorpera_verify_company_path_file((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
	current_setting('qorpera_test.bootstrap_file_manifest'));
select public.qorpera_verify_company_path_file((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
	current_setting('qorpera_test.bootstrap_agent_manifest'));
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'tree',current_setting('qorpera_test.bootstrap_tree_sha'),
	octet_length(current_setting('qorpera_test.bootstrap_tree')),false);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'tree',current_setting('qorpera_test.bootstrap_tree_sha'),
	octet_length(current_setting('qorpera_test.bootstrap_tree')),true);
select public.qorpera_verify_company_path_tree((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
	current_setting('qorpera_test.bootstrap_tree'));
select set_config('qorpera_test.bootstrap_result',public.qorpera_finalize_company_bootstrap(
	(current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,current_setting('qorpera_test.bootstrap_document'),
	current_setting('qorpera_test.bootstrap_file_manifest'),current_setting('qorpera_test.bootstrap_agent_manifest'),
	current_setting('qorpera_test.bootstrap_tree'),jsonb_build_object(
		'organization/formation.json',current_setting('qorpera_test.bootstrap_document'),
		'organization/agents/' || (current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'cofounderStaffAgentId') || '.json',
		current_setting('qorpera_test.bootstrap_agent_document'))
		|| current_setting('qorpera_test.responsibility_documents')::jsonb)::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.org_company',public.qorpera_create_cloud_company(
	'31000000-0000-4000-8000-000000000010','Organization kernel fixture',2)::text,true);
set constraints all immediate;
set constraints all deferred;

do $$
declare v_first jsonb := current_setting('qorpera_test.org_company')::jsonb; v_second jsonb;
	v_bootstrap jsonb;
begin
	v_second := public.qorpera_create_cloud_company(
		'31000000-0000-4000-8000-000000000010','Organization kernel fixture',2);
	if v_first ->> 'profile_id' is distinct from v_second ->> 'profile_id'
		or v_first #>> '{organization,cofounder,staff_agent_id}' is distinct from
			v_second #>> '{organization,cofounder,staff_agent_id}'
		or v_first #>> '{organization,cofounder,formation_id}' is distinct from
			v_second #>> '{organization,cofounder,formation_id}'
		or v_first #>> '{organization,cofounder,member_session_id}' is distinct from
			v_second #>> '{organization,cofounder,member_session_id}' then
		raise exception 'Company creation did not replay the exact organization bootstrap'; end if;
	if v_first #>> '{organization,schema}' <> 'qorpera.company-organization-bootstrap/v1'
		or v_first #>> '{organization,formation_state}' <> 'source_inventory' then
		raise exception 'Company creation omitted its organization bootstrap'; end if;
	v_bootstrap := public.qorpera_company_organization_bootstrap((v_first ->> 'profile_id')::uuid);
	if v_bootstrap is distinct from v_first -> 'organization' then
		raise exception 'Organization bootstrap read did not preserve the created company identity'; end if;
end
$$;
reset role;

do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb; v_profile uuid;
	cofounder uuid; formation uuid; owner_session uuid;
begin
	v_profile := (v_company ->> 'profile_id')::uuid;
	cofounder := (v_company #>> '{organization,cofounder,staff_agent_id}')::uuid;
	formation := (v_company #>> '{organization,cofounder,formation_id}')::uuid;
	owner_session := (v_company #>> '{organization,cofounder,member_session_id}')::uuid;
	if (select count(*) from public.qorpera_company_cofounders where profile_id = v_profile) <> 1
		or not exists (select 1 from public.qorpera_profile_staff where profile_id = v_profile
			and staff_agent_id = cofounder and template_id = 'co-founder'
			and display_name = 'Co-Founder' and lifecycle_state = 'setup'
			and source_path = 'organization/agents/' || cofounder::text || '.json'
			and source_path_version is not null and source_snapshot_id =
				(current_setting('qorpera_test.bootstrap_result')::jsonb ->> 'snapshotId')::uuid)
		or not exists (select 1 from public.qorpera_company_formations where id = formation
			and profile_id = v_profile and state = 'source_inventory' and projection_status = 'verified')
		or not exists (select 1 from public.qorpera_shared_sessions where id = owner_session
			and profile_id = v_profile and staff_agent_id = cofounder::text
			and audience_kind = 'member_private' and audience_user_id = '31000000-0000-4000-8000-000000000001')
		or (select count(*) from public.qorpera_session_inputs input
			where input.session_id = owner_session and input.kind = 'kickoff') <> 1
		or not exists (select 1 from public.qorpera_session_inputs input
			join public.qorpera_company_first_runs first_run on first_run.input_id = input.id
			where input.session_id = owner_session and input.kind = 'kickoff'
				and input.actor_kind = 'control_plane'
				and input.body #>> '{assignment,kind}' = 'company_formation'
				and input.body #>> '{assignment,startState}' = 'source_inventory'
				and first_run.profile_id = v_profile)
		or not exists (select 1 from public.qorpera_agent_first_runs agent_first_run
			join public.qorpera_company_first_runs company_first_run on company_first_run.profile_id = agent_first_run.profile_id
			where agent_first_run.profile_id = v_profile and agent_first_run.staff_agent_id = cofounder
				and agent_first_run.session_id = company_first_run.session_id
				and agent_first_run.input_id = company_first_run.input_id)
		or exists (select 1 from public.qorpera_artifacts artifact where artifact.profile_id = v_profile) then
		raise exception 'Canonical Co-Founder bootstrap is incomplete'; end if;
	if (select count(*) from public.qorpera_profile_staff where profile_id = v_profile and template_id = 'co-founder') <> 1 then
		raise exception 'Company has more than one Co-Founder'; end if;
	-- The Co-Founder holds the company-level responsibilities from genesis:
	-- each active, accountable to the Co-Founder and the founding owner, with
	-- a measure bound to live sources at exact observed versions.
	if (select count(*) from public.qorpera_company_responsibilities responsibility
		where responsibility.profile_id = v_profile and responsibility.status = 'active'
			and responsibility.accountable_staff_agent_id = cofounder
			and responsibility.accountable_user_id = '31000000-0000-4000-8000-000000000001'
			and responsibility.escalation_target ->> 'kind' = 'accountable_member'
			and responsibility.source_snapshot_id =
				(current_setting('qorpera_test.bootstrap_result')::jsonb ->> 'snapshotId')::uuid) <> 4
		or (select array_agg(slug order by slug) from public.qorpera_company_responsibilities where profile_id = v_profile)
			<> array['direction','founder-relationship','resourcing','responsibility-map']
		or exists (select 1 from public.qorpera_company_responsibilities responsibility
			where responsibility.profile_id = v_profile and not exists (
				select 1 from public.qorpera_responsibility_measures measure
				join public.qorpera_responsibility_measure_sources source on source.measure_id = measure.id
				where measure.responsibility_id = responsibility.id and measure.status = 'active'
					and source.source_path_version is not null))
		or not exists (select 1 from public.qorpera_responsibility_measure_sources source
			join public.qorpera_company_path_entries entry on entry.environment_id = source.environment_id
				and entry.path_key_sha256 = source.source_path_key_sha256
			where source.profile_id = v_profile and source.source_path = 'organization/formation.json'
				and source.path_match = 'exact' and source.source_path_version = entry.version
				and source.source_file_sha256 = entry.entry #>> '{file,fileSha256}')
		or not exists (select 1 from public.qorpera_responsibility_measure_sources source
			where source.profile_id = v_profile and source.source_path = 'organization/responsibilities'
				and source.path_match = 'subtree' and source.source_file_sha256 is null) then
		raise exception 'Co-Founder does not hold the company-level responsibilities from genesis'; end if;
end
$$;

-- An existing company bootstrap is a pinned, no-loss upgrade. Replaying it
-- over an already canonical head neither advances the head nor seeds another
-- first-run input.
select set_config('qorpera_test.upgrade_head',(current_setting('qorpera_test.bootstrap_result')::jsonb ->> 'snapshotId'),true);
select set_config('qorpera_test.upgrade_revision_count',(select count(*)::text from public.qorpera_company_path_revisions
	where environment_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid),true);
update public.qorpera_company_bootstrap_jobs set state = 'queued',first_run_required = false,
	lease_owner = null,lease_expires_at = null,candidate_snapshot_id = null,output_snapshot_id = null,
	completed_at = null,updated_at = clock_timestamp()
where profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.upgrade_claim',public.qorpera_claim_company_bootstrap(
	current_setting('qorpera_test.bootstrap_worker')::uuid,60)::text,true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.upgrade_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_manifest',
	current_setting('qorpera_test.bootstrap_file_manifest_sha'),octet_length(current_setting('qorpera_test.bootstrap_file_manifest')),true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.upgrade_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'cofounder_agent_manifest',
	current_setting('qorpera_test.bootstrap_agent_manifest_sha'),
		octet_length(current_setting('qorpera_test.bootstrap_agent_manifest')),true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.upgrade_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'tree',current_setting('qorpera_test.bootstrap_tree_sha'),
	octet_length(current_setting('qorpera_test.bootstrap_tree')),true);
select set_config('qorpera_test.upgrade_result',public.qorpera_finalize_company_bootstrap(
	(current_setting('qorpera_test.upgrade_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,current_setting('qorpera_test.bootstrap_document'),
	current_setting('qorpera_test.bootstrap_file_manifest'),current_setting('qorpera_test.bootstrap_agent_manifest'),
	current_setting('qorpera_test.bootstrap_tree'),jsonb_build_object(
		'organization/formation.json',current_setting('qorpera_test.bootstrap_document'),
		'organization/agents/' || (current_setting('qorpera_test.bootstrap_claim')::jsonb ->> 'cofounderStaffAgentId') || '.json',
		current_setting('qorpera_test.bootstrap_agent_document'))
		|| current_setting('qorpera_test.responsibility_documents')::jsonb)::text,true);
reset role;
do $$
begin
	if current_setting('qorpera_test.upgrade_result')::jsonb ->> 'snapshotId'
			<> current_setting('qorpera_test.upgrade_head')
		or (select count(*) from public.qorpera_company_path_revisions where environment_id =
			(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid)::text
			<> current_setting('qorpera_test.upgrade_revision_count')
		or (select count(*) from public.qorpera_company_first_runs where profile_id =
			(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid) <> 1
		or (select count(*) from public.qorpera_session_inputs where kind = 'kickoff' and session_id =
			(current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,member_session_id}')::uuid) <> 1 then
		raise exception 'Existing company bootstrap changed canonical state or replayed first-run'; end if;
end
$$;

insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
		'31000000-0000-4000-8000-000000000002','builder@example.test','Builder','contributor'),
	((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
		'31000000-0000-4000-8000-000000000003','viewer@example.test','Viewer','viewer');
select set_config('qorpera_test.owner_client_session',(
	select client_session_id::text from public.qorpera_shared_sessions
	where id = (current_setting('qorpera_test.org_company')::jsonb #>>
		'{organization,cofounder,member_session_id}')::uuid),true);

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.builder_session',(
	select item ->> 'session_id' from jsonb_array_elements(public.qorpera_list_shared_sessions(
		(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid)) item
	where item ->> 'audience_kind' = 'member_private')::text,true);
do $$
declare v_sessions jsonb := public.qorpera_list_shared_sessions(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid);
	v_owner_session uuid := (current_setting('qorpera_test.org_company')::jsonb #>>
		'{organization,cofounder,member_session_id}')::uuid;
	v_bootstrap jsonb := public.qorpera_company_organization_bootstrap(
		(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid);
begin
	if jsonb_array_length(v_sessions) <> 1 or v_sessions -> 0 ->> 'audience_user_id' <>
		'31000000-0000-4000-8000-000000000002' then
		raise exception 'Member did not receive exactly one private Co-Founder conversation'; end if;
	if v_bootstrap #>> '{cofounder,member_session_id}' is distinct from current_setting('qorpera_test.builder_session')
		or v_bootstrap #>> '{cofounder,formation_id}' is distinct from
			current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,formation_id}' then
		raise exception 'Member organization bootstrap did not bind the member-private Co-Founder session'; end if;
	begin
		perform public.qorpera_read_session_events(v_owner_session);
		raise exception 'Member read another member private conversation';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_create_shared_session_v2(
			(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
			current_setting('qorpera_test.owner_client_session')::uuid,
			'Co-Founder',(current_setting('qorpera_test.org_company')::jsonb #>>
				'{organization,cofounder,staff_agent_id}'),null);
		raise exception 'Legacy creation adopted another member private conversation';
	exception when insufficient_privilege then null; end;
	begin
		perform public.qorpera_create_shared_session_v2(
			(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
			'31000000-0000-4000-8000-000000000011','Leaking child',null,v_owner_session);
		raise exception 'Private conversation became another member parent';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;
do $$ begin
	if (select count(*) from public.qorpera_company_first_runs where profile_id =
		(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid) <> 1
		or (select count(*) from public.qorpera_session_inputs input join public.qorpera_shared_sessions session
			on session.id = input.session_id where session.profile_id =
			(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
			and input.kind = 'kickoff') <> 1 then
		raise exception 'Adding a member duplicated the company first run'; end if;
end $$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$
begin
	if jsonb_array_length(public.qorpera_list_shared_sessions(
		(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid)) <> 0 then
		raise exception 'Read-only viewer received a private Co-Founder conversation'; end if;
	begin
		perform public.qorpera_company_organization_bootstrap(
			(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid);
		raise exception 'Read-only viewer received a writable organization bootstrap';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

create function pg_temp.org_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex');
	v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata) values
		('qorpera-profile-objects',v_profile::text || '/' || v_hash,jsonb_build_object('size',octet_length(p_text)))
		on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',
		case when p_text = '' then '[]'::jsonb else jsonb_build_array(
			jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata) values
		('qorpera-profile-objects',v_profile::text || '/' || v_manifest_hash,
			jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file(v_profile,v_manifest);
	return jsonb_build_object('path',p_path,'kind','file','executable',false,'file',jsonb_build_object(
		'manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','application/octet-stream'));
end
$$;

create function pg_temp.org_stage_tree(p_entries jsonb)
returns text language plpgsql security definer as $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_manifest text; v_sha text;
begin
	v_manifest := jsonb_build_object('schema','qorpera.company-tree/v1','contractVersion',3,'omittedLayers',
		'["company-git-history","session-trail","staff-registry","product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb,
		'entries',p_entries)::text;
	v_sha := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata) values
		('qorpera-profile-objects',v_profile::text || '/' || v_sha,jsonb_build_object('size',octet_length(v_manifest)))
		on conflict do nothing;
	perform set_config('qorpera_test.org_tree_bytes',octet_length(v_manifest)::text,true);
	return public.qorpera_verify_company_path_tree(v_profile,v_manifest);
end
$$;

create function pg_temp.org_plan(p_key text,p_path text,p_entry jsonb,p_version uuid default null)
returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.company-path-mutation/v1','operationKey',p_key,
		'path',p_path,'expectedVersion',p_version,'entry',p_entry)
$$;

create function pg_temp.org_apply(p_command jsonb,p_document text)
returns jsonb language plpgsql as $$
declare v_prepared jsonb; v_entries jsonb; v_tree text;
begin
	v_prepared := public.qorpera_prepare_member_company_path_command(
		(p_command ->> 'commandId')::uuid,p_command ->> 'planSha256');
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(v_prepared -> 'entries')
		where value ->> 'path' <> v_prepared #>> '{plan,path}'
		union all select v_prepared #> '{plan,entry}' where v_prepared #> '{plan,entry}' <> 'null'::jsonb
	) entries;
	v_tree := pg_temp.org_stage_tree(v_entries);
	return public.qorpera_apply_member_company_path_command_v3(
		(p_command ->> 'commandId')::uuid,p_command ->> 'planSha256',
		(v_prepared ->> 'snapshotId')::uuid,v_tree,p_document);
end
$$;

-- The cloud finalizer already established and projected the initial Company
-- File. Subsequent organization edits use that exact live head.
select set_config('qorpera_test.formation_document',current_setting('qorpera_test.bootstrap_document'),true);
select set_config('qorpera_test.org_initial_snapshot',jsonb_build_object(
	'snapshot_id',current_setting('qorpera_test.bootstrap_result')::jsonb ->> 'snapshotId')::text,true);
select set_config('qorpera_test.formation_version',(
	select entry.version::text from public.qorpera_company_path_entries entry
	where entry.environment_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid
		and entry.path = 'organization/formation.json'),true);

do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb;
begin
	if not exists (select 1 from public.qorpera_company_formations formation
		where formation.profile_id = (v_company ->> 'profile_id')::uuid
			and formation.projection_status = 'verified'
			and formation.source_path = 'organization/formation.json'
			and formation.source_path_version = (select entry.version
				from public.qorpera_company_path_entries entry
				where entry.environment_id = (v_company ->> 'environment_id')::uuid
					and entry.path = 'organization/formation.json')
			and formation.source_snapshot_id =
				(current_setting('qorpera_test.org_initial_snapshot')::jsonb ->> 'snapshot_id')::uuid) then
		raise exception 'Formation projection did not bind the exact Company File version'; end if;
end
$$;

-- A coworker is created, archived, restored, and permanently deleted by one
-- governed Company File path. Its first-run input is admitted exactly once,
-- restore does not replay it, and deletion bins owned artifacts and dependent
-- execution state in the same path transaction.
select set_config('qorpera_test.agent_path',
	'organization/agents/31000000-0000-4000-8000-000000000400.json',true);
select set_config('qorpera_test.agent_created_at','2026-08-29T10:00:00Z',true);
select set_config('qorpera_test.agent_document',jsonb_build_object(
	'schema','qorpera.company-agent/v1','agentId','31000000-0000-4000-8000-000000000400','revision',1,
	'displayName','Operations Partner','role','Operational follow-through',
	'hireOverlay',jsonb_build_object('charter','Own bounded operational follow-through and record verified outcomes.',
		'templateId',null),
	'appearance',jsonb_build_object('color','#0071e3','shape','round','creature','pebble'),
	'modelPolicy',jsonb_build_object('provider',null,'modelId',null),
	'reasoningPolicy',jsonb_build_object('effort','low'),
	'grants',jsonb_build_object('responsibilities','[]'::jsonb,'projects','[]'::jsonb,'rooms','[]'::jsonb,'resources','[]'::jsonb),
	'startupInstructions','Read the live Company File, identify the first bounded operational outcome, and record verified work there.',
	'employmentStatus','active','lifecycleState','setup','createdAt',current_setting('qorpera_test.agent_created_at'))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.agent_path'),current_setting('qorpera_test.agent_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.agent_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('agent-operations-partner-v1',current_setting('qorpera_test.agent_path'),
		current_setting('qorpera_test.agent_entry')::jsonb))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.agent_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.agent_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_applied',pg_temp.org_apply(
	current_setting('qorpera_test.agent_command')::jsonb,current_setting('qorpera_test.agent_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

do $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_session uuid; v_input uuid;
begin
	select session_id,input_id into strict v_session,v_input from public.qorpera_agent_first_runs
	where profile_id = v_profile and staff_agent_id = '31000000-0000-4000-8000-000000000400';
	if not exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = v_profile and staff.staff_agent_id = '31000000-0000-4000-8000-000000000400'
			and staff.source_path = current_setting('qorpera_test.agent_path')
			and staff.source_path_version = (current_setting('qorpera_test.agent_applied')::jsonb #>> '{result,version}')::uuid
			and staff.source_snapshot_id = (current_setting('qorpera_test.agent_applied')::jsonb #>> '{result,snapshotId}')::uuid
			and staff.reasoning_policy = '{"effort":"low"}'::jsonb and staff.employment_status = 'active')
		or not exists (select 1 from public.qorpera_session_inputs input where input.id = v_input
			and input.session_id = v_session and input.kind = 'kickoff' and input.actor_kind = 'control_plane'
			and input.body #>> '{assignment,kind}' = 'staff_startup'
			and input.body #>> '{assignment,startupInstructions}' =
				'Read the live Company File, identify the first bounded operational outcome, and record verified work there.')
		or (select count(*) from public.qorpera_agent_first_runs where profile_id = v_profile
			and staff_agent_id = '31000000-0000-4000-8000-000000000400') <> 1 then
		raise exception 'Company File agent creation did not atomically admit its identity and first run'; end if;
end
$$;

-- A generic publisher cannot create an agent path without its synchronized
-- staff projection. The deferred constraint aborts the whole publication.
select set_config('qorpera_test.unprojected_agent_path',
	'organization/agents/31000000-0000-4000-8000-000000000410.json',true);
select set_config('qorpera_test.unprojected_agent_document',(
	current_setting('qorpera_test.agent_document')::jsonb || jsonb_build_object(
		'agentId','31000000-0000-4000-8000-000000000410','displayName','Unprojected agent'))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.unprojected_agent_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.unprojected_agent_path'),
	current_setting('qorpera_test.unprojected_agent_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.unprojected_agent_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('agent-unprojected-v1',current_setting('qorpera_test.unprojected_agent_path'),
		current_setting('qorpera_test.unprojected_agent_entry')::jsonb))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.unprojected_agent_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.unprojected_agent_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
do $$
declare v_command jsonb := current_setting('qorpera_test.unprojected_agent_command')::jsonb;
	v_prepared jsonb; v_entries jsonb; v_tree text;
begin
	begin
		v_prepared := public.qorpera_prepare_member_company_path_command(
			(v_command ->> 'commandId')::uuid,v_command ->> 'planSha256');
		select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
			select value from jsonb_array_elements(v_prepared -> 'entries')
			where value ->> 'path' <> v_prepared #>> '{plan,path}'
			union all select v_prepared #> '{plan,entry}' where v_prepared #> '{plan,entry}' <> 'null'::jsonb
		) entries;
		v_tree := pg_temp.org_stage_tree(v_entries);
		perform public.qorpera_apply_member_company_path_command_v2(
			(v_command ->> 'commandId')::uuid,v_command ->> 'planSha256',
			(v_prepared ->> 'snapshotId')::uuid,v_tree,null);
		set constraints all immediate;
		raise exception 'Generic publication bypassed the agent projection';
	exception when check_violation then null; end;
	set constraints all deferred;
end
$$;
reset role;
do $$ begin
	if exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id =
		(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
		and staff.staff_agent_id = '31000000-0000-4000-8000-000000000410')
		or exists (select 1 from public.qorpera_company_path_entries entry where entry.environment_id =
			(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid
			and entry.path = current_setting('qorpera_test.unprojected_agent_path')) then
		raise exception 'Rejected agent publication left projection or path state'; end if;
end $$;

-- The legacy roster writer is no longer an alternate authority after the
-- canonical Company File bootstrap has completed.
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
	begin
		perform public.qorpera_put_profile_staff(
			(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
			'31000000-0000-4000-8000-000000000400','Bypass','Bypass','Bypass.',null,null,
			'#0071e3','round','pebble',null,null,'active','setup',
			current_setting('qorpera_test.agent_created_at')::timestamptz,1);
		raise exception 'Legacy staff RPC bypassed the Company File';
	exception when insufficient_privilege then null; end;
end $$;
reset role;

select set_config('qorpera_test.agent_document',(
	current_setting('qorpera_test.agent_document')::jsonb ||
	jsonb_build_object('revision',2,'employmentStatus','archived'))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.agent_path'),current_setting('qorpera_test.agent_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.agent_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('agent-operations-partner-v2',current_setting('qorpera_test.agent_path'),
		current_setting('qorpera_test.agent_entry')::jsonb,
		(current_setting('qorpera_test.agent_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.agent_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.agent_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_applied',pg_temp.org_apply(
	current_setting('qorpera_test.agent_command')::jsonb,current_setting('qorpera_test.agent_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

select set_config('qorpera_test.agent_document',(
	current_setting('qorpera_test.agent_document')::jsonb ||
	jsonb_build_object('revision',3,'employmentStatus','active','lifecycleState','active'))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.agent_path'),current_setting('qorpera_test.agent_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.agent_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('agent-operations-partner-v3',current_setting('qorpera_test.agent_path'),
		current_setting('qorpera_test.agent_entry')::jsonb,
		(current_setting('qorpera_test.agent_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.agent_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.agent_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_applied',pg_temp.org_apply(
	current_setting('qorpera_test.agent_command')::jsonb,current_setting('qorpera_test.agent_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.agent_restored_session',public.qorpera_ensure_staff_session(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	'31000000-0000-4000-8000-000000000400','31000000-0000-4000-8000-000000000401',
	'Operations Partner')::text,true);
reset role;
do $$ begin
	if (select count(*) from public.qorpera_agent_first_runs where profile_id =
		(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
		and staff_agent_id = '31000000-0000-4000-8000-000000000400') <> 1
		or exists (select 1 from public.qorpera_session_inputs where session_id =
			(current_setting('qorpera_test.agent_restored_session')::jsonb ->> 'session_id')::uuid and kind = 'kickoff') then
		raise exception 'Agent restore replayed its first-run kickoff'; end if;
end $$;

insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,
	artifact_type,name,root_object_sha256,content_sha256,bytes,media_type,created_by_user_id)
values ((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	'31000000-0000-4000-8000-000000000402',
	(current_setting('qorpera_test.agent_restored_session')::jsonb ->> 'session_id')::uuid,
	'fixture','Agent-owned artifact',repeat('b',64),repeat('b',64),1,'application/octet-stream',
	'31000000-0000-4000-8000-000000000001');

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.agent_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('agent-operations-partner-delete',current_setting('qorpera_test.agent_path'),null,
		(current_setting('qorpera_test.agent_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.agent_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.agent_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.agent_deleted',pg_temp.org_apply(
	current_setting('qorpera_test.agent_command')::jsonb,null)::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

do $$ begin
	if not exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id =
		(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
		and staff.staff_agent_id = '31000000-0000-4000-8000-000000000400'
		and staff.deleted_at is not null and staff.source_file_sha256 is null
		and staff.source_path_version = (current_setting('qorpera_test.agent_deleted')::jsonb #>> '{result,version}')::uuid)
		or not exists (select 1 from public.qorpera_artifacts artifact
			where artifact.client_artifact_id = '31000000-0000-4000-8000-000000000402' and artifact.deleted_at is not null)
		or exists (select 1 from public.qorpera_staff_provider_models model
			where model.profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
				and model.staff_agent_id = '31000000-0000-4000-8000-000000000400') then
		raise exception 'Company File agent deletion did not cascade its enforcement state'; end if;
end $$;

-- Measure definitions bind to an exact live Company File source version.
select set_config('qorpera_test.measure_source_document','{"cycleTimeDays":5}',true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.measure_source_entry',pg_temp.org_stage_file(
	'operations-metrics.json',current_setting('qorpera_test.measure_source_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.measure_source_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('measure-source-v1','operations-metrics.json',
		current_setting('qorpera_test.measure_source_entry')::jsonb))::text,true);
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.measure_source_applied',pg_temp.org_apply(
	current_setting('qorpera_test.measure_source_command')::jsonb,null)::text,true);
reset role;

select set_config('qorpera_test.responsibility_document',jsonb_build_object(
	'schema','qorpera.responsibility/v1','responsibilityId','31000000-0000-4000-8000-000000000100',
	'slug','operations','name','Operations',
	'outcome','Accepted work becomes a verified operational outcome inside its cycle-time target.',
	'accountableStaffAgentId',current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}',
	'accountableUserId','31000000-0000-4000-8000-000000000001',
	'attentionCadence','weekly',
	'escalationThreshold',jsonb_build_object('cycleTimeDaysOver',7),
	'escalationTarget',jsonb_build_object('kind','accountable_member','id',null),
	'effortPolicy',jsonb_build_object('attended','low'),'budgetPolicy',jsonb_build_object('currency','DKK','approvalThreshold',10000),
	'concurrencyPolicy',jsonb_build_object('maxActiveProjects',3),
	'routineIds','[]'::jsonb,'listenerIds','[]'::jsonb,'externalOperationGrants','[]'::jsonb,
	'resources',jsonb_build_array(jsonb_build_object(
		'resourceId','31000000-0000-4000-8000-000000000110','path','operations','pathMatch','subtree',
		'policy','normal','memberPermissions',jsonb_build_array('read','write'),
		'staffPermissions',jsonb_build_array('read','write'))),
	'status','active','version',1,
	'measures',jsonb_build_array(jsonb_build_object('measureId','31000000-0000-4000-8000-000000000102',
		'key','cycle-time','label','Cycle time','definition','Elapsed time from accepted work to verified outcome.',
		'direction','lower_is_better','target',jsonb_build_object('days',7),
		'guardrails',jsonb_build_array('No skipped approval gates'),'cadence','weekly','status','active',
		'sources',jsonb_build_array(jsonb_build_object('path','operations-metrics.json','pathMatch','exact'),
			jsonb_build_object('path','organization/projects','pathMatch','subtree')))))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.responsibility_entry',pg_temp.org_stage_file(
	'organization/responsibilities/31000000-0000-4000-8000-000000000100.json',
	current_setting('qorpera_test.responsibility_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.responsibility_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('responsibility-operations-v1',
		'organization/responsibilities/31000000-0000-4000-8000-000000000100.json',
		current_setting('qorpera_test.responsibility_entry')::jsonb))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.responsibility_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.responsibility_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.responsibility_applied',pg_temp.org_apply(
	current_setting('qorpera_test.responsibility_command')::jsonb,
	current_setting('qorpera_test.responsibility_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

select set_config('qorpera_test.project_document',jsonb_build_object(
	'schema','qorpera.company-project/v1','projectId','31000000-0000-4000-8000-000000000200',
	'key','launch-readiness','name','Launch readiness','objective','Prepare the company for launch.',
	'definitionOfDone','All launch gates have reviewable evidence.','scopeKind','responsibility',
	'sponsoringResponsibilityId','31000000-0000-4000-8000-000000000100',
	'leadStaffAgentId',current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}',
	'roomId',null,'status','active','sourceResources',jsonb_build_array(jsonb_build_object(
		'resourceId','31000000-0000-4000-8000-000000000210','path','organization/formation.json',
		'pathMatch','exact','policy','protected','memberPermissions',jsonb_build_array('read'),
		'staffPermissions',jsonb_build_array('read'))),
	'outputResources',jsonb_build_array(jsonb_build_object(
		'resourceId','31000000-0000-4000-8000-000000000211','path','projects/launch/result.md',
		'pathMatch','exact','policy','normal','memberPermissions',jsonb_build_array('read','write'),
		'staffPermissions',jsonb_build_array('read','write'))),
	'dependencies','[]'::jsonb,'reasoningPolicy',jsonb_build_object('effort','high'),
	'workerPolicy',jsonb_build_object('maxWorkers',2),'executionPolicy',jsonb_build_object('publication','review'),
	'outcome',null,'version',1,'staff',jsonb_build_array(jsonb_build_object(
		'staffAgentId',current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}',
		'role','Project lead','status','active')))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.project_entry',pg_temp.org_stage_file(
	'organization/projects/31000000-0000-4000-8000-000000000200.json',
	current_setting('qorpera_test.project_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.project_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('project-launch-v1','organization/projects/31000000-0000-4000-8000-000000000200.json',
		current_setting('qorpera_test.project_entry')::jsonb))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.project_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.project_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.project_applied',pg_temp.org_apply(
	current_setting('qorpera_test.project_command')::jsonb,
	current_setting('qorpera_test.project_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb;
begin
	if not exists (select 1 from public.qorpera_company_responsibilities where id =
		'31000000-0000-4000-8000-000000000100' and status = 'active'
			and accountable_staff_agent_id = (v_company #>> '{organization,cofounder,staff_agent_id}')::uuid)
		or not exists (select 1 from public.qorpera_responsibility_measures where responsibility_id =
			'31000000-0000-4000-8000-000000000100' and measure_key = 'cycle-time')
		or (select count(*) from public.qorpera_responsibility_measure_sources
			where measure_id = '31000000-0000-4000-8000-000000000102') <> 2
		or not exists (select 1 from public.qorpera_responsibility_measure_sources source
			where source.measure_id = '31000000-0000-4000-8000-000000000102' and source.path_match = 'exact'
				and source.source_path = 'operations-metrics.json'
				and source.source_path_version = (current_setting('qorpera_test.measure_source_applied')::jsonb #>> '{result,version}')::uuid
				and source.source_file_sha256 = current_setting('qorpera_test.measure_source_entry')::jsonb #>> '{file,fileSha256}')
		or not exists (select 1 from public.qorpera_company_projects where id =
			'31000000-0000-4000-8000-000000000200' and sponsoring_responsibility_id =
			'31000000-0000-4000-8000-000000000100') then
		raise exception 'Responsibility or project projection is incomplete'; end if;
end
$$;

-- The Co-Founder is a normal canonical agent object rather than mutable data
-- duplicated inside formation.json. Its bounded grants project into exact
-- enforcement rows, while archive remains forbidden.
select set_config('qorpera_test.cofounder_path','organization/agents/' ||
	(current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}') || '.json',true);
select set_config('qorpera_test.cofounder_document',(
	current_setting('qorpera_test.bootstrap_agent_document')::jsonb || jsonb_build_object(
		'revision',2,'displayName','Founding Partner','grants',jsonb_build_object(
			'responsibilities',jsonb_build_array('31000000-0000-4000-8000-000000000100'),
			'projects',jsonb_build_array('31000000-0000-4000-8000-000000000200'),
			'rooms',jsonb_build_array('31000000-0000-4000-8000-000000000300'),
			'resources',jsonb_build_array(jsonb_build_object(
				'resourceId','31000000-0000-4000-8000-000000000110',
				'resourceVersion',(select version from public.qorpera_company_path_resources
					where id = '31000000-0000-4000-8000-000000000110'),
				'permissions',jsonb_build_array('read','write'))))))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.cofounder_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.cofounder_path'),current_setting('qorpera_test.cofounder_document'))::text,true);
reset role;
select set_config('qorpera_test.cofounder_version',(select version::text
	from public.qorpera_company_path_entries where environment_id =
		(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid
		and path = current_setting('qorpera_test.cofounder_path')),true);
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.cofounder_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('cofounder-agent-v2',current_setting('qorpera_test.cofounder_path'),
		current_setting('qorpera_test.cofounder_entry')::jsonb,
		current_setting('qorpera_test.cofounder_version')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.cofounder_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.cofounder_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.cofounder_applied',pg_temp.org_apply(
	current_setting('qorpera_test.cofounder_command')::jsonb,current_setting('qorpera_test.cofounder_document'))::text,true);
reset role;
set constraints all immediate;
set constraints all deferred;

do $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_cofounder uuid := (current_setting('qorpera_test.org_company')::jsonb #>>
		'{organization,cofounder,staff_agent_id}')::uuid;
begin
	if current_setting('qorpera_test.bootstrap_document')::jsonb ? 'cofounder'
		or not exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = v_profile
			and staff.staff_agent_id = v_cofounder and staff.display_name = 'Founding Partner'
			and staff.version = 2 and staff.employment_status = 'active')
		or not exists (select 1 from public.qorpera_agent_responsibility_grants grant_row
			where grant_row.profile_id = v_profile and grant_row.staff_agent_id = v_cofounder
				and grant_row.responsibility_id = '31000000-0000-4000-8000-000000000100')
		or not exists (select 1 from public.qorpera_agent_project_grants grant_row
			where grant_row.profile_id = v_profile and grant_row.staff_agent_id = v_cofounder
				and grant_row.project_id = '31000000-0000-4000-8000-000000000200')
		or not exists (select 1 from public.qorpera_agent_room_grants grant_row
			where grant_row.profile_id = v_profile and grant_row.staff_agent_id = v_cofounder
				and grant_row.room_id = '31000000-0000-4000-8000-000000000300')
		or not exists (select 1 from public.qorpera_company_path_grants grant_row
			where grant_row.source_agent_profile_id = v_profile and grant_row.source_staff_agent_id = v_cofounder
				and grant_row.resource_id = '31000000-0000-4000-8000-000000000110'
				and grant_row.permissions = array['read','write']::text[]) then
		raise exception 'Co-Founder agent object or grant projection is incomplete'; end if;
end
$$;

-- Replaying the bootstrap over an evolved Co-Founder must preserve the current
-- canonical agent document instead of comparing it to or restoring the seed.
select set_config('qorpera_test.evolved_agent_manifest',jsonb_build_object(
	'schema','qorpera.cloud-file-manifest/v1','fileSha256',encode(extensions.digest(
		convert_to(current_setting('qorpera_test.cofounder_document'),'utf8'),'sha256'),'hex'),
	'bytes',octet_length(current_setting('qorpera_test.cofounder_document')),
	'mediaType','application/octet-stream','chunks',jsonb_build_array(jsonb_build_object(
		'sha256',encode(extensions.digest(convert_to(current_setting('qorpera_test.cofounder_document'),'utf8'),
			'sha256'),'hex'),'bytes',octet_length(current_setting('qorpera_test.cofounder_document')))))::text,true);
select set_config('qorpera_test.evolved_tree',(select cache.manifest::text
	from public.qorpera_company_files file join public.qorpera_company_snapshots snapshot
		on snapshot.id = file.head_snapshot_id join public.qorpera_company_path_tree_cache cache
		on cache.profile_id = file.profile_id and cache.sha256 = snapshot.tree_manifest_sha256
	where file.profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid),true);
select set_config('qorpera_test.evolved_head',(select head_snapshot_id::text from public.qorpera_company_files
	where profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid),true);
update public.qorpera_company_bootstrap_jobs set state = 'queued',first_run_required = false,
	lease_owner = null,lease_expires_at = null,candidate_snapshot_id = null,output_snapshot_id = null,
	completed_at = null,updated_at = clock_timestamp()
where profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.evolved_claim',public.qorpera_claim_company_bootstrap(
	current_setting('qorpera_test.bootstrap_worker')::uuid,60)::text,true);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.evolved_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'formation_manifest',
	current_setting('qorpera_test.bootstrap_file_manifest_sha'),
	octet_length(current_setting('qorpera_test.bootstrap_file_manifest')),false);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.evolved_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'cofounder_agent_manifest',
	encode(extensions.digest(convert_to(current_setting('qorpera_test.evolved_agent_manifest'),'utf8'),'sha256'),'hex'),
	octet_length(current_setting('qorpera_test.evolved_agent_manifest')),false);
select public.qorpera_stage_company_bootstrap_object(
	(current_setting('qorpera_test.evolved_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,'tree',
	encode(extensions.digest(convert_to(current_setting('qorpera_test.evolved_tree'),'utf8'),'sha256'),'hex'),
	octet_length(current_setting('qorpera_test.evolved_tree')),false);
select set_config('qorpera_test.evolved_replay',public.qorpera_finalize_company_bootstrap(
	(current_setting('qorpera_test.evolved_claim')::jsonb ->> 'jobId')::uuid,
	current_setting('qorpera_test.bootstrap_worker')::uuid,current_setting('qorpera_test.bootstrap_document'),
	current_setting('qorpera_test.bootstrap_file_manifest'),current_setting('qorpera_test.evolved_agent_manifest'),
	current_setting('qorpera_test.evolved_tree'),jsonb_build_object(
		'organization/formation.json',current_setting('qorpera_test.bootstrap_document'),
		current_setting('qorpera_test.cofounder_path'),current_setting('qorpera_test.cofounder_document'),
		'organization/responsibilities/31000000-0000-4000-8000-000000000100.json',
		current_setting('qorpera_test.responsibility_document'),
		'organization/projects/31000000-0000-4000-8000-000000000200.json',
		current_setting('qorpera_test.project_document'))
		|| current_setting('qorpera_test.responsibility_documents')::jsonb)::text,true);
reset role;
do $$ begin
	if current_setting('qorpera_test.evolved_replay')::jsonb ->> 'snapshotId'
			<> current_setting('qorpera_test.evolved_head')
		or not exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
				and staff.staff_agent_id = (current_setting('qorpera_test.org_company')::jsonb #>>
					'{organization,cofounder,staff_agent_id}')::uuid
				and staff.display_name = 'Founding Partner' and staff.version = 2)
		or (select count(*) from public.qorpera_agent_first_runs where profile_id =
			(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
			and staff_agent_id = (current_setting('qorpera_test.org_company')::jsonb #>>
				'{organization,cofounder,staff_agent_id}')::uuid) <> 1 then
		raise exception 'Bootstrap replay did not preserve the evolved Co-Founder'; end if;
end $$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.undelegated_resource',public.qorpera_set_company_path_resource(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	'finance/undelegated.json','exact','company_shared','protected',null)::text,true);
reset role;
create function pg_temp.org_project_agent_grants(p_actor jsonb,p_staff uuid,p_grants jsonb,p_version uuid)
returns void language plpgsql security definer as $$
begin
	perform public.qorpera_project_company_agent_grants(p_actor,p_staff,p_grants,p_version,true);
end
$$;
select pg_temp.org_claims('service_role');
set local role service_role;
do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb;
	v_cofounder uuid := (v_company #>> '{organization,cofounder,staff_agent_id}')::uuid;
begin
	begin
		perform pg_temp.org_project_agent_grants(jsonb_build_object(
			'companyId',v_company ->> 'profile_id','environmentId',v_company ->> 'environment_id',
			'userId','31000000-0000-4000-8000-000000000001','staffAgentId',v_cofounder,'audience','company'),
			v_cofounder,jsonb_build_object('responsibilities','[]'::jsonb,'projects','[]'::jsonb,'rooms','[]'::jsonb,
				'resources',jsonb_build_array(jsonb_build_object(
					'resourceId',current_setting('qorpera_test.undelegated_resource')::jsonb ->> 'resourceId',
					'resourceVersion',current_setting('qorpera_test.undelegated_resource')::jsonb ->> 'version',
					'permissions',jsonb_build_array('read')))),
			(current_setting('qorpera_test.cofounder_applied')::jsonb #>> '{result,version}')::uuid);
		raise exception 'Agent delegated a resource it did not possess';
	exception when insufficient_privilege then null; end;
end
$$;
reset role;

select set_config('qorpera_test.cofounder_archive_document',(
	current_setting('qorpera_test.cofounder_document')::jsonb ||
	jsonb_build_object('revision',3,'employmentStatus','archived'))::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.cofounder_archive_entry',pg_temp.org_stage_file(
	current_setting('qorpera_test.cofounder_path'),current_setting('qorpera_test.cofounder_archive_document'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.cofounder_archive_command',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('cofounder-agent-v3-archive',current_setting('qorpera_test.cofounder_path'),
		current_setting('qorpera_test.cofounder_archive_entry')::jsonb,
		(current_setting('qorpera_test.cofounder_applied')::jsonb #>> '{result,version}')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.cofounder_archive_command')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.cofounder_archive_command')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
do $$ begin
	begin
		perform pg_temp.org_apply(current_setting('qorpera_test.cofounder_archive_command')::jsonb,
			current_setting('qorpera_test.cofounder_archive_document'));
		raise exception 'Co-Founder was archived';
	exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Formation, responsibility, and project projections reject skipped revisions and
-- backward lifecycle changes before they can become enforcement state.
do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb;
	v_actor jsonb := jsonb_build_object(
		'companyId',v_company ->> 'profile_id','environmentId',v_company ->> 'environment_id',
		'userId','31000000-0000-4000-8000-000000000001','audience','human');
	v_snapshot uuid := (current_setting('qorpera_test.project_applied')::jsonb #>> '{result,snapshotId}')::uuid;
	v_version uuid := (current_setting('qorpera_test.project_applied')::jsonb #>> '{result,version}')::uuid;
	v_document jsonb; v_text text; v_plan jsonb;
begin
	v_document := current_setting('qorpera_test.formation_document')::jsonb ||
		'{"state":"research","revision":2}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_build_object('path','organization/formation.json','entry',jsonb_build_object(
		'kind','file','file',jsonb_build_object('fileSha256',encode(extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex'))));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Formation state skipped a required transition';
	exception when invalid_parameter_value then null; end;

	v_document := current_setting('qorpera_test.responsibility_document')::jsonb || '{"version":3}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_build_object(
		'path','organization/responsibilities/31000000-0000-4000-8000-000000000100.json',
		'entry',jsonb_build_object('kind','file','file',jsonb_build_object(
			'fileSha256',encode(extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex'))));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Responsibility skipped a document version';
	exception when invalid_parameter_value then null; end;

	v_document := current_setting('qorpera_test.responsibility_document')::jsonb ||
		'{"status":"proposed","version":2}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_set(v_plan,'{entry,file,fileSha256}',to_jsonb(encode(
		extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Responsibility moved backward in its lifecycle';
	exception when invalid_parameter_value then null; end;

	-- No ceremonial responsibilities: a document without a measurable outcome
	-- and sources, or whose source is not a current Company File path, is invalid.
	v_document := current_setting('qorpera_test.responsibility_document')::jsonb ||
		'{"measures":[],"version":2}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_set(v_plan,'{entry,file,fileSha256}',to_jsonb(encode(
		extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Ceremonial responsibility was accepted';
	exception when invalid_parameter_value then null; end;
	v_document := jsonb_set(current_setting('qorpera_test.responsibility_document')::jsonb || '{"version":2}'::jsonb,
		'{measures,0,sources}',jsonb_build_array(jsonb_build_object('path','missing/source.json','pathMatch','exact')));
	v_text := v_document::text;
	v_plan := jsonb_set(v_plan,'{entry,file,fileSha256}',to_jsonb(encode(
		extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Responsibility measure bound to an absent source';
	exception when invalid_parameter_value then null; end;
	-- Exactly one accountable agent, and it must be employed.
	v_document := current_setting('qorpera_test.responsibility_document')::jsonb ||
		jsonb_build_object('version',2,'accountableStaffAgentId','31000000-0000-4000-8000-000000000999');
	v_text := v_document::text;
	v_plan := jsonb_set(v_plan,'{entry,file,fileSha256}',to_jsonb(encode(
		extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Responsibility accepted an unknown accountable agent';
	exception when insufficient_privilege then null; end;

	v_document := current_setting('qorpera_test.project_document')::jsonb || '{"version":3}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_build_object(
		'path','organization/projects/31000000-0000-4000-8000-000000000200.json',
		'entry',jsonb_build_object('kind','file','file',jsonb_build_object(
			'fileSha256',encode(extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex'))));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Project skipped a document version';
	exception when invalid_parameter_value then null; end;

	v_document := current_setting('qorpera_test.project_document')::jsonb ||
		'{"status":"proposed","version":2}'::jsonb;
	v_text := v_document::text;
	v_plan := jsonb_set(v_plan,'{entry,file,fileSha256}',to_jsonb(encode(
		extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex')));
	begin
		perform public.qorpera_project_organization_document(v_actor,v_plan,v_text,v_snapshot,v_version);
		raise exception 'Project moved backward in its lifecycle';
	exception when invalid_parameter_value then null; end;
end
$$;

select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.organization_projection',public.qorpera_company_organization_json(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid)::text,true);
reset role;
do $$
declare v_org jsonb := current_setting('qorpera_test.organization_projection')::jsonb; v_operations jsonb;
begin
	select value into v_operations from jsonb_array_elements(v_org -> 'responsibilities') value
	where value ->> 'slug' = 'operations';
	if jsonb_array_length(v_org -> 'responsibilities') <> 5
		or v_operations #>> '{escalation_target,kind}' <> 'accountable_member'
		or v_operations #>> '{budget_policy,currency}' <> 'DKK'
		or v_operations #>> '{resources,0,scope}' <> 'responsibility_scoped'
		or v_operations #>> '{active_projects,0,project_id}' <> '31000000-0000-4000-8000-000000000200'
		or v_operations #>> '{measures,0,sources,0,source_path_version}' is null
		or jsonb_array_length(v_operations #> '{measures,0,sources}') <> 2
		or v_org #>> '{projects,0,sponsoring_responsibility_id}' <> '31000000-0000-4000-8000-000000000100'
		or v_org #>> '{projects,0,reasoning_policy,effort}' <> 'high'
		or jsonb_array_length(v_org #> '{projects,0,resources}') <> 2 then
		raise exception 'Canonical organization hierarchy omitted semantic policy or resource state'; end if;
end
$$;

-- A responsibility resource is a Company File-projected ACL scope, never an
-- actor. The responsibility document's accountable agent (or an explicit
-- responsibility grant on an agent document) and current employment jointly
-- authorize it.
select pg_temp.org_claims('service_role');
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,template_id,
	appearance_color,appearance_shape,appearance_creature,employment_status,lifecycle_state,version,
	created_at,updated_at,updated_by_user_id)
values ((current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid,
	'31000000-0000-4000-8000-000000000300','Unassigned agent','Specialist','Outside the responsibility.',null,
		'gray','round','brain','active','active',1,statement_timestamp(),statement_timestamp(),
		'31000000-0000-4000-8000-000000000001');
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
reset role;
do $$
declare v_profile uuid := (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into strict v_resource from public.qorpera_company_path_resources
	where id = '31000000-0000-4000-8000-000000000110';
	if not public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',
		(current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}')::uuid,'write')
		or public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',
			'31000000-0000-4000-8000-000000000300','read') then
		raise exception 'Responsibility accountability and document grant did not jointly fence the path'; end if;
end
$$;

-- Member-private authority is bound to the exact member audience. Company
-- audience and another member cannot reuse the same staff grant.
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.private_resource',public.qorpera_set_company_path_resource(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	'members/31000000-0000-4000-8000-000000000001/private/cofounder','subtree','member_private','normal',null)::text,true);
select public.qorpera_grant_company_path(
	(current_setting('qorpera_test.private_resource')::jsonb ->> 'resourceId')::uuid,
	(current_setting('qorpera_test.private_resource')::jsonb ->> 'version')::uuid,'staff_agent',
	(current_setting('qorpera_test.org_company')::jsonb #>> '{organization,cofounder,staff_agent_id}')::uuid,
	array['read','write']);
reset role;
do $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb; v_actor jsonb;
begin
	v_actor := jsonb_build_object('companyId',v_company ->> 'profile_id','environmentId',v_company ->> 'environment_id',
		'userId','31000000-0000-4000-8000-000000000001',
		'staffAgentId',v_company #>> '{organization,cofounder,staff_agent_id}',
		'audience','member_private','audienceUserId','31000000-0000-4000-8000-000000000001');
	if not public.qorpera_company_path_allowed(v_actor,
		'members/31000000-0000-4000-8000-000000000001/private/cofounder/note.md','write')
		or public.qorpera_company_path_allowed(v_actor || '{"audience":"company","audienceUserId":null}'::jsonb,
			'members/31000000-0000-4000-8000-000000000001/private/cofounder/note.md','read')
		or public.qorpera_company_path_allowed(v_actor || jsonb_build_object(
			'userId','31000000-0000-4000-8000-000000000002',
			'audienceUserId','31000000-0000-4000-8000-000000000002'),
			'members/31000000-0000-4000-8000-000000000001/private/cofounder/note.md','read') then
		raise exception 'Member-private Company File authority crossed its audience'; end if;
end
$$;

-- Canonical organizational state cannot be deleted, supplied with different
-- bytes, or published through the legacy projection-blind RPC.
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.formation_delete',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('formation-delete','organization/formation.json',null,
		current_setting('qorpera_test.formation_version')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.formation_delete')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.formation_delete')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.org_apply(current_setting('qorpera_test.formation_delete')::jsonb,null);
		raise exception 'Canonical formation document was deleted';
	exception when invalid_parameter_value then null; end;
end
$$;
reset role;

select set_config('qorpera_test.formation_document_v2',(
	current_setting('qorpera_test.formation_document')::jsonb || '{"revision":2}'::jsonb)::text,true);
select pg_temp.org_claims('service_role');
set local role service_role;
select set_config('qorpera_test.formation_entry_v2',pg_temp.org_stage_file(
	'organization/formation.json',current_setting('qorpera_test.formation_document_v2'))::text,true);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.formation_command_v2',public.qorpera_begin_member_company_path_command(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
	pg_temp.org_plan('formation-v2','organization/formation.json',
		current_setting('qorpera_test.formation_entry_v2')::jsonb,
		current_setting('qorpera_test.formation_version')::uuid))::text,true);
select public.qorpera_review_member_company_path_command(
	(current_setting('qorpera_test.formation_command_v2')::jsonb ->> 'commandId')::uuid,
	current_setting('qorpera_test.formation_command_v2')::jsonb ->> 'planSha256','approve');
reset role;
select pg_temp.org_claims('service_role');
set local role service_role;
do $$
declare v_command jsonb := current_setting('qorpera_test.formation_command_v2')::jsonb;
	v_prepared jsonb; v_entries jsonb; v_tree text;
begin
	begin
		perform pg_temp.org_apply(v_command,current_setting('qorpera_test.formation_document'));
		raise exception 'Different organization bytes were accepted';
	exception when invalid_parameter_value then null; end;
	v_prepared := public.qorpera_prepare_member_company_path_command(
		(v_command ->> 'commandId')::uuid,v_command ->> 'planSha256');
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(v_prepared -> 'entries')
		where value ->> 'path' <> v_prepared #>> '{plan,path}'
		union all select v_prepared #> '{plan,entry}'
	) entries;
	v_tree := pg_temp.org_stage_tree(v_entries);
	begin
		perform public.qorpera_apply_member_company_path_command(
			(v_command ->> 'commandId')::uuid,v_command ->> 'planSha256',
			(v_prepared ->> 'snapshotId')::uuid,v_tree);
		set constraints qorpera_company_path_organization_projection immediate;
		raise exception 'Legacy publisher bypassed the organization projection';
	exception when check_violation then null; end;
	set constraints qorpera_company_path_organization_projection deferred;
end
$$;
reset role;

do $$
declare v_role text; v_table text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		foreach v_table in array array['qorpera_company_formations','qorpera_company_cofounders',
			'qorpera_company_responsibilities','qorpera_responsibility_measures',
			'qorpera_responsibility_measure_sources','qorpera_agent_responsibility_grants',
			'qorpera_company_projects','qorpera_project_staff_memberships',
			'qorpera_responsibility_path_resources','qorpera_project_path_resources',
			'qorpera_responsibility_external_operation_grants'] loop
			if has_table_privilege(v_role,'public.' || v_table,'SELECT,INSERT,UPDATE,DELETE') then
				raise exception 'Organization enforcement table % is exposed to %',v_table,v_role; end if;
		end loop;
	end loop;
	if has_function_privilege('authenticated',
		'public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)','EXECUTE')
		or to_regprocedure('public.qorpera_set_responsibility_path_resource(uuid,text,text,uuid)') is not null
		or to_regclass('public.qorpera_company_departments') is not null
		or has_function_privilege('authenticated',
			'public.qorpera_apply_member_company_path_command_v3(uuid,text,uuid,text,text)','EXECUTE')
		or not has_function_privilege('service_role',
			'public.qorpera_apply_member_company_path_command_v3(uuid,text,uuid,text,text)','EXECUTE') then
		raise exception 'Organization projection authority is exposed or unavailable'; end if;
end
$$;

rollback;
