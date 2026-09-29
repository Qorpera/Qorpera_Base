-- Fixture for scripts/load-company-fence-pool.mjs, run after 602's committed fixture: the path gateway company
-- 30000000-0000-4000-8000-000000000010, its Company File, its sponsor and native login, and the agent run whose
-- native binding 602 keeps as qorpera_test.parent_binding. Each load agent is a staff agent of its own with its
-- own conversation, run and native binding (a kickoff input, the orchestrator's claim, a runner, its assignment
-- and native lease). Everything here commits: the harness's database is disposable.
create schema loadpool;
create table loadpool.agents (n integer primary key, binding jsonb not null);

-- An agent of its own (a company has one open conversation per agent), its conversation, and a kickoff run
-- there with its own native binding, started as 300's wake fixture starts one and acknowledged, so its reads
-- and effects are allowed. As 300's fixture makes Bob and Carol, pg_temp.wake_input_run and pg_temp.wake_start.
create function pg_temp.loadpool_agent(p_staff uuid, p_name text) returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_session uuid := extensions.gen_random_uuid();
	v_input uuid := extensions.gen_random_uuid(); v_run uuid := extensions.gen_random_uuid(); v_job uuid;
	v_resource public.qorpera_company_path_resources%rowtype; v_binding jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
		employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
	select profile_id,p_staff,p_name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,
		model_provider,model_id,created_at,updated_at,updated_by_user_id from public.qorpera_profile_staff
	where profile_id = v_base.profile_id and staff_agent_id = '30000000-0000-4000-8000-000000000030';
	update public.qorpera_shared_sessions set status = 'closed'
	where profile_id = v_base.profile_id and staff_agent_id = p_staff::text and status = 'open';
	insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
		created_by_user_id,staff_agent_id,staff_version,execution_scope)
	select v_session,extensions.gen_random_uuid(),v_base.profile_id,v_base.environment_id,p_name,'open',
		'30000000-0000-4000-8000-000000000001',p_staff::text,staff.version,'{}'
	from public.qorpera_profile_staff staff
	where staff.profile_id = v_base.profile_id and staff.staff_agent_id = p_staff;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	select * into strict v_resource from public.qorpera_company_path_resources where environment_id = v_base.environment_id and path = '';
	perform public.qorpera_grant_company_path(v_resource.id,v_resource.version,'staff_agent',p_staff,array['read','write']);
	perform public.qorpera_configure_session_execution(v_session,v_base.sponsor_binding_id,1,null,'agent_turn','agent_turn');
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
	values (v_input,v_session,extensions.gen_random_uuid(),'kickoff','30000000-0000-4000-8000-000000000001',
		'{"schema":"qorpera.staff-kickoff/v1"}');
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,v_session,v_base.substrate_version_id,
		v_run,'agent_turn','agent_turn','{}',v_base.requested_by_user_id) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	select v_run,v_base.profile_id,v_base.environment_id,'session_turn',v_run,v_session,v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,p_staff,staff.version,array[v_input],
		v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,
		v_base.requested_by_user_id
	from public.qorpera_profile_staff staff where staff.profile_id = v_base.profile_id and staff.staff_agent_id = p_staff;
	update public.qorpera_runner_jobs set run_id = v_run where id = v_job;
	if not public.qorpera_reserve_execution_sponsor_authority(v_run) then
		raise exception 'Fixture: the sponsor refused a run for %', p_name; end if;
	update public.qorpera_session_inputs set execution_run_id = v_run where id = v_input and execution_run_id is null;
	perform public.qorpera_append_execution_input_events(v_session,array[v_input]);
	insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run,'queued');
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_public_send(v_binding,'progress','ack-' || p_staff);
	perform public.qorpera_assert_wake_work_allowed(v_run);
	return v_binding;
end
$$;

do $$
begin
	for v_n in 1..current_setting('loadpool.agents')::integer loop
		insert into loadpool.agents(n,binding)
		values (v_n,pg_temp.loadpool_agent(('74300000-0000-4000-8000-' || lpad(v_n::text,12,'0'))::uuid,'Load agent ' || v_n));
	end loop;
end
$$;

-- An object in the company's bucket that nothing references and that is older than a day: the next GC claim
-- takes it. (The age is the fixture's: the insert records now.)
create function loadpool.gc_object(p_sha256 text) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',true);
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || p_sha256,'{"size":64}');
	perform set_config('session_replication_role','replica',true);
	update public.qorpera_profile_objects set created_at = created_at - interval '25 hours'
	where profile_id = '30000000-0000-4000-8000-000000000010' and sha256 = p_sha256;
end
$$;

-- One object stored in the company's bucket, as one Storage upload by the object gateway.
create function loadpool.store_object(p_sha256 text, p_bytes bigint) returns boolean language sql as $$
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','30000000-0000-4000-8000-000000000010/' || p_sha256,jsonb_build_object('size',p_bytes))
	on conflict do nothing
	returning true
$$;

-- A file's manifest and plan entry for p_path, and the two objects the object gateway stores for it (the bytes
-- and the manifest). As 300's pg_temp.path_stage_file.
create function loadpool.file(p_path text, p_text text) returns jsonb language plpgsql as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',
		jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))))::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	return jsonb_build_object('manifest',v_manifest,
		'objects',jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text)),
			jsonb_build_object('sha256',v_manifest_hash,'bytes',octet_length(v_manifest))),
		'entry',jsonb_build_object('path',p_path,'kind','file','executable',false,
		'file',jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','application/octet-stream')));
end
$$;

-- The tree a prepared mutation needs (the prepared entries with the plan's entry in place of its path's): its
-- manifest text and the object that stores it. As 300's pg_temp.path_commit.
create function loadpool.tree(p_prepared jsonb, p_plan jsonb) returns jsonb language plpgsql as $$
declare v_entries jsonb; v_manifest text;
begin
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(p_prepared -> 'entries') where value ->> 'path' <> p_plan ->> 'path'
		union all select p_plan -> 'entry' where p_plan -> 'entry' <> 'null'::jsonb
	) entries;
	v_manifest := jsonb_build_object('schema','qorpera.company-tree/v1','contractVersion',3,'omittedLayers',
		'["company-git-history","session-trail","staff-registry","product-git-checkouts","dependency-caches","staff-instructions","system-metadata"]'::jsonb,
		'entries',v_entries)::text;
	return jsonb_build_object('manifest',v_manifest,'object',jsonb_build_object(
		'sha256',encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex'),'bytes',octet_length(v_manifest)));
end
$$;
