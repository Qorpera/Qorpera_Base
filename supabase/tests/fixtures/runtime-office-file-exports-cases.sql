-- Actual native/office authority; immutable storage catalog confirmation is synthetic.
select pg_temp.wake_assert(public.qorpera_valid_workbench_file_path('projects/a "quote"; $.bin'),'literal workbench names are not shell syntax');
select pg_temp.wake_assert(not public.qorpera_valid_workbench_file_path('../private') and not public.qorpera_valid_workbench_file_path('/etc/passwd')
	and not public.qorpera_valid_workbench_file_path('a//b') and not public.qorpera_valid_workbench_file_path('a/./b'),'closed relative paths');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select set_config('qorpera_test.export_action','{"kind":"transfer","action":"export","source":{"realm":"company_computer","path":"projects/report.bin"},"destination":{"realm":"object_storage"},"mediaType":"application/octet-stream"}',true);
create function pg_temp.export_envelope(p_args jsonb default null) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
			-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','computer_transfer','toolVersion','qorpera.company-computer-tools/v2',
			'logicalOperationKey','file-export','requiresCompanyRevision',false,'arguments',coalesce(p_args,current_setting('qorpera_test.export_action')::jsonb),
			'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
				'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text
$$;
select set_config('qorpera_test.export_envelope',pg_temp.export_envelope(),true);
select set_config('qorpera_test.export_receipt',extensions.gen_random_uuid()::text,true);
select set_config('qorpera_test.export_file',jsonb_build_object('sha256',repeat('c',64),'bytes',4,'mediaType','application/octet-stream')::text,true);
create function pg_temp.export_effect(p_action text,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.office_scope')::jsonb,
		current_setting('qorpera_test.office_lease')::jsonb,coalesce(p_envelope,current_setting('qorpera_test.export_envelope')),p_action,
		case when p_action='authorize' then null else current_setting('qorpera_test.export_receipt')::uuid end,
		case when p_action='authorize' then null else repeat('e',64) end)
$$;
create function pg_temp.export_file(p_action text,p_file jsonb default null,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_file_export(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.office_scope')::jsonb,
		current_setting('qorpera_test.office_lease')::jsonb,coalesce(p_envelope,current_setting('qorpera_test.export_envelope')),
		current_setting('qorpera_test.export_receipt')::uuid,repeat('e',64),coalesce(p_file,current_setting('qorpera_test.export_file')::jsonb),p_action)
$$;
select pg_temp.wake_assert(pg_temp.export_effect('authorize')='{"state":"authorized"}'::jsonb,'explicit workbench export is admitted');
select pg_temp.wake_error($q$select pg_temp.export_effect('authorize',pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{source,realm}','"company_file"')))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.export_effect('authorize',pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{source,realm}','"isolated_worker"')))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.export_effect('authorize',pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{destination,realm}','"isolated_worker"')))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.export_effect('authorize',pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{source,path}','"../private"')))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.export_effect('authorize',pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{destination}','{"realm":"member_device"}')))$q$,'42501');
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.export_receipt')::uuid,
	'computer_transfer:file-export',encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),repeat('e',64),false);
select pg_temp.wake_error($q$select pg_temp.export_file('authorize')$q$,'42501');
select pg_temp.export_effect('begin');
select pg_temp.wake_error($q$select pg_temp.export_effect('begin')$q$,'55000');
select pg_temp.wake_assert(pg_temp.export_file('authorize')='{"state":"authorized"}'::jsonb,'export requires original admitted receipt');
select pg_temp.wake_error($q$select pg_temp.export_file('publish')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.export_file('authorize',current_setting('qorpera_test.export_file')::jsonb||'{"path":"/etc/passwd"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.export_file('authorize',jsonb_set(current_setting('qorpera_test.export_file')::jsonb,'{bytes}','8388609'))$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.export_file('authorize',jsonb_set(current_setting('qorpera_test.export_file')::jsonb,'{mediaType}','"text/plain"'))$q$,'22023');
select public.qorpera_confirm_native_company_object_upload(current_setting('qorpera_test.wake_binding')::jsonb,
	(current_setting('qorpera_test.office_scope')::jsonb->>'companyId')::uuid,repeat('c',64),4);
select set_config('qorpera_test.export_asset',pg_temp.export_file('publish')::text,true);
select pg_temp.wake_assert(pg_temp.export_file('publish')=current_setting('qorpera_test.export_asset')::jsonb,'same publication recovers original immutable asset');
select pg_temp.wake_assert(current_setting('qorpera_test.export_asset')::jsonb#>>'{source,path}'='projects/report.bin'
	and current_setting('qorpera_test.export_asset')::jsonb#>>'{destination,realm}'='object_storage','provenance preserves distinct realms');
select pg_temp.wake_error($q$select pg_temp.export_file('publish',null,pg_temp.export_envelope(jsonb_set(current_setting('qorpera_test.export_action')::jsonb,'{source,path}','"different.bin"')))$q$,'42501');
reset role;
savepoint export_revocation;
update public.qorpera_runtime_office_access set state='revoked';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.export_file('publish')$q$,'42501');
reset role;
rollback to savepoint export_revocation;
update public.qorpera_runtime_offices set privacy_version=privacy_version+1;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.export_file('publish')$q$,'42501');
reset role;
rollback to savepoint export_revocation;
set local role service_role;
select pg_temp.export_effect('finish');
select pg_temp.wake_error($q$select pg_temp.export_file('publish')$q$,'42501');
select public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.export_receipt')::uuid,
	encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
		'inputSha256',encode(extensions.digest(current_setting('qorpera_test.export_envelope'),'sha256'),'hex'),
		'content',jsonb_build_object('kind','json','value',current_setting('qorpera_test.export_asset')::jsonb)));
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_file_exports),'one export per original receipt');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_artifact_retention_holds where client_hold_id=current_setting('qorpera_test.export_receipt')::uuid
	and released_at is null and expires_at is null),'export evidence retained');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_file_exports','SELECT,INSERT,UPDATE,DELETE'),'private export provenance');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text)','EXECUTE'),'member cannot impersonate native export');
