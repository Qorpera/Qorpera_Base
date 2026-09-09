-- Actual native/office authority. These cases admit typed actions, not pixels.
select pg_temp.wake_assert(public.qorpera_valid_office_desktop_action('{"kind":"desktop","action":"type","text":"v"}'),'literal v is text, not whitespace');
do $$ declare bad jsonb; begin
 for bad in select value from jsonb_array_elements('[
  null,[],{},42,{"kind":"desktop","action":"drag"},
  {"kind":"desktop","action":"move","x":-1,"y":0},{"kind":"desktop","action":"move","x":1920,"y":0},
  {"kind":"desktop","action":"move","x":0,"y":1200},{"kind":"desktop","action":"move","x":0.5,"y":0},
  {"kind":"desktop","action":"move","x":"0","y":0},{"kind":"desktop","action":"move","x":0},
  {"kind":"desktop","action":"click","x":0,"y":0,"button":"wheel"},
  {"kind":"desktop","action":"click","x":0,"y":0},
  {"kind":"desktop","action":"scroll","direction":"left","amount":1},
  {"kind":"desktop","action":"scroll","direction":"down","amount":0},
  {"kind":"desktop","action":"scroll","direction":"down","amount":21},
  {"kind":"desktop","action":"scroll","direction":"up","amount":1.5},
  {"kind":"desktop","action":"press","key":"F13"},{"kind":"desktop","action":"press","key":"Enter; exec"},
  {"kind":"desktop","action":"press","key":"Control+Alt+Shift+Meta+Shift+A"},
  {"kind":"desktop","action":"type","text":false},{"kind":"desktop","action":"type","text":""},
  {"kind":"desktop","action":"type","text":" \t\n\r\u000b\u00a0\ufeff"},
  {"kind":"desktop","action":"press","key":"Enter","shell":"bad"},
  {"kind":"desktop","action":"move","x":0,"y":0,"display":":2"},
  {"kind":"screenshot","surface":"desktop","path":"/private"},{"kind":"screenshot","surface":"browser"}
 ]'::jsonb) loop
  perform pg_temp.wake_assert(not public.qorpera_valid_office_desktop_action(bad),'invalid desktop action refused: '||bad::text);
 end loop;
 perform pg_temp.wake_assert(not public.qorpera_valid_office_desktop_action(jsonb_build_object('kind','desktop','action','type','text',repeat('ø',8193))),'text limit counts bytes');
end $$;
create function pg_temp.desktop_configure(p_caps jsonb default '["desktop"]',p_version bigint default 1,p_enabled boolean default true)
returns jsonb language sql as $$
 select public.qorpera_configure_runtime_office_access(current_setting('qorpera_test.office_scope')::jsonb,
  '30000000-0000-4000-8000-000000000030',p_version,p_enabled,p_caps)
$$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error('select pg_temp.desktop_configure()','42501');
select pg_temp.wake_error($q$select public.qorpera_runtime_office_access_status(current_setting('qorpera_test.office_scope')::jsonb,
 '30000000-0000-4000-8000-000000000030')$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_runtime_office_access_status(current_setting('qorpera_test.office_scope')::jsonb,
 '30000000-0000-4000-8000-000000000030')#>'{grant,capabilities}'='["shell"]'::jsonb,'migration preserves legacy shell-only grants');
do $$ declare caps jsonb; begin
 for caps in select value from jsonb_array_elements('[null,[],{},["browser"],["shell","desktop"],["desktop","desktop"],["desktop","shell","browser"]]') loop
  perform pg_temp.wake_error(format('select pg_temp.desktop_configure(%L::jsonb)',caps::text),'22023');
 end loop;
end $$;
select pg_temp.wake_error('select pg_temp.desktop_configure(null)','22023');
select pg_temp.wake_error($q$select pg_temp.desktop_configure('["desktop"]',0)$q$,'40001');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_office_access(
 jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"34000000-0000-4000-8000-000000000099"'),
 '30000000-0000-4000-8000-000000000030',1,true,'["desktop"]')$q$,'42501');
select set_config('qorpera_test.desktop_grant',pg_temp.desktop_configure()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.desktop_grant')::jsonb=
 jsonb_build_object('schema','qorpera.office-access-status/v1','scope',current_setting('qorpera_test.office_scope')::jsonb,
 'staffAgentId','30000000-0000-4000-8000-000000000030','grant',
 jsonb_build_object('grantId',current_setting('qorpera_test.office_grant')::jsonb->>'grantId',
 'version',2,'state','active','capabilities','["desktop"]'::jsonb)),'explicit grant returns bound closed metadata');
select pg_temp.wake_error('select pg_temp.desktop_configure()','40001');
reset role;
savepoint desktop_grant_legacy;
-- The legacy enable/disable API retains explicitly configured capabilities.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
 '30000000-0000-4000-8000-000000000030',2,false);
