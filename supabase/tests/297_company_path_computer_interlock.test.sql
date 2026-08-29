-- Real Company File enrollment with its verified empty-tree fixture.
-- No authority helper is replaced; all test data rolls back.
begin;

insert into auth.users(id,email) values
	('29700000-0000-4000-8000-000000000001','path-owner@example.test'),
	('29700000-0000-4000-8000-000000000002','path-member@example.test'),
	('29700000-0000-4000-8000-000000000003','path-viewer@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29700000-0000-4000-8000-000000000010','Path gateway fixture','29700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('29700000-0000-4000-8000-000000000010','29700000-0000-4000-8000-000000000001','path-owner@example.test','Owner','owner'),
	('29700000-0000-4000-8000-000000000010','29700000-0000-4000-8000-000000000002','path-member@example.test','Member','contributor'),
	('29700000-0000-4000-8000-000000000010','29700000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('29700000-0000-4000-8000-000000000020','29700000-0000-4000-8000-000000000010','Environment',1,'29700000-0000-4000-8000-000000000001');

create function pg_temp.path_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;

create function pg_temp.path_stage_file(p_path text,p_text text)
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29700000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','29700000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('29700000-0000-4000-8000-000000000010',v_manifest);
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
	values ('qorpera-profile-objects','29700000-0000-4000-8000-000000000010/' || v_sha,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	return public.qorpera_verify_company_path_tree('29700000-0000-4000-8000-000000000010',v_manifest);
end
$$;

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.path_tree',pg_temp.path_stage_tree('[]'),true);
select pg_temp.path_claims('authenticated','29700000-0000-4000-8000-000000000001');
insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
	tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
select '29700000-0000-4000-8000-000000000023',f.profile_id,f.environment_id,f.canonical_workspace_id,
	'29700000-0000-4000-8000-000000000024',c.sha256,c.bytes,3,0,0,f.created_by_user_id
from public.qorpera_company_files f join public.qorpera_company_path_tree_cache c on c.profile_id = f.profile_id
where f.environment_id = '29700000-0000-4000-8000-000000000020' and c.sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
	contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
values ('29700000-0000-4000-8000-000000000025','29700000-0000-4000-8000-000000000010',
	'29700000-0000-4000-8000-000000000020','29700000-0000-4000-8000-000000000023',
	'29700000-0000-4000-8000-000000000026',1,0,0,repeat('d',64),'29700000-0000-4000-8000-000000000001');
select pg_temp.path_claims('service_role');
insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
	root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
select '29700000-0000-4000-8000-000000000027',profile_id,'29700000-0000-4000-8000-000000000020','company_snapshot',
	'29700000-0000-4000-8000-000000000023','29700000-0000-4000-8000-000000000028',sha256,1,
	encode(extensions.digest(convert_to(sha256 || ':' || bytes::text,'utf8'),'sha256'),'hex'),1,bytes,'29700000-0000-4000-8000-000000000001'
from public.qorpera_company_path_tree_cache where profile_id = '29700000-0000-4000-8000-000000000010'
	and sha256 = current_setting('qorpera_test.path_tree');
insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
select '29700000-0000-4000-8000-000000000027',sha256,bytes from public.qorpera_company_path_tree_cache
where profile_id = '29700000-0000-4000-8000-000000000010' and sha256 = current_setting('qorpera_test.path_tree');
update public.qorpera_object_reachability_graphs set status = 'complete',completed_at = clock_timestamp(),closure_verified = true
where id = '29700000-0000-4000-8000-000000000027';
insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,restored_bytes,verified_by_user_id)
values ('29700000-0000-4000-8000-000000000027','29700000-0000-4000-8000-000000000010',
	'29700000-0000-4000-8000-000000000029',current_setting('qorpera_test.path_tree'),0,'29700000-0000-4000-8000-000000000001');
update public.qorpera_company_files set head_snapshot_id = '29700000-0000-4000-8000-000000000023',state = 'ready'
where environment_id = '29700000-0000-4000-8000-000000000020';
update public.qorpera_company_workspaces set head_snapshot_id = '29700000-0000-4000-8000-000000000023'
where id = (select canonical_workspace_id from public.qorpera_company_files where environment_id = '29700000-0000-4000-8000-000000000020');

-- An ordinary sandbox does not expose a company-wide filesystem.
insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,
	template_key,template_version,capabilities,created_by_user_id)
values ('29700000-0000-4000-8000-000000000030','29700000-0000-4000-8000-000000000010',
	'29700000-0000-4000-8000-000000000030','Sandbox','test','1','["agent_turn"]',
	'29700000-0000-4000-8000-000000000001');

savepoint legacy_computer_fixture;
insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,
	template_key,template_version,capabilities,computer_class,created_by_user_id)
