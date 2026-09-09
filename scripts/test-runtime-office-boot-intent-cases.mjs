import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export function bootIntentRequest(request) {
	return {schema:'qorpera.office-boot-intent-request/v1',bootIntentId:request.bootIntentId,
		activationId:request.attestation.activationId,predecessor:request.predecessor,
		stopHistorySha256:request.stopHistorySha256,powerOffCompletionSha256:request.powerOffCompletionSha256};
}

// Real SQL/adapter, synthetic retained shutdown/history hashes. No VM starts.
export async function testOfficeBootIntent({request,stop,scope,service,owner,call,deny,literal,execute,race,session,until,restartDatabase,setEnabled,LxdOfficeBootIntentControl}) {
	const intent=bootIntentRequest(request),signal=new AbortController().signal;
	const prepare=(r=intent)=>`select public.qorpera_prepare_runtime_office_boot_intent(${literal(r)});`;
	const status=(r=intent)=>`select public.qorpera_runtime_office_boot_intent_status(${literal(r)});`;
	const check=(r=intent)=>`select public.qorpera_check_runtime_office_boot_intent(${literal(r)});`;
	await deny(`select public.qorpera_prepare_runtime_office_boot_successor(${literal(request)});`);
	for(const role of [owner,'set role anon;'])for(const sql of [prepare(),status(),check()])await deny(sql,role);
	for(const sql of ['select * from public.qorpera_runtime_office_boot_intents;',
		`select public.qorpera_assert_runtime_office_boot_intent_request(${literal(intent)});`,
		`select public.qorpera_runtime_office_boot_intent_result(null::public.qorpera_runtime_office_boot_intents);`,
		`select public.qorpera_check_runtime_office_boot_handoff(${literal(request)});`])await deny(sql);
	await deny(status());await deny(check());
	await deny(`begin; reset role; delete from public.qorpera_runtime_office_stops; ${service} ${prepare()}`);
	setEnabled(false);await deny(prepare());setEnabled(true);
	for(const change of [{schema:'old'},{bootId:randomUUID()},{activationId:intent.predecessor.activationId},{bootIntentId:null},
		{activationId:null},{predecessor:{...intent.predecessor,action:'service_restart'}},
		{predecessor:{...intent.predecessor,action:'replace'}},{predecessor:{...intent.predecessor,transitionId:randomUUID()}}])await deny(prepare({...intent,...change}));
	for(const key of ['stopHistorySha256','powerOffCompletionSha256'])for(const value of [null,1,'','A'.repeat(64)])await deny(prepare({...intent,[key]:value}));
	const mutations=["insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) select profile_id,'30000000-0000-4000-8000-000000000001'::uuid from public.qorpera_runtime_offices;",
		"update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;",
		"update public.qorpera_runtime_office_resources set state='draining',drained_at=null;",
		"update public.qorpera_runtime_office_viewers set state='draining',ended_at=null;",
		"update public.qorpera_runtime_machine_allocations set instance_sha256=repeat('9',64);"];
	for(const mutation of mutations)await deny(`begin; reset role; ${mutation} ${service} ${prepare()}`);
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_boot_intents;'),'0');
	// Deterministic contender order under the same authority lock used by SQL.
	const blocker=session();blocker.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices for update; select 'BOOT_INTENT_LOCKED';\n`);
	await until(()=>blocker.output().includes('BOOT_INTENT_LOCKED'));
	const first=session();first.child.stdin.end(`${service} set application_name='boot-intent-first'; ${prepare()}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='boot-intent-first' and wait_event_type='Lock';")==='1');
	const second=session();second.child.stdin.end(`${service} ${prepare({...intent,bootIntentId:randomUUID(),activationId:randomUUID()})}`);
	blocker.child.stdin.end('commit;');assert.equal((await blocker.done).code,0);
	const winner=await first.done;assert.equal(winner.code,0,winner.error);assert.notEqual((await second.done).code,0);
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_boot_intents;'),'1');
	let loseReply=true;const methods=[];
	const control=new LxdOfficeBootIntentControl(intent,{call:async(method,args,checked)=>{
		checked.throwIfAborted();methods.push(method);
		const sql=method==='qorpera_prepare_runtime_office_boot_intent'?prepare(args.p_request):
			method==='qorpera_runtime_office_boot_intent_status'?status(args.p_request):check(args.p_request);
		const value=call(sql);
		if(loseReply&&method==='qorpera_prepare_runtime_office_boot_intent'){loseReply=false;throw new Error('Lost committed intent reply');}
		return value;
	}});
	await assert.rejects(control.prepare(signal),/UNCONFIRMED/);
	await restartDatabase();
	const prepared=await control.status(signal);
	assert.equal(prepared.state,'prepared');assert.equal(prepared.stopAcknowledgedAtMs,stop.acknowledgement.acknowledgedAtMs);
	assert.deepEqual(prepared.request,intent);
	setEnabled(false);assert.deepEqual(await control.prepare(signal),prepared);assert.deepEqual(await control.status(signal),prepared);
	await assert.rejects(control.check(signal),/UNCONFIRMED/);setEnabled(true);
	for(const mutation of [...mutations,"update public.qorpera_runtime_offices set revision=revision+1;",
		"update public.qorpera_runtime_offices set privacy_version=privacy_version+1;",
		"update public.qorpera_runtime_offices set privacy_challenge='{}'::jsonb;"])
		await deny(`begin; reset role; ${mutation} ${service} ${check()}`);
	for(const change of [{bootIntentId:randomUUID()},{activationId:randomUUID()},{stopHistorySha256:'a'.repeat(64)},{powerOffCompletionSha256:'b'.repeat(64)},
		{predecessor:{...intent.predecessor,providerId:randomUUID()}}, {predecessor:{...intent.predecessor,action:'power_off'}}])
		for(const operation of [prepare,status,check])await deny(operation({...intent,...change}));
	// A pause committed while the check waits must fence VM dispatch.
	const pause=session();pause.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices for update; select 'BOOT_INTENT_PAUSE';\n`);
	await until(()=>pause.output().includes('BOOT_INTENT_PAUSE'));
	const waiting=session();waiting.child.stdin.end(`${service} set application_name='boot-intent-pause'; ${check()}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='boot-intent-pause' and wait_event_type='Lock';")==='1');
	pause.child.stdin.end(`insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001'); commit;`);
	assert.equal((await pause.done).code,0);const refused=await waiting.done;assert.notEqual(refused.code,0);assert.match(refused.error,/Office restart authority unavailable/);
	assert.deepEqual(await control.prepare(signal),prepared);assert.deepEqual(await control.status(signal),prepared);
	execute('delete from public.qorpera_company_execution_pauses;');
	const authority=await control.check(signal);assert.deepEqual(authority.intent,prepared);assert(authority.validForMs>0&&authority.validForMs<=5000);
	const exact=await race([`${service} ${prepare()}`,`${service} ${prepare()}`]);for(const result of exact)assert.equal(result.code,0,result.error);
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations;'),'1');
	assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
	console.log('PASS: explicit pre-boot intent selects one activation under concurrency, survives lost reply/database restart, keeps maintenance and refuses unknown/rebound intents, member access, stale privacy/drains/allocation and concurrent pause');
	return {intent,control,prepared,methods};
}
