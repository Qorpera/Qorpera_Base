-- Appended to the real wake-admission fixture in the disposable parity driver.
-- Storage helpers stand in for immutable object bytes. Responsibilities are
-- published and projected through real member commands and explicit review.
reset role;
create function pg_temp.escalation_put(p_path text,p_entry jsonb,p_document text default null)
returns jsonb language plpgsql as $$
declare v_saved text:=current_setting('request.jwt.claims'); v_version uuid; v_command jsonb; v_prepared jsonb; v_entries jsonb; v_result jsonb;
begin
	select version into v_version from public.qorpera_company_path_entries where environment_id='30000000-0000-4000-8000-000000000020' and path=p_path;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_command:=public.qorpera_begin_member_company_path_command('30000000-0000-4000-8000-000000000020',
		pg_temp.path_plan(extensions.gen_random_uuid()::text,p_path,p_entry,v_version));
	if v_command->>'state'='review_required' then
		perform public.qorpera_review_member_company_path_command((v_command->>'commandId')::uuid,v_command->>'planSha256','approve');
	end if;
	perform pg_temp.path_claims('service_role');
	v_prepared:=public.qorpera_prepare_member_company_path_command((v_command->>'commandId')::uuid,v_command->>'planSha256');
	select jsonb_agg(value order by value->>'path') into v_entries from (
		select value from jsonb_array_elements(v_prepared->'entries') where value->>'path'<>p_path union all select p_entry) entries;
	v_result:=public.qorpera_apply_member_company_path_command_v3((v_command->>'commandId')::uuid,v_command->>'planSha256',
		(v_prepared->>'snapshotId')::uuid,pg_temp.path_stage_tree(v_entries),p_document);
	-- Each real command normally commits before the next command changes the
	-- head. Check its deferred projection fence at that boundary in this fixture.
	set constraints all immediate;
	set constraints all deferred;
	perform set_config('request.jwt.claims',v_saved,true);
	return v_result;
end $$;
select pg_temp.path_claims('service_role');
select pg_temp.escalation_put('organization','{"path":"organization","kind":"directory"}');
select pg_temp.escalation_put('organization/responsibilities','{"path":"organization/responsibilities","kind":"directory"}');
select pg_temp.escalation_put('evidence.txt',pg_temp.path_stage_file('evidence.txt','The measured result misses the agreed target.'));

create function pg_temp.escalation_responsibility(p_id uuid,p_target jsonb,p_agent uuid default '30000000-0000-4000-8000-000000000030')
returns uuid language plpgsql as $$
declare v_document text; v_path text:='organization/responsibilities/'||p_id::text||'.json';
begin
	v_document:=jsonb_build_object('schema','qorpera.responsibility/v1','responsibilityId',p_id,'slug','r-'||p_id::text,
		'name','Delivery outcome','outcome','Meet the agreed delivery target.','accountableStaffAgentId',p_agent,
		'accountableUserId','30000000-0000-4000-8000-000000000002','attentionCadence','weekly',
		'escalationThreshold','{"targetMissed":true}'::jsonb,'escalationTarget',p_target,
		'effortPolicy','{}'::jsonb,'budgetPolicy','{}'::jsonb,'concurrencyPolicy','{}'::jsonb,'routineIds','[]'::jsonb,
		'listenerIds','[]'::jsonb,'externalOperationGrants','[]'::jsonb,'resources','[]'::jsonb,'status','active','version',1,
		'measures',jsonb_build_array(jsonb_build_object('measureId',extensions.gen_random_uuid(),'key','delivery','label','Delivery',
			'definition','The agreed delivery target.','direction','target','target','{"met":true}'::jsonb,'guardrails','[]'::jsonb,
			'cadence','weekly','status','active','sources','[{"path":"evidence.txt","pathMatch":"exact"}]'::jsonb)))::text;
	perform pg_temp.escalation_put(v_path,pg_temp.path_stage_file(v_path,v_document),v_document);
	return p_id;
end $$;
select pg_temp.escalation_responsibility('32000000-0000-4000-8000-000000000001','{"kind":"staff_agent","id":"30000000-0000-4000-8000-000000000031"}');
select pg_temp.escalation_responsibility('32000000-0000-4000-8000-000000000002','{"kind":"accountable_member","id":null}');
select pg_temp.escalation_responsibility('32000000-0000-4000-8000-000000000003','{"kind":"staff_agent","id":"30000000-0000-4000-8000-000000000030"}');
set constraints all immediate;
set constraints all deferred;

select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','escalation-ack');
select set_config('qorpera_test.escalation_read',public.qorpera_read_company_path_v2('30000000-0000-4000-8000-000000000020',
	'evidence.txt',0,4096,current_setting('qorpera_test.wake_binding')::jsonb)::text,true);