values ('29700000-0000-4000-8000-000000000031','29700000-0000-4000-8000-000000000010',
	'29700000-0000-4000-8000-000000000031','Legacy desktop','test','1','["agent_turn"]',
	'company_computer','29700000-0000-4000-8000-000000000001');

do $$
declare v_status text;
begin
	foreach v_status in array array['active','disabled','retired'] loop
		update public.qorpera_logical_computers set status = v_status
		where id = '29700000-0000-4000-8000-000000000031';
		begin
			perform public.qorpera_enable_company_path_gateway('29700000-0000-4000-8000-000000000020',
				'29700000-0000-4000-8000-000000000023','29700000-0000-4000-8000-000000000001');
			raise exception 'Enrollment accepted an unmediated computer';
		exception when object_not_in_prerequisite_state then
			if sqlerrm <> 'Company File cutover requires verified removal of legacy computer access' then raise; end if;
		end;
		if exists (select 1 from public.qorpera_company_path_resources
			where environment_id = '29700000-0000-4000-8000-000000000020')
			or exists (select 1 from public.qorpera_company_files
				where environment_id = '29700000-0000-4000-8000-000000000020' and path_gateway_version is not null) then
			raise exception 'Rejected enrollment left partial authority';
		end if;
	end loop;
	begin
		update public.qorpera_logical_computers set computer_class = 'managed_sandbox'
		where id = '29700000-0000-4000-8000-000000000031';
		raise exception 'Relabelling cleared legacy access';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'Legacy company computer access cannot be cleared by relabelling its binding' then raise; end if;
	end;
end
$$;

-- The legacy row and its audit references remain. Only a cloud-owned,
-- hash-pinned physical teardown attestation closes the interlock, and the
-- retired historical row becomes immutable instead of being deleted.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated'] loop
		if has_function_privilege(v_role,
			'public.qorpera_register_legacy_company_computer_teardown(uuid,uuid,uuid,text,text,text,text,uuid)',
			'EXECUTE') then
			raise exception 'Untrusted role can attest a legacy computer teardown';
		end if;
	end loop;
	if not has_function_privilege('service_role',
		'public.qorpera_register_legacy_company_computer_teardown(uuid,uuid,uuid,text,text,text,text,uuid)',
		'EXECUTE') then
		raise exception 'Cloud service cannot attest a legacy computer teardown';
	end if;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,
			'public.qorpera_legacy_company_computer_teardown_matches(public.qorpera_logical_computers)',
			'EXECUTE')
			or has_function_privilege(v_role,
				'public.qorpera_legacy_company_computer_authority_sha256(public.qorpera_logical_computers)',
				'EXECUTE')
			or has_table_privilege(v_role,'public.qorpera_legacy_company_computer_teardowns',
				'INSERT,UPDATE,DELETE') then
			raise exception 'Legacy teardown authority is directly writable or callable';
		end if;
	end loop;
end
$$;

