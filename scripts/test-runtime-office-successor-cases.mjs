import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bootIntentRequest,testOfficeBootIntent} from './test-runtime-office-boot-intent-cases.mjs';

// Real database, migrations, concurrent transactions and runtime/provider
// adapters. Physical stop/start/inspection evidence is synthetic in this test.
export async function testOfficeSuccessorAdmission({stop,attestation,scope,service,owner,race,session,until,literal,execute,restartDatabase,prepareWake,CompanyComputerStartupControl,LxdOfficeSuccessorControl,LxdOfficeBootIntentControl,boot=false}) {
	const predecessor=stop.request.revocation.request;
	const freshHash=()=>randomUUID().replaceAll('-','').repeat(2);
	const freshAttestation=()=>({...attestation,activationId:randomUUID(),...(boot?{bootId:randomUUID(),configurationObservationSha256:freshHash(),configurationSha256:freshHash(),adoptionReceiptSha256:freshHash()}:{})});
	const freshHistory=()=>boot?{bootIntentId:randomUUID(),stopHistorySha256:freshHash(),powerOffCompletionSha256:freshHash(),bootObservationSha256:freshHash()}:{};
	const request={schema:boot?'qorpera.office-boot-successor-request/v1':'qorpera.office-service-successor-request/v1',predecessor,attestation:freshAttestation(),...freshHistory()};
	const prefix=boot?'boot_':'';
	const rpc={prepare:'qorpera_prepare_runtime_office_'+prefix+'successor',status:'qorpera_runtime_office_'+prefix+'successor_status',check:'qorpera_check_runtime_office_'+prefix+'successor',activate:'qorpera_activate_runtime_office_'+prefix+'successor',assert:'qorpera_assert_runtime_office_'+prefix+'successor_request',result:'qorpera_runtime_office_'+prefix+'successor_result'};
	const prepare=(r=request)=>`select public.${rpc.prepare}(${literal(r)});`;
	const status=(r=request)=>`select public.${rpc.status}(${literal(r)});`;
	const authority=(r=request)=>`select public.${rpc.check}(${literal(r)});`;
	const activate=(invocation,r=request)=>`select public.${rpc.activate}(${literal(r)},'${invocation}');`;
	const check=s=>`select public.qorpera_check_runtime_office_startup(${literal(s)});`;
	const ready=(s,id=request.attestation.activationId)=>`select public.qorpera_report_runtime_office_ready(${literal(s)},'${id}',9443,9444);`;
	const call=(sql,role=service)=>JSON.parse(execute(`${role} ${sql}`).split('\n').at(-1));
	const deny=async(sql,role=service)=>{const [r]=await race([`${role} ${sql}`]);assert.notEqual(r.code,0,'Unexpected successor admission');assert.doesNotMatch(r.error,/does not exist|violates check constraint|syntax error/);return r;};
	const protectedState=()=>execute(`select jsonb_build_object('privacyState',privacy_state,'privacyVersion',privacy_version,'privacyChallenge',privacy_challenge,
		'screens',(select jsonb_agg(s order by s.ordinal) from public.qorpera_runtime_office_screens s),
		'allocations',(select jsonb_agg(a) from public.qorpera_runtime_machine_allocations a),
		'resources',(select jsonb_agg(r) from public.qorpera_runtime_office_resources r),
		'viewers',(select jsonb_agg(v) from public.qorpera_runtime_office_viewers v)) from public.qorpera_runtime_offices;`);
	const history=()=>call(`select jsonb_agg(a order by a.activation_id) from public.qorpera_runtime_office_activations a;`,'');
	const preserved=protectedState(),original=history()[0];
	assert.equal(JSON.parse(preserved).privacyState,'private');
	for(const sql of [prepare(),status(),authority(),activate('c'.repeat(32))])await deny(sql,owner);
	for(const sql of ['select * from public.qorpera_runtime_office_successors;',
		`select public.${rpc.assert}(${literal(request)});`,
		`select public.qorpera_check_runtime_office_restart_surfaces(null::public.qorpera_runtime_office_activations);`,
		`select public.qorpera_check_runtime_office_successor_startup(null::public.qorpera_runtime_office_activations);`,
		`select public.${rpc.result}(null::public.qorpera_runtime_office_activations);`])await deny(sql);
	await deny(prepare()); // Provider disabled, founder paused by stop fixture.
	const enable=enabled=>`select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${predecessor.providerId}','${predecessor.providerPolicySha256}',
		(select version from public.qorpera_runtime_office_providers),${enabled});`;
	// Read the private provider version as fixture administrator, then use the
	// real provider RPC. Service role cannot read the underlying table.
	const setEnabled=enabled=>{
		const version=execute('select version from public.qorpera_runtime_office_providers;');
		return call(enable(enabled).replace('(select version from public.qorpera_runtime_office_providers)',version));
	};
	setEnabled(true);await deny(prepare());
	execute('delete from public.qorpera_company_execution_pauses;');
	await prepareWake();
	assert.equal(execute('select state from public.qorpera_runtime_office_start_waiters;'),'waiting');
	await deny(`begin; reset role; delete from public.qorpera_runtime_office_stops; ${service} ${prepare()}`);
	const bootIntent=boot?await testOfficeBootIntent({request,stop,scope,service,owner,call,deny,literal,execute,race,session,until,restartDatabase,setEnabled,LxdOfficeBootIntentControl}):undefined;
	for(const change of [{schema:'old'},{extra:true},{attestation:{...request.attestation,activationId:predecessor.activationId}},
		{attestation:{...request.attestation,bootId:boot?predecessor.startup.bootId:randomUUID()}},{attestation:{...request.attestation,configurationSha256:boot?attestation.configurationSha256:'9'.repeat(64)}},
		{attestation:{...request.attestation,adoptionReceiptSha256:boot?attestation.adoptionReceiptSha256:'9'.repeat(64)}},{attestation:{...request.attestation,nativePort:9445}},
		{predecessor:{...predecessor,transitionId:randomUUID()}},{predecessor:{...predecessor,action:boot?'service_restart':'reboot'}}])await deny(prepare({...request,...change}));
	if(boot){
		for(const key of ['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'])for(const value of [null,1,'', 'x'.repeat(64)])await deny(prepare({...request,[key]:value}));
		assert.match((await deny(prepare({...request,attestation:{...request.attestation,preparationObservationSha256:freshHash()}}))).error,/Office boot preparation identity changed/);
		assert.match((await deny(prepare({...request,attestation:{...request.attestation,configurationObservationSha256:attestation.configurationObservationSha256}}))).error,/Office boot requires fresh protected observations/);
		await deny(`select public.qorpera_prepare_runtime_office_successor(${literal(request)});`);
		for(const change of [{bootIntentId:randomUUID()},{bootIntentId:null},{stopHistorySha256:freshHash()},{powerOffCompletionSha256:freshHash()},
			{attestation:{...request.attestation,activationId:randomUUID()}}])await deny(prepare({...request,...change}));
		for(const mutation of ["update public.qorpera_runtime_offices set revision=revision+1;", "update public.qorpera_runtime_offices set privacy_version=privacy_version+1;"])
			await deny(`begin; reset role; ${mutation} ${service} ${prepare()}`);
	}
	for(const mutation of ["update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;",
		"update public.qorpera_runtime_office_resources set state='draining',drained_at=null;",
		"update public.qorpera_runtime_office_viewers set state='draining',ended_at=null;"])
		await deny(`begin; reset role; ${mutation} ${service} ${prepare()}`);
	assert.deepEqual(history(),[original]);assert.equal(protectedState(),preserved);
	console.log('PASS: successor preparation requires acknowledged stop, enabled provider, unpaused company and fully drained surfaces; member/helper access and changed identities are refused');

	let losePrepare=true,loseActivate=true;const methods=[];
	const control=new LxdOfficeSuccessorControl(request,{call:async(method,args,signal)=>{
		signal.throwIfAborted();methods.push(method);
		const sql=method===rpc.prepare?prepare(args.p_request):method===rpc.status?status(args.p_request):method===rpc.check?authority(args.p_request):activate(args.p_service_invocation_id,args.p_request);
		const result=call(sql);
		if(method===rpc.prepare&&losePrepare){losePrepare=false;throw new Error('Lost committed preparation reply');}
		if(method===rpc.activate&&loseActivate){loseActivate=false;throw new Error('Lost committed activation reply');}
		return result;
	}});
	const signal=new AbortController().signal;
	// Serialize contender at the same office lock; the accepted request may
	// recover after reply loss, while a distinct activation cannot replace it.
	const blocker=session();blocker.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices for update; select 'SUCCESSOR_LOCKED';\n`);
	await until(()=>blocker.output().includes('SUCCESSOR_LOCKED'));
	const contenders=[request,{...request,attestation:{...request.attestation,activationId:randomUUID()}}].map(r=>`${service} ${prepare(r)}`);
	const first=session();first.child.stdin.end(`set application_name='successor-first'; ${contenders[0]}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='successor-first' and wait_event_type='Lock';")==='1');
	const second=session();second.child.stdin.end(contenders[1]);blocker.child.stdin.end('commit;');
	assert.equal((await blocker.done).code,0);const winner=await first.done;assert.equal(winner.code,0,winner.error);assert.notEqual((await second.done).code,0);
	await assert.rejects(control.prepare(signal),/UNCONFIRMED/);
	const prepared=await control.status(signal);assert.equal(prepared.state,'prepared');assert.equal(prepared.serviceInvocationId,null);assert.equal(prepared.readinessFresh,false);
	assert.equal(prepared.stopAcknowledgedAtMs,stop.acknowledgement.acknowledgedAtMs);
	if(bootIntent){
		assert.equal((await bootIntent.control.status(signal)).state,'admitted');
		assert.equal((await bootIntent.control.prepare(signal)).state,'admitted');
		await assert.rejects(bootIntent.control.check(signal),/UNCONFIRMED/);
	}
	setEnabled(false);assert.deepEqual(await control.prepare(signal),prepared);assert.deepEqual(await control.status(signal),prepared);
	await assert.rejects(control.check(signal),/UNCONFIRMED/);setEnabled(true);
	assert.deepEqual((await control.check(signal)).successor,prepared);
	if(boot)for(const key of ['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'])for(const operation of [prepare,status,authority])await deny(operation({...request,[key]:freshHash()}));
	for(const mutation of ["update public.qorpera_runtime_offices set privacy_version=privacy_version+1;",
		"update public.qorpera_runtime_offices set revision=revision+1;",
		"update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;",
		"insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) select profile_id,'30000000-0000-4000-8000-000000000001'::uuid from public.qorpera_runtime_offices;"])
		await deny(`begin; reset role; ${mutation} ${service} ${authority()}`);
	const authorityPause=session();authorityPause.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices for update; select 'SUCCESSOR_AUTHORITY_LOCK';\n`);
	await until(()=>authorityPause.output().includes('SUCCESSOR_AUTHORITY_LOCK'));
	const authorityWait=session();authorityWait.child.stdin.end(`${service} set application_name='successor-authority-race'; ${authority()}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='successor-authority-race' and wait_event_type='Lock';")==='1');
	authorityPause.child.stdin.end(`insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001'); commit;`);
	assert.equal((await authorityPause.done).code,0);const authorityRefused=await authorityWait.done;
	assert.notEqual(authorityRefused.code,0);assert.match(authorityRefused.error,/Office restart authority unavailable/);
	execute('delete from public.qorpera_company_execution_pauses;');
	assert.deepEqual((await control.check(signal)).successor,prepared);
	console.log('PASS: fresh successor authority refuses disabled preparation, concurrent founder pause and changed privacy/drains while metadata recovery remains available');
	assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;'),'1');
	assert.equal(history().length,2);const old=history().find(a=>a.activation_id===original.activation_id);assert(old.superseded_at);assert.deepEqual({...old,superseded_at:null},original);
	assert.equal(protectedState(),preserved);
	await deny(check(predecessor.startup));await deny(ready(predecessor.startup,predecessor.activationId));
	await deny(`select public.qorpera_begin_runtime_office_lifecycle(${literal(predecessor)});`);
	await deny(`select public.qorpera_ack_runtime_office_stop(${literal(predecessor)},${literal(stop.acknowledgement.inspection)});`);
	call('select public.qorpera_materialize_wake_execution_runs(32);');
	assert.equal(execute("select count(*) from public.qorpera_wake_occurrences where source_kind='office-activation';"),'0');
	assert.equal(execute('select state from public.qorpera_runtime_office_start_waiters;'),'waiting');
	console.log('PASS: competing requests select one current activation; committed preparation reply loss recovers without changing historical activation, private state or capacity');

	const startup={...predecessor.startup,bootId:request.attestation.bootId,configurationSha256:request.attestation.configurationSha256,serviceInvocationId:'c'.repeat(32)};
	if(boot){for(const key of ['bootId','configurationSha256']){await deny(check({...startup,[key]:predecessor.startup[key]}));await deny(ready({...startup,[key]:predecessor.startup[key]}));}}
	for(const mutation of ["update public.qorpera_runtime_offices set privacy_version=privacy_version+1;",
		"update public.qorpera_runtime_offices set privacy_challenge='{}'::jsonb;",
		"update public.qorpera_runtime_offices set revision=revision+1;",
		"update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;"])
		await deny(`begin; reset role; ${mutation} ${service} ${ready(startup)}`);
	assert.equal(call(check(startup)).state,'prepared');
	const invocations=['c'.repeat(32),'d'.repeat(32)];
	const competing=await race(invocations.map(serviceInvocationId=>`${service} ${ready({...startup,serviceInvocationId})}`));
	assert.equal(competing.filter(r=>r.code===0).length,1);startup.serviceInvocationId=invocations[competing.findIndex(r=>r.code===0)];
	assert.equal((await control.status(signal)).serviceInvocationId,startup.serviceInvocationId);
	execute(`update public.qorpera_runtime_office_activations set ready_at=clock_timestamp()-interval '6 seconds' where superseded_at is null;`);
	await deny(activate(startup.serviceInvocationId));
	assert.equal((await control.status(signal)).readinessFresh,false);
	const pause=session();pause.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices for update; select 'SUCCESSOR_PAUSE_LOCK';\n`);
	await until(()=>pause.output().includes('SUCCESSOR_PAUSE_LOCK'));
	const waiting=session();waiting.child.stdin.end(`${service} set application_name='successor-pause-race'; ${ready(startup)}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='successor-pause-race' and wait_event_type='Lock';")==='1');
	pause.child.stdin.end(`insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001'); commit;`);
	assert.equal((await pause.done).code,0);const refused=await waiting.done;assert.notEqual(refused.code,0);assert.match(refused.error,/Office restart authority unavailable/);
	execute('delete from public.qorpera_company_execution_pauses;');
	call(ready(startup));
	for(const mutation of ["update public.qorpera_runtime_offices set privacy_version=privacy_version+1;","update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;",
		"update public.qorpera_runtime_office_providers set preparation_enabled=false;"])
		await deny(`begin; reset role; ${mutation} ${service} ${activate(startup.serviceInvocationId)}`);
	assert.equal(protectedState(),preserved);
	console.log('PASS: distinct readiness has one pinned invocation; expiry, concurrent founder pause and changed privacy/drain snapshots fence readiness and activation without clearing state');

	let reports=0,physical=0;
	const runtime=new CompanyComputerStartupControl(startup,{call:async(method,args,checked)=>{
		checked.throwIfAborted();assert.deepEqual(args.p_startup,startup);
		if(method==='qorpera_check_runtime_office_startup')return call(check(startup));
		assert.equal(method,'qorpera_report_runtime_office_ready');assert.equal(args.p_activation_id,request.attestation.activationId);
		const result=call(ready(startup));
		if(++reports===1){
			assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
			await assert.rejects(control.activate(startup.serviceInvocationId,performance.now()+5000,checked),/UNCONFIRMED/);
		}
		return result;
	}});
	assert.equal((await runtime.check(signal)).state,'ready');
	await runtime.waitForActivation({nativePort:9443,viewerPort:9444},async()=>{physical++;},signal);
	assert.equal(reports,2);assert.equal(physical,2);
	const active=await control.status(signal);assert.equal(active.state,'active');
	setEnabled(false);assert.equal((await control.check(signal)).successor.state,'active');setEnabled(true);
	await restartDatabase();const recovered=await control.status(signal);assert.equal(recovered.state,'active');assert.equal(recovered.serviceInvocationId,startup.serviceInvocationId);
	assert.equal((await control.prepare(signal)).state,'active');
	await deny(check(predecessor.startup));await deny(ready(predecessor.startup,predecessor.activationId));
	assert.equal(protectedState(),preserved);assert.equal(execute('select state from public.qorpera_runtime_offices;'),'active');
	assert.equal(methods.filter(m=>m===rpc.activate).length,1);
	console.log('PASS: real headless startup and provider successor adapters activate one new invocation; lost activation reply and database restart recover metadata, preserving privacy/grants and retained machine allocation');
	const materialized=await race([`${service} select public.qorpera_materialize_wake_execution_runs(32);`,`${service} select public.qorpera_materialize_wake_execution_runs(32);`]);
	for(const result of materialized)assert.equal(result.code,0,result.error);
	const wake=call("select row_to_json(w) from public.qorpera_wake_occurrences w where source_kind='office-activation';",'');
	assert.equal(wake.payload.activationId,request.attestation.activationId);
	assert.equal(execute(`select public.qorpera_run_wake_authorized('${wake.run_id}');`),'t');

	// A second stop on the same VM/generation must retain both prior receipts.
	const nextRequest={...predecessor,action:boot?'power_off':predecessor.action,activationId:request.attestation.activationId,transitionId:randomUUID(),startup};
	const transition=call(`select public.qorpera_begin_runtime_office_lifecycle(${literal(nextRequest)});`);
	assert.equal(execute(`select public.qorpera_run_wake_authorized('${wake.run_id}');`),'f');
	assert.equal(transition.state,'draining');assert.equal(execute('select count(*) from public.qorpera_runtime_office_lifecycle_transitions;'),'2');
	await deny(authority());
	const command={...stop.command,bootId:startup.bootId,commandId:randomUUID(),requestSha256:'6'.repeat(64)},nonce=randomUUID();
	call(`select public.qorpera_prepare_runtime_office_stop(${literal(nextRequest)},${literal(command)},'${nonce}','${stop.request.startCompletionSha256}');`);
	const inspection={...stop.acknowledgement.inspection,inspectionId:nonce,stop:{...stop.acknowledgement.inspection.stop,
		command,transitionId:nextRequest.transitionId,activationId:nextRequest.activationId,revocationRevision:transition.revocationRevision,
		configurationSha256:startup.configurationSha256,fromServiceInvocationId:startup.serviceInvocationId,observedInvocationId:startup.serviceInvocationId,stoppedInvocationId:startup.serviceInvocationId}};
	call(`select public.qorpera_ack_runtime_office_stop(${literal(nextRequest)},${literal(inspection)});`);
	const third={...request,predecessor:nextRequest,attestation:freshAttestation(),...freshHistory()};
	if(boot){
		const thirdIntent=bootIntentRequest(third);
		await deny(prepare(third)); // Explicit power-off never implicitly resumes.
		for(const key of ['stopHistorySha256','powerOffCompletionSha256'])await deny(`select public.qorpera_prepare_runtime_office_boot_intent(${literal({...thirdIntent,[key]:request[key]})});`);
		await deny(`select public.qorpera_prepare_runtime_office_boot_intent(${literal({...thirdIntent,activationId:predecessor.activationId})});`);
		assert.equal(call(`select public.qorpera_prepare_runtime_office_boot_intent(${literal(thirdIntent)});`).state,'prepared');
		assert.equal(call(`select public.qorpera_check_runtime_office_boot_intent(${literal(thirdIntent)});`).state,'prepared');
		await deny(prepare({...third,attestation:{...third.attestation,bootId:predecessor.startup.bootId}}));
		for(const key of ['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'])await deny(prepare({...third,[key]:request[key]}));
	}
	assert.equal(call(prepare(third)).state,'prepared');
	await deny(ready(predecessor.startup,third.attestation.activationId));await deny(ready(startup,third.attestation.activationId));
	assert.equal(call(ready({...startup,bootId:third.attestation.bootId,configurationSha256:third.attestation.configurationSha256,serviceInvocationId:'e'.repeat(32)},third.attestation.activationId)).state,'ready');
	assert.equal(call(activate('e'.repeat(32),third)).state,'active');
	if(bootIntent){
		await assert.rejects(bootIntent.control.check(signal),/UNCONFIRMED/);
		assert.equal((await bootIntent.control.status(signal)).state,'admitted');
		assert.equal(execute('select count(*) from public.qorpera_runtime_office_boot_intents;'),'2');
		console.log('PASS: observed boot admission requires the exact pre-boot intent and snapshot; handoff permanently fences prior VM-start authority, and resuming power-off needs a second explicit intent');
	}
	await deny(status());await deny(prepare());await deny(authority());
	assert.equal(history().length,3);assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;'),'1');
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_stops;'),'2');
	assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
	assert.equal(JSON.parse(protectedState()).privacyState,'private');
	call('select public.qorpera_materialize_wake_execution_runs(32);');
	assert.equal(execute("select count(*) from public.qorpera_wake_occurrences where source_kind='office-activation';"),'1');
	assert.deepEqual(call('select public.qorpera_office_activation_wake_payload(w) from public.qorpera_runtime_office_start_waiters w;',''),wake.payload);
	assert.equal(execute(`select public.qorpera_run_wake_authorized('${wake.run_id}');`),'t');
	assert.equal(new Set(history().map(a=>a.attestation.bootId)).size,boot?3:1);
	console.log(boot?'PASS: reboot and explicit resume after power-off retain three distinct boots/activations and two stop receipts, reject historical boot/proof reuse and keep one charged allocation':'PASS: repeated service restarts retain three activation identities and two stop receipts, refuse all historical invocation reuse and keep one current invocation on the original allocation');
	console.log('PASS: a real completed parent wakes once on successor activation; the delivered continuation retains its original activation provenance and uses current authority across another service restart');
}
