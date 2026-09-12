-- Uses the real native authority fixture, with synthetic physical acknowledgements.
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
reset role;
select set_config('qorpera_test.browser_profile','34000000-0000-4000-8000-000000000071',true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,
	'30000000-0000-4000-8000-000000000031',0,true);
reset role;
-- Physical screen readiness is synthetic. The second idle desktop must still
-- be part of the barrier, even though it has no current agent lease.
insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id,generation,power)
values((current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,2,'30000000-0000-4000-8000-000000000031',1,'open');

create function pg_temp.browser_grant(p_enabled boolean,p_expected bigint,p_profile_version bigint default 2) returns jsonb language sql as $$
	select public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,
		current_setting('qorpera_test.browser_profile')::uuid,'30000000-0000-4000-8000-000000000030',p_profile_version,p_expected,p_enabled)
$$;
create function pg_temp.privacy_request(p_private boolean,p_version bigint) returns jsonb language sql as $$
	select public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
		current_setting('qorpera_test.browser_profile')::uuid,(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,p_version,p_private)
$$;
create function pg_temp.ack_drains(p_drains jsonb) returns void language plpgsql as $$
declare v_drain jsonb;
begin
	for v_drain in select value from jsonb_array_elements(p_drains) loop
		perform public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
			(v_drain#>>'{binding,screenId}')::uuid,(v_drain#>>'{binding,computerGeneration}')::bigint,
			(v_drain#>>'{binding,screenGeneration}')::bigint,(v_drain->>'epoch')::bigint,(v_drain->>'drainId')::uuid);
	end loop;
end
$$;
-- Exercise real owner ticket issuance and gateway redemption before a profile
-- can be prepared. Issuance alone (including a refused browser Origin) is not enough.
create function pg_temp.private_browser_visit(p_redeem boolean) returns void language plpgsql as $$
declare ticket jsonb; challenge jsonb:=current_setting('qorpera_test.privacy')::jsonb;
	binding jsonb; epoch bigint; saved text:=current_setting('request.jwt.claims');
begin
	select public.qorpera_runtime_office_scope(o)||jsonb_build_object('computerGeneration',o.generation,
		'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id),s.epoch
	into binding,epoch from public.qorpera_runtime_offices o join public.qorpera_runtime_office_screens s on s.office_id=o.id
	where s.id=(challenge->>'screenId')::uuid;
	perform pg_temp.path_claims('authenticated',(challenge->>'memberId')::uuid);
	ticket:=public.qorpera_create_runtime_office_viewer(binding,epoch,'control',challenge);
	perform pg_temp.path_claims('service_role');
	-- Taking over an existing driver may create a new exact drain.
	perform pg_temp.ack_drains(public.qorpera_runtime_office_supervisor_status(challenge->'scope',
		(challenge->>'computerGeneration')::bigint)->'drains');
	if p_redeem then
		perform public.qorpera_redeem_runtime_office_viewer(challenge->'scope',
			encode(extensions.digest(ticket->>'capability','sha256'),'hex'));
	end if;
	perform set_config('request.jwt.claims',saved,true);
end
$$;
-- A contributor owns their profile. An administrator cannot supply consent.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_register_runtime_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,
	current_setting('qorpera_test.browser_profile')::uuid)->>'prepared'='false','registration is not physical profile preparation');
select pg_temp.wake_error($q$select pg_temp.browser_grant(true,0,1)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.browser_grant(true,0,1)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.privacy_request(true,0)$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["shell"]'::jsonb,
	'provider subscription is not browser consent');
reset role;

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(true,0)::text,true);
select pg_temp.wake_assert(public.qorpera_runtime_office_privacy_status(current_setting('qorpera_test.office_scope')::jsonb)->'challenge'
	=current_setting('qorpera_test.privacy')::jsonb,'owner recovers lost response without another transition');