-- An offered assignment is still addressable even when its historical runner
-- is already revoked. The teardown RPC must use the real assignment states,
-- then the tombstone must reject every later core work binding.
insert into public.qorpera_runners(
	id,profile_id,client_runner_id,display_name,runner_kind,capabilities,
	max_concurrency,status,activation_token_sha256,activation_expires_at,
	registered_by_user_id,revoked_by_user_id,revoked_at,logical_computer_id
) values (
	'29700000-0000-4000-8000-000000000033',
	'29700000-0000-4000-8000-000000000010',
	'29700000-0000-4000-8000-000000000034','Retired fixture runner',
	'qorpera_computer','["agent_turn"]',1,'revoked',repeat('5',64),
	statement_timestamp() + interval '1 hour','29700000-0000-4000-8000-000000000001',
	'29700000-0000-4000-8000-000000000001',statement_timestamp(),
	'29700000-0000-4000-8000-000000000031'
);
set local session_replication_role = replica;
insert into public.qorpera_runner_assignments(
	id,claim_id,job_id,run_id,runner_id,capability_sha256,status,expires_at
) values (
	'29700000-0000-4000-8000-000000000035',
	'29700000-0000-4000-8000-000000000036',
	'29700000-0000-4000-8000-000000000037',
	'29700000-0000-4000-8000-000000000038',
	'29700000-0000-4000-8000-000000000033',repeat('6',64),'offered',
	statement_timestamp() + interval '5 minutes'
);
set local session_replication_role = origin;

select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform public.qorpera_register_legacy_company_computer_teardown(
			'29700000-0000-4000-8000-000000000010',
			'29700000-0000-4000-8000-000000000031',
			'29700000-0000-4000-8000-000000000032',
			repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
			'29700000-0000-4000-8000-000000000001');
		raise exception 'Offered legacy assignment was ignored by teardown';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'Legacy company computer still has addressable work' then raise; end if;
	end;
end
$$;
reset role;
set local session_replication_role = replica;
delete from public.qorpera_runner_assignments
where id = '29700000-0000-4000-8000-000000000035';
set local session_replication_role = origin;
delete from public.qorpera_runners
where id = '29700000-0000-4000-8000-000000000033';

set local role service_role;
select set_config('qorpera_test.legacy_teardown',(
	public.qorpera_register_legacy_company_computer_teardown(
		'29700000-0000-4000-8000-000000000010',
		'29700000-0000-4000-8000-000000000031',
		'29700000-0000-4000-8000-000000000032',
		repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
		'29700000-0000-4000-8000-000000000001'
	) ->> 'computer_authority_sha256'),true);
reset role;

do $$
declare v_computer public.qorpera_logical_computers%rowtype;
begin
	select computer.* into strict v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = '29700000-0000-4000-8000-000000000031';
	if not public.qorpera_legacy_company_computer_teardown_matches(v_computer)
		or current_setting('qorpera_test.legacy_teardown') <>
			public.qorpera_legacy_company_computer_authority_sha256(v_computer)
		or (select count(*) from public.qorpera_legacy_company_computer_teardowns
			where logical_computer_id = v_computer.id) <> 1 then
		raise exception 'Exact legacy teardown evidence was not installed';
	end if;
	begin
		update public.qorpera_logical_computers set status = 'active' where id = v_computer.id;
		raise exception 'Torn-down legacy computer was revived';
	exception when insufficient_privilege then
		if sqlerrm <> 'Torn-down legacy company computer history is immutable' then raise; end if;
	end;
	begin
		delete from public.qorpera_legacy_company_computer_teardowns
		where logical_computer_id = v_computer.id;
		raise exception 'Legacy teardown evidence was deletable';
	exception when insufficient_privilege then
		if sqlerrm <> 'Legacy company computer teardown evidence is immutable' then raise; end if;
	end;
	begin
		insert into public.qorpera_runners(
			id,profile_id,client_runner_id,display_name,runner_kind,capabilities,
			max_concurrency,status,activation_token_sha256,activation_expires_at,
			registered_by_user_id,logical_computer_id
		) values (
			'29700000-0000-4000-8000-000000000039',
			'29700000-0000-4000-8000-000000000010',
			'29700000-0000-4000-8000-000000000039','Late fixture runner',
			'qorpera_computer','["agent_turn"]',1,'pending',repeat('7',64),
			statement_timestamp() + interval '1 hour',
			'29700000-0000-4000-8000-000000000001',v_computer.id
		);
		raise exception 'Torn-down legacy computer accepted new work';
	exception when insufficient_privilege then
		if sqlerrm <> 'Torn-down legacy company computer cannot receive work' then raise; end if;
	end;
end
$$;