select public.qorpera_confirm_company_path_read('30000000-0000-4000-8000-000000000020',current_setting('qorpera_test.wake_binding')::jsonb,
	(current_setting('qorpera_test.escalation_read')::jsonb->>'readObservationId')::uuid,44,repeat('b',64));
create function pg_temp.escalation_signal(p_key text,p_responsibility uuid default '32000000-0000-4000-8000-000000000001')
returns jsonb language sql as $$
	select jsonb_build_object('operationKey',p_key,'responsibilityId',p_responsibility,'responsibilityVersion',1,
		'kind','exception','summary','The target was missed.','recommendation','Review the evidence and choose corrective work.',
		'evidenceReadIds',jsonb_build_array(current_setting('qorpera_test.escalation_read')::jsonb->>'readObservationId'))
$$;
-- END RESPONSIBILITY ROUTING FIXTURE
set local role service_role;
select set_config('qorpera_test.escalation_first',public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('signal-1'))::text,true);
select pg_temp.wake_assert(public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('signal-1'))=current_setting('qorpera_test.escalation_first')::jsonb,'Exact replay changed its receipt');
select pg_temp.wake_assert(public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('signal-2')||'{"summary":"Additional evidence confirms the target miss."}'::jsonb)->>'status'='coalesced','Repeated category did not coalesce');
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('signal-1')||'{"summary":"Different work under an old key."}'::jsonb)$q$,'23505');
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('stale')||'{"responsibilityVersion":2}'::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('forged')||'{"evidenceReadIds":["32000000-0000-4000-8000-000000000099"]}'::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('recipient-injection')||'{"recipientStaffId":"30000000-0000-4000-8000-000000000032"}'::jsonb)$q$,'22023');
select pg_temp.wake_assert(public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('self','32000000-0000-4000-8000-000000000003'))->>'status'='causal-fence','Self escalation created a loop');
select set_config('qorpera_test.escalation_member',public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('member','32000000-0000-4000-8000-000000000002'))::text,true);
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences where wake_kind='agent'),'Coalescing or member route created extra wakes');
select pg_temp.wake_assert((select count(*)=4 from public.qorpera_responsibility_escalation_signals),'Replay duplicated or coalescing lost evidence');
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_run_operation_receipts where status in ('executing','ambiguous')),'Routing left an uncertain operation');

savepoint escalation_cofounder;
-- Reuse the initialized Bob staff fixture through the real one-Co-Founder
-- seed function; its existing model and sponsor authority remain in force.
update public.qorpera_profile_staff set template_id='co-founder' where staff_agent_id='30000000-0000-4000-8000-000000000031';
select public.qorpera_seed_company_cofounder('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001');
select pg_temp.escalation_responsibility('32000000-0000-4000-8000-000000000004','{"kind":"cofounder","id":null}');
set local role service_role;
select set_config('qorpera_test.escalation_cf',public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('cofounder','32000000-0000-4000-8000-000000000004'))::text,true);
reset role;
select pg_temp.wake_assert(exists(select 1 from public.qorpera_responsibility_escalations q
	join public.qorpera_company_cofounders c on c.profile_id=q.profile_id and c.staff_agent_id=q.target_staff_id
	join public.qorpera_wake_occurrences w on w.id=q.occurrence_id and w.staff_agent_id=c.staff_agent_id
	where q.id=(current_setting('qorpera_test.escalation_cf')::jsonb->>'escalationId')::uuid and w.wake_kind='agent'),
	'Co-Founder routing did not use the recorded Co-Founder and agent wake');
rollback to escalation_cofounder;

savepoint escalation_stale_evidence;
select pg_temp.escalation_put('evidence.txt',pg_temp.path_stage_file('evidence.txt','A newer result needs a new confirmed read.'));
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('stale-evidence'))$q$,'42501');
rollback to escalation_stale_evidence;

savepoint escalation_wrong_accountable;
select pg_temp.escalation_responsibility('32000000-0000-4000-8000-000000000005',
	'{"kind":"accountable_member","id":null}','30000000-0000-4000-8000-000000000031');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('wrong-accountable','32000000-0000-4000-8000-000000000005'))$q$,'42501');
rollback to escalation_wrong_accountable;

savepoint escalation_scoped_authority;
-- Exercise current scope projection grants independently of the already
-- covered document publisher. No authority function is replaced.
insert into public.qorpera_company_path_resources(id,environment_id,path,path_match,scope,policy,created_by_user_id)
values('32000000-0000-4000-8000-000000000080','30000000-0000-4000-8000-000000000020','evidence.txt','exact',
	'responsibility_scoped','normal','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_responsibility_path_resources(resource_id,profile_id,responsibility_id,member_permissions,staff_permissions,source_path_version,created_by_user_id)
select '32000000-0000-4000-8000-000000000080',profile_id,id,array['read'],array['read'],source_path_version,created_by_user_id
from public.qorpera_company_responsibilities where id='32000000-0000-4000-8000-000000000001';
select pg_temp.wake_assert(public.qorpera_wake_path_authorized('30000000-0000-4000-8000-000000000020',
	'30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000030','evidence.txt'),'Scoped accountable read was rejected');
select pg_temp.wake_assert(not public.qorpera_wake_path_authorized('30000000-0000-4000-8000-000000000020',
	'30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000031','evidence.txt'),'Scoped evidence leaked without delegation');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('scoped-denied'))$q$,'42501');