select pg_temp.wake_assert(public.qorpera_runtime_office_access_status(current_setting('qorpera_test.office_scope')::jsonb,
 '30000000-0000-4000-8000-000000000030')#>'{grant,capabilities}'='["desktop"]'::jsonb,'legacy revocation preserves configured set');
reset role;
rollback to savepoint desktop_grant_legacy;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error('select pg_temp.desktop_configure()','42501');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["desktop"]'::jsonb,
 'native descriptor derives desktop from the explicit member grant');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
create function pg_temp.desktop_envelope(p_args jsonb,p_key text default 'desktop-case') returns text language sql as $$
 select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
  'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
   -array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
  'operation',jsonb_build_object('tool','computer_'||(p_args->>'kind'),'toolVersion','qorpera.company-computer-tools/v2',
   'logicalOperationKey',p_key,'requiresCompanyRevision',false,'arguments',p_args,
   'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
    'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text
$$;
create function pg_temp.desktop_effect(p_action text,p_envelope text default null) returns jsonb language sql as $$
 select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,
  current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
  coalesce(p_envelope,current_setting('qorpera_test.desktop_envelope')),p_action,
  case when p_action='authorize' then null else current_setting('qorpera_test.desktop_receipt')::uuid end,
  case when p_action='authorize' then null else repeat('d',64) end)
$$;
-- Desktop authority does not require a browser capability; neither implies shell.
do $$ declare args jsonb; envelope text; key text; ordinal integer:=0; receipt uuid; digest text; begin
 for args in select value from jsonb_array_elements('[
  {"kind":"desktop","action":"click","x":0,"y":0,"button":"left"},
  {"kind":"desktop","action":"click","x":1919,"y":1199,"button":"middle"},
  {"kind":"desktop","action":"click","x":12,"y":34,"button":"right"},
  {"kind":"desktop","action":"move","x":1919,"y":1199},
  {"kind":"desktop","action":"scroll","direction":"up","amount":1},
  {"kind":"desktop","action":"scroll","direction":"down","amount":20},
  {"kind":"desktop","action":"press","key":"Control+Alt+Shift+Meta+F12"},
  {"kind":"desktop","action":"type","text":"$(literal) --text\nø"},
  {"kind":"screenshot","surface":"desktop"}
 ]'::jsonb) loop
  ordinal:=ordinal+1; key:='desktop-'||ordinal; envelope:=pg_temp.desktop_envelope(args,key); receipt:=extensions.gen_random_uuid();
  digest:=encode(extensions.digest(envelope,'sha256'),'hex');
  perform set_config('qorpera_test.desktop_envelope',envelope,true);
  perform set_config('qorpera_test.desktop_receipt',receipt::text,true);
  perform pg_temp.wake_assert(pg_temp.desktop_effect('authorize')->>'state'='authorized','desktop-only action authorized');
  perform public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,receipt,
   'computer_'||(args->>'kind')||':'||key,digest,repeat('d',64),false);
  perform pg_temp.desktop_effect('begin');
  perform pg_temp.wake_error('select pg_temp.desktop_effect(''begin'')','55000');
  perform pg_temp.desktop_effect('check');
  perform pg_temp.desktop_effect('finish');
  perform pg_temp.wake_error('select pg_temp.desktop_effect(''check'')','42501');
  perform public.qorpera_complete_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,receipt,digest,
   jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',digest,'content',jsonb_build_object('kind','json','value',jsonb_build_object('fixtureAdmitted',true))));
 end loop;
end $$;
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"browser","action":"snapshot"}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"screenshot","surface":"browser"}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"shell","command":"true","timeoutMs":1000}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"desktop","action":"move","x":1920,"y":0}'))$q$,'42501');
reset role;
savepoint desktop_authority;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.desktop_configure('["shell"]',2);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)->>'state'='admitted','fresh shell-only lease admitted');
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"desktop","action":"press","key":"Enter"}'))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"screenshot","surface":"desktop"}'))$q$,'42501');
select pg_temp.wake_assert(pg_temp.desktop_effect('authorize',pg_temp.desktop_envelope('{"kind":"shell","command":"true","timeoutMs":1000}'))->>'state'='authorized','shell-only grant permits shell');
reset role;
rollback to savepoint desktop_authority;
update public.qorpera_runtime_offices set privacy_version=privacy_version+1;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint desktop_authority;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.desktop_configure('["desktop"]',2,false);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.desktop_effect('authorize')$q$,'42501');
reset role;
rollback to savepoint desktop_authority;
select pg_temp.wake_assert((select count(*)=9 from public.qorpera_runtime_office_resources where state='drained'),'nine exact desktop effects drained');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_valid_office_desktop_action(jsonb)','EXECUTE'),'desktop validator stays private');