set local role service_role;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_register_legacy_company_computer_teardown(
		'29700000-0000-4000-8000-000000000010',
		'29700000-0000-4000-8000-000000000031',
		'29700000-0000-4000-8000-000000000032',
		repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
		'29700000-0000-4000-8000-000000000001');
	if v_result ->> 'computer_authority_sha256' <> current_setting('qorpera_test.legacy_teardown') then
		raise exception 'Legacy teardown replay was not idempotent';
	end if;
	begin
		perform public.qorpera_register_legacy_company_computer_teardown(
			'29700000-0000-4000-8000-000000000010',
			'29700000-0000-4000-8000-000000000031',
			'29700000-0000-4000-8000-000000000032',
			repeat('1',64),repeat('9',64),repeat('3',64),repeat('4',64),
			'29700000-0000-4000-8000-000000000001');
		raise exception 'Changed teardown proof reused old authority';
	exception when unique_violation then
		if sqlerrm <> 'Legacy company computer has another teardown attestation' then raise; end if;
	end;
	perform public.qorpera_enable_company_path_gateway(
		'29700000-0000-4000-8000-000000000020',
		'29700000-0000-4000-8000-000000000023',
		'29700000-0000-4000-8000-000000000001');
end
$$;
reset role;

do $$
begin
	if not exists (select 1 from public.qorpera_company_files
		where environment_id = '29700000-0000-4000-8000-000000000020' and path_gateway_version = 1) then
		raise exception 'Verified teardown did not close the legacy interlock';
	end if;
end
$$;
-- This is a disposable fixture rollback, not an unmount/recovery procedure.
rollback to savepoint legacy_computer_fixture;
release savepoint legacy_computer_fixture;

set local role service_role;
select public.qorpera_enable_company_path_gateway('29700000-0000-4000-8000-000000000020',
	'29700000-0000-4000-8000-000000000023','29700000-0000-4000-8000-000000000001');
reset role;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_enforce_company_path_computer_interlock()','EXECUTE') then
			raise exception 'Private interlock helper is callable';
		end if;
	end loop;
	begin
		insert into public.qorpera_logical_computers(profile_id,client_computer_id,display_name,
			template_key,template_version,capabilities,policy,computer_class,created_by_user_id)
		values ('29700000-0000-4000-8000-000000000010',extensions.gen_random_uuid(),'Forged governed desktop',
			'test','1','["agent_turn"]','{"company_runtime":"company-path-v1","mediated":true}',
			'company_computer','29700000-0000-4000-8000-000000000001');
		raise exception 'Registration reopened raw access';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'Governed Company Files require a path-mediated company computer' then raise; end if;
	end;
	begin
		update public.qorpera_logical_computers set computer_class = 'company_computer'
		where id = '29700000-0000-4000-8000-000000000030';
		raise exception 'Sandbox conversion reopened raw access';
	exception when object_not_in_prerequisite_state then
		if sqlerrm <> 'Governed Company Files require a path-mediated company computer' then raise; end if;
	end;
	if (select computer_class from public.qorpera_logical_computers
		where id = '29700000-0000-4000-8000-000000000030') <> 'managed_sandbox' then
		raise exception 'Denied conversion changed the sandbox';
	end if;
end
$$;

-- The one supported Company Computer is created by a service-only cloud RPC.
-- It derives the exact path-only policy and capabilities, binds a company
-- Compute Identity, and cannot be confused with the legacy raw-mount row.
insert into public.qorpera_member_compute_identities(
	id,profile_id,ownership_kind,owner_user_id,owner_scope_key,client_identity_id,
	display_name,template_key,template_version,capabilities,policy,status
) values (
	'29700000-0000-4000-8000-000000000040','29700000-0000-4000-8000-000000000010',
	'company',null,null,'29700000-0000-4000-8000-000000000041','Company identity',
	'qorpera-company-linux','v1','["agent_turn","company_substrate"]','{}','active'
);

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated'] loop
		if has_function_privilege(v_role,
			'public.qorpera_register_governed_company_computer(uuid,uuid,uuid,text,text,text,uuid)',
			'EXECUTE') then
			raise exception 'Untrusted role can register a governed company computer';
		end if;
	end loop;
	if not has_function_privilege('service_role',
		'public.qorpera_register_governed_company_computer(uuid,uuid,uuid,text,text,text,uuid)',
		'EXECUTE') then
		raise exception 'Cloud service cannot register a governed company computer';
	end if;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_governed_company_computer_policy()','EXECUTE')
			or has_function_privilege(v_role,
				'public.qorpera_governed_company_computer_matches(public.qorpera_logical_computers)',
				'EXECUTE')
			or has_table_privilege(v_role,'public.qorpera_governed_company_computers','INSERT,UPDATE,DELETE') then
			raise exception 'Private mediation authority is directly writable or callable';
		end if;
	end loop;