reset role;
insert into public.qorpera_agent_responsibility_grants(profile_id,staff_agent_id,responsibility_id,source_path_version)
select profile_id,'30000000-0000-4000-8000-000000000031',id,source_path_version
from public.qorpera_company_responsibilities where id='32000000-0000-4000-8000-000000000001';
select pg_temp.wake_assert(public.qorpera_wake_path_authorized('30000000-0000-4000-8000-000000000020',
	'30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000031','evidence.txt'),'Current scoped delegation was ignored');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,
	pg_temp.escalation_signal('scoped-allowed'))->>'status'='coalesced','Scoped authorized signal did not join its queue');
rollback to escalation_scoped_authority;

-- Recipient reads use a second real admitted native run, not a forged binding.
select public.qorpera_materialize_wake_execution_runs(32);
select set_config('qorpera_test.escalation_recipient',pg_temp.wake_start((select run_id from public.qorpera_wake_occurrences
	where id=(select occurrence_id from public.qorpera_responsibility_escalations
		where id=(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid)))::text,true);
set local role service_role;
select set_config('qorpera_test.escalation_page',public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.escalation_recipient')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid)::text,true);
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.escalation_page')::jsonb->'items')=2,'Recipient lost a coalesced contribution');
select pg_temp.wake_error($q$select public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.wake_binding')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid)$q$,'42501');
reset role;
select pg_temp.wake_assert(exists(select 1 from public.qorpera_company_run_read_paths
	where run_id=(current_setting('qorpera_test.escalation_recipient')::jsonb->>'runId')::uuid and path='evidence.txt'),'Recipient lost inherited data-flow provenance');

-- A removed grant denies subsequent queue reads. Restore only by rolling the
-- disposable subtransaction back; production authority functions are unchanged.
savepoint escalation_revoked;
update public.qorpera_company_path_grants set revoked_at=clock_timestamp() where principal_id='30000000-0000-4000-8000-000000000031';
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.escalation_recipient')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid)$q$,'42501');
rollback to escalation_revoked;
savepoint escalation_late_contribution;
set local role service_role;
select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,pg_temp.escalation_signal('late-evidence'));
select pg_temp.wake_error($q$select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.escalation_recipient')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid,
	'Reviewed stale contributions.',2)$q$,'40001');
select pg_temp.wake_error($q$select public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.escalation_recipient')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid,
	(current_setting('qorpera_test.escalation_page')::jsonb#>>'{items,0,id}')::uuid,1,2)$q$,'40001');
reset role;
select pg_temp.wake_assert((select status='open' from public.qorpera_responsibility_escalations
	where id=(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid),'Unreviewed late evidence was closed');
rollback to escalation_late_contribution;
set local role service_role;
select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',current_setting('qorpera_test.escalation_recipient')::jsonb,
	(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid,'Reviewed; corrective work requires separate authority.',2);
select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',current_setting('qorpera_test.escalation_recipient')::jsonb,
	(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid,'Reviewed; corrective work requires separate authority.',2);
select pg_temp.wake_error($q$select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.escalation_recipient')::jsonb,(current_setting('qorpera_test.escalation_first')::jsonb->>'escalationId')::uuid,'Different resolution.',2)$q$,'23505');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020')->'items')=1,'Accountable member queue is unavailable');
select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',null,
	(current_setting('qorpera_test.escalation_member')::jsonb->>'escalationId')::uuid,'Decision recorded by its addressed member.',1);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_list_responsibility_escalations('30000000-0000-4000-8000-000000000020',null,
	(current_setting('qorpera_test.escalation_member')::jsonb->>'escalationId')::uuid)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_escalate_responsibility(current_setting('qorpera_test.wake_binding')::jsonb,pg_temp.escalation_signal('human-cannot-impersonate'))$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
savepoint escalation_member_downgrade;
update public.qorpera_profile_members set role='viewer' where user_id='30000000-0000-4000-8000-000000000002';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_resolve_responsibility_escalation('30000000-0000-4000-8000-000000000020',null,
	(current_setting('qorpera_test.escalation_member')::jsonb->>'escalationId')::uuid,'Decision recorded by its addressed member.',1)$q$,'42501');
rollback to escalation_member_downgrade;
set constraints all immediate;
select 'PASS: real projected responsibility -> confirmed evidence -> one agent wake and coalesced queue -> authorized native/member resolution, replay and revocation fences';