select pg_temp.wake_error($q$select pg_temp.privacy_request(true,0)$q$,'PGRST');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_call('acquire')$q$,'42501');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)='{"state":"unavailable"}'::jsonb,'no agent tool descriptor during sign-in');
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.privacy')::jsonb->'drains')=2,'privacy includes other idle desktops');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.office_lease')::jsonb->'binding')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.ack_drains(jsonb_build_array(current_setting('qorpera_test.privacy')::jsonb#>'{drains,0}'));
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(jsonb_set(current_setting('qorpera_test.privacy')::jsonb,'{profileVersion}','999'))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(jsonb_set(current_setting('qorpera_test.privacy')::jsonb,'{profileVersion}','999'))$q$,'42501');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)
	=jsonb_build_object('state','authorized','privacyState','entering','version',1,'validForMs',5000),'broker can prepare only the exact drained private surface');
select pg_temp.wake_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)->>'state'='private','private only after all physical proofs');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)->>'privacyState'='private','idle private browser requires current authority');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.office_lease')::jsonb->'binding')$q$,'42501');
select pg_temp.wake_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)->>'state'='private','ack replay harmless');
reset role;
-- Idle browser authority follows current physical state, not just the saved
-- entry challenge. Viewer reconnect drains may advance epochs within it.
savepoint private_surface_checks;
update public.qorpera_runtime_browser_profiles set version=version+1 where id=current_setting('qorpera_test.browser_profile')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
rollback to savepoint private_surface_checks;
update public.qorpera_runtime_offices set state='maintenance';
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
rollback to savepoint private_surface_checks;
update public.qorpera_runtime_office_screens set power='closed' where id=(current_setting('qorpera_test.privacy')::jsonb->>'screenId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
rollback to savepoint private_surface_checks;
select set_config('qorpera_test.private_reconnect_drains',public.qorpera_fence_runtime_office_screens(
	(select office from public.qorpera_runtime_offices office where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid))::text,true);
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.ack_drains(current_setting('qorpera_test.private_reconnect_drains')::jsonb);
select pg_temp.wake_assert(public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)->>'privacyState'='private','same private challenge resumes only after newer viewer drain');
reset role;
rollback to savepoint private_surface_checks;
update public.qorpera_runtime_office_screens set generation=generation+1 where id=(current_setting('qorpera_test.privacy')::jsonb->>'screenId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
rollback to savepoint private_surface_checks;
release savepoint private_surface_checks;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,2,true)$q$,'42501');
select pg_temp.wake_assert(public.qorpera_runtime_office_privacy_status(current_setting('qorpera_test.office_scope')::jsonb)->'challenge'='null'::jsonb,
	'admin status does not expose another member private challenge');