end
$$;

set local role service_role;
select set_config('qorpera_test.governed_computer',(
	public.qorpera_register_governed_company_computer(
		'29700000-0000-4000-8000-000000000010',
		'29700000-0000-4000-8000-000000000042',
		'29700000-0000-4000-8000-000000000040',
		repeat('a',64),repeat('b',64),repeat('c',64),
		'29700000-0000-4000-8000-000000000001'
	) ->> 'logical_computer_id'),true);
reset role;

do $$
declare v_computer public.qorpera_logical_computers%rowtype;
begin
	select computer.* into strict v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = current_setting('qorpera_test.governed_computer')::uuid;
	if v_computer.profile_id <> '29700000-0000-4000-8000-000000000010'
		or v_computer.compute_identity_id <> '29700000-0000-4000-8000-000000000040'
		or v_computer.computer_class <> 'company_computer'
		or v_computer.capabilities <> '["agent_turn"]'::jsonb
		or v_computer.encrypted_volume_object_sha256 is not null
		or not public.qorpera_governed_company_computer_matches(v_computer)
		or (select count(*) from public.qorpera_governed_company_computers
			where profile_id = v_computer.profile_id) <> 1 then
		raise exception 'Cloud registration did not create one exact governed computer';
	end if;
	begin
		update public.qorpera_logical_computers
		set policy = policy || '{"canonicalMount":true}'::jsonb
		where id = v_computer.id;
		raise exception 'Governed computer policy was mutable';
	exception when insufficient_privilege then
		if sqlerrm <> 'Governed company computer authority is immutable' then raise; end if;
	end;
end
$$;

set local role service_role;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_register_governed_company_computer(
		'29700000-0000-4000-8000-000000000010',
		'29700000-0000-4000-8000-000000000042',
		'29700000-0000-4000-8000-000000000040',
		repeat('a',64),repeat('b',64),repeat('c',64),
		'29700000-0000-4000-8000-000000000001');
	if v_result ->> 'logical_computer_id' <> current_setting('qorpera_test.governed_computer')
		or v_result ->> 'runtime' <> 'company-path-v1'
		or v_result ->> 'worker_class' <> 'company_computer' then
		raise exception 'Governed registration replay was not idempotent';
	end if;
	begin
		perform public.qorpera_register_governed_company_computer(
			'29700000-0000-4000-8000-000000000010',
			'29700000-0000-4000-8000-000000000042',
			'29700000-0000-4000-8000-000000000040',
			repeat('d',64),repeat('b',64),repeat('c',64),
			'29700000-0000-4000-8000-000000000001');
		raise exception 'Changed physical pin reused governed authority';
	exception when unique_violation then
		if sqlerrm <> 'Company already has another governed computer authority' then raise; end if;
	end;
end
$$;
reset role;

select pg_temp.path_claims('authenticated','29700000-0000-4000-8000-000000000002');
do $$
declare v_description jsonb;
begin
	v_description := public.qorpera_describe_governed_company_computer(
		'29700000-0000-4000-8000-000000000010');
	if v_description ->> 'logical_computer_id' <> current_setting('qorpera_test.governed_computer')
		or v_description ->> 'company_file_access' <> 'path_gateway_only'
		or (v_description ->> 'canonical_mount')::boolean
		or v_description ->> 'lifecycle' <> 'ephemeral_per_run' then
		raise exception 'Member descriptor weakened governed computer authority';
	end if;
end
$$;
rollback;