reset role;
savepoint unvisited_private_browser;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select set_config('qorpera_test.unvisited_exit',pg_temp.privacy_request(false,1)::text,true);
select pg_temp.path_claims('service_role');
select pg_temp.ack_drains(current_setting('qorpera_test.unvisited_exit')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.unvisited_exit')::jsonb);
select pg_temp.wake_assert((select not prepared from public.qorpera_runtime_browser_profiles where id=current_setting('qorpera_test.browser_profile')::uuid),'acknowledged private entry without a viewer is not preparation');
rollback to savepoint unvisited_private_browser;
select pg_temp.private_browser_visit(false);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
select set_config('qorpera_test.unvisited_exit',pg_temp.privacy_request(false,1)::text,true);
select pg_temp.path_claims('service_role');
select pg_temp.ack_drains(current_setting('qorpera_test.unvisited_exit')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.unvisited_exit')::jsonb);
select pg_temp.wake_assert((select not prepared from public.qorpera_runtime_browser_profiles where id=current_setting('qorpera_test.browser_profile')::uuid),'issued-only private viewer is not preparation');
rollback to savepoint unvisited_private_browser;
release savepoint unvisited_private_browser;
select pg_temp.private_browser_visit(true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.privacy')::jsonb)->>'state'='authorized','current owner private input check');
select pg_temp.wake_error($q$select pg_temp.browser_grant(true,0)$q$,'42501');
select set_config('qorpera_test.old_privacy',current_setting('qorpera_test.privacy'),true);
select set_config('qorpera_test.privacy',pg_temp.privacy_request(false,1)::text,true);
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.old_privacy')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.old_privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.old_privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_call('acquire')$q$,'42501');
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select pg_temp.wake_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)->>'state'='shared','exit requires cleared private surface');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.office_lease')::jsonb->'binding')->>'privacyVersion'='2','idle shared display can resume only after private exit acknowledgement');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["shell"]'::jsonb,'exit is not implicit consent');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.browser_grant(true,0,1)$q$,'PGRST');
select set_config('qorpera_test.browser_grant',pg_temp.browser_grant(true,0)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','grant replacement must drain idle profile channels');
select pg_temp.ack_drains(current_setting('qorpera_test.browser_grant')::jsonb->'drains');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["shell","browser"]'::jsonb,'explicit current browser consent');
create function pg_temp.browser_check(p_grant jsonb default null) returns jsonb language sql as $$
	select public.qorpera_native_office_browser_grant(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		coalesce(p_grant,current_setting('qorpera_test.browser_grant')::jsonb-'state'-'drains'))
$$;
select pg_temp.wake_assert(pg_temp.browser_check()->>'state'='authorized','current exact grant and screen');
select pg_temp.wake_error($q$select pg_temp.browser_check(jsonb_set(current_setting('qorpera_test.browser_grant')::jsonb-'state'-'drains','{version}','99'))$q$,'42501');

create function pg_temp.browser_envelope(p_action jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
			-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','computer_'||(p_action->>'kind'),'toolVersion','qorpera.company-computer-tools/v2',
			'logicalOperationKey','browser-effect','requiresCompanyRevision',false,'arguments',p_action,
			'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
				'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text
$$;
create function pg_temp.browser_effect(p_action text,p_envelope text default null) returns jsonb language sql as $$
	select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		coalesce(p_envelope,current_setting('qorpera_test.browser_envelope')),p_action,
		case when p_action='authorize' then null else current_setting('qorpera_test.browser_receipt')::uuid end,
		case when p_action='authorize' then null else repeat('e',64) end)
$$;
select set_config('qorpera_test.browser_envelope',pg_temp.browser_envelope('{"kind":"browser","action":"snapshot"}'),true);
select pg_temp.wake_assert(pg_temp.browser_effect('authorize')->>'state'='authorized','browser effect uses native authority');
do $$
declare v_args jsonb;
begin
	for v_args in select value from jsonb_array_elements('[
		{"kind":"browser","action":"navigate","url":"https://example.test/"},
		{"kind":"browser","action":"list_tabs"},
		{"kind":"browser","action":"list_tabs","afterTabId":"34000000-0000-4000-8000-000000000071"},
		{"kind":"browser","action":"select_tab","tabId":"34000000-0000-4000-8000-000000000071"},
		{"kind":"browser","action":"click","role":"button","name":"Continue"},
		{"kind":"browser","action":"fill","role":"textbox","name":"Search","text":"public query"},
		{"kind":"browser","action":"press","key":"Control+Shift+Enter"},
		{"kind":"screenshot","surface":"browser"}
	]'::jsonb) loop
		perform pg_temp.wake_assert(pg_temp.browser_effect('authorize',pg_temp.browser_envelope(v_args))->>'state'='authorized','closed browser verb admitted');
	end loop;
end
$$;
do $$
declare v_args jsonb;
begin
	for v_args in select value from jsonb_array_elements('[
		{"kind":"browser","action":"navigate","url":"file:///etc/passwd"},
		{"kind":"browser","action":"navigate","url":"https://member:password@example.test/"},
		{"kind":"browser","action":"snapshot","evaluate":"steal()"},
		{"kind":"browser","action":"fill","role":"textbox","name":"Email"},
		{"kind":"browser","action":"press","key":"Enter; command"},
		{"kind":"browser","action":"select_tab","tabId":null},
		{"kind":"screenshot","surface":"desktop"}
	]'::jsonb) loop
		perform pg_temp.wake_error(format('select pg_temp.browser_effect(''authorize'',%L)',pg_temp.browser_envelope(v_args)),'42501');
	end loop;
end
$$;
select set_config('qorpera_test.browser_receipt',extensions.gen_random_uuid()::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.browser_receipt')::uuid,'computer_browser:browser-effect',
	encode(extensions.digest(current_setting('qorpera_test.browser_envelope'),'sha256'),'hex'),repeat('e',64),false);
select pg_temp.wake_assert(pg_temp.browser_effect('begin')->>'state'='admitted','browser consumes real effect receipt');
select pg_temp.wake_error($q$select pg_temp.browser_effect('begin')$q$,'55000');
reset role;

-- Revocation rejects result release and fences the actual pending work.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.browser_revocation',pg_temp.browser_grant(false,1)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser_check()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.browser_effect('check')$q$,'42501');
select pg_temp.wake_assert(pg_temp.browser_effect('finish')->>'state'='drained','cleanup survives consent revocation');
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','receipt finish does not prove idle browser closure');
select pg_temp.ack_drains(current_setting('qorpera_test.browser_revocation')::jsonb->'drains');
reset role;

-- Owner departure revokes authority even if an old grant row remains active.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.browser_grant',pg_temp.browser_grant(true,2)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.browser_grant')::jsonb->'drains');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
-- Cancelling before the private surface was prepared cannot bless disk state.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(true,2)::text,true);
select set_config('qorpera_test.old_privacy',current_setting('qorpera_test.privacy'),true);
select set_config('qorpera_test.privacy',pg_temp.privacy_request(false,3)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.old_privacy')::jsonb)$q$,'42501');
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb);
reset role;
select pg_temp.wake_assert((select not prepared from public.qorpera_runtime_browser_profiles where id=current_setting('qorpera_test.browser_profile')::uuid),'cancelled entry is not profile preparation');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.browser_grant(true,4,3)$q$,'42501');
reset role;
-- Re-prepare and explicitly grant to test membership revocation independently.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(true,4)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
reset role;
select pg_temp.private_browser_visit(true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(false,5)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.browser_grant',pg_temp.browser_grant(true,4,4)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.browser_grant')::jsonb->'drains');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser_check()$q$,'42501');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["shell"]'::jsonb,'removed owner grants are unavailable');
reset role;
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000002','path-member@example.test','Returned member','contributor');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser_check()$q$,'42501');
select pg_temp.wake_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'capabilities'='["shell"]'::jsonb,'rejoining cannot revive old consent');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(true,6)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb);
reset role;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000002';
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000002','path-member@example.test','Returned member','contributor');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_assert(public.qorpera_runtime_office_privacy_status(current_setting('qorpera_test.office_scope')::jsonb)->'challenge'
	=current_setting('qorpera_test.privacy')::jsonb,'lost membership retains cleanup metadata only');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.privacy',pg_temp.privacy_request(false,7)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.ack_drains(current_setting('qorpera_test.privacy')::jsonb->'drains');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.privacy')::jsonb);
reset role;
select pg_temp.wake_assert((select count(*)=15 from public.qorpera_runtime_office_privacy_events),'privacy transitions retain metadata history');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_native_office_screen_v2(jsonb,jsonb,text,jsonb)','EXECUTE'),'no privacy bypass');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_ack_runtime_office_privacy_v1(jsonb)','EXECUTE'),'no private surface acknowledgement bypass');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_check_runtime_office_shared_surface(jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_check_runtime_office_shared_surface(jsonb)','EXECUTE'),'shared surface lifetime is broker only');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_check_runtime_office_private_surface(jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_check_runtime_office_private_surface(jsonb)','EXECUTE'),'private surface lifetime is broker only');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_request_runtime_office_drain_v1(jsonb,uuid,bigint,bigint,bigint,boolean)','EXECUTE'),'no takeover bypass');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_browser_profiles','SELECT,INSERT,UPDATE,DELETE'),'private profile registry');
select pg_temp.wake_assert(not has_table_privilege('authenticated','public.qorpera_runtime_office_privacy_events','SELECT,INSERT,UPDATE,DELETE'),'private sign-in history');
