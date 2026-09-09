import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Real SQL and adapter, synthetic protected root measurements. The separate
 * systemd fixture proves physical cleanup; this test cannot claim that join. */
export async function testOfficeStopAcknowledgement({request,revocation,lease,scope,service,owner,race,session,until,literal,execute,restartDatabase,LxdOfficeStopControl,screenLifetimeId}) {
	const command={commandId:randomUUID(),requestSha256:'9'.repeat(64),bootId:request.startup.bootId},startCompletionSha256='8'.repeat(64);
	const stopRequest={schema:'qorpera.office-service-stop-request/v1',revocation,startCompletionSha256};
	const prepare=(nonce,cmd=command,req=request,hash=startCompletionSha256)=>`select public.qorpera_prepare_runtime_office_stop(${literal(req)},${literal(cmd)},'${nonce}','${hash}');`;
	const ack=value=>`select public.qorpera_ack_runtime_office_stop(${literal(request)},${literal(value)});`;
	const status=`select public.qorpera_runtime_office_stop_status(${literal(request)});`;
	const call=(sql,role=service)=>{const output=execute(`${role} ${sql}`).split('\n').at(-1);return output?JSON.parse(output):null;};
	const deny=async(sql,role=service)=>{const [result]=await race([`${role} ${sql}`]);assert.notEqual(result.code,0,'Unexpected physical acknowledgement');return result;};
	const inspection=nonce=>({schema:'qorpera.office-service-stop-inspection/v1',inspectionId:nonce,cgroupState:'absent',stop:{
		schema:'qorpera.office-service-stop-completion/v1',command,transitionId:request.transitionId,activationId:request.activationId,
		revocationRevision:revocation.revocationRevision,configurationSha256:request.startup.configurationSha256,
		startCompletionSha256,fromServiceInvocationId:request.startup.serviceInvocationId,
		observedInvocationId:'a'.repeat(32),stoppedInvocationId:null,controlGroup:'/system.slice/qorpera-company-computer.service',cgroupState:'absent'}});
	const state=()=>execute(`select jsonb_build_object('office',to_jsonb(o),'screens',(select jsonb_agg(s order by s.ordinal) from public.qorpera_runtime_office_screens s),
		'resources',(select jsonb_agg(r) from public.qorpera_runtime_office_resources r),'viewers',(select jsonb_agg(v) from public.qorpera_runtime_office_viewers v),
		'allocations',(select jsonb_agg(a) from public.qorpera_runtime_machine_allocations a),'stops',(select jsonb_agg(s) from public.qorpera_runtime_office_stops s)) from public.qorpera_runtime_offices o;`);
	assert.equal(call(status),null);await deny(status,owner);await deny(prepare(randomUUID()),owner);await deny(ack(inspection(randomUUID())),owner);
	for(const table of ['qorpera_runtime_office_stops','qorpera_runtime_office_stop_challenges'])await deny(`select * from public.${table};`);
	await deny(`select public.qorpera_lock_runtime_office_stop(${literal(request)});`);
	for(const sql of [prepare(randomUUID(),{...command,bootId:randomUUID()}),prepare(command.commandId),prepare(randomUUID(),{...command,extra:true}),
		prepare(randomUUID(),command,{...request,activationId:randomUUID()}),prepare(randomUUID(),command,request,'bad')])await deny(sql);
	const nonce=randomUUID(),challenge=call(prepare(nonce));assert.equal(challenge.drains.length,0);
	assert(challenge.validForMs>0&&challenge.validForMs<=5000);assert(call(prepare(nonce)).validForMs<=challenge.validForMs);
	await deny(prepare(randomUUID(),{...command,commandId:randomUUID()}));await deny(prepare(randomUUID(),command,request,'7'.repeat(64)));
	const before=state();
	for(const change of [{schema:'old'},{extra:true},{inspectionId:randomUUID()},{cgroupState:'populated'},{stop:null}])await deny(ack({...inspection(nonce),...change}));
	for(const change of [{extra:true},{command:{...command,requestSha256:'0'.repeat(64)}},{transitionId:randomUUID()},{activationId:randomUUID()},
		{revocationRevision:revocation.revocationRevision+1},{revocationRevision:String(revocation.revocationRevision)},
		{configurationSha256:'0'.repeat(64)},{startCompletionSha256:'0'.repeat(64)},{fromServiceInvocationId:'0'.repeat(32)},
		{observedInvocationId:'0'.repeat(32)},{stoppedInvocationId:0},{controlGroup:'/other'},{cgroupState:'populated'}])
		await deny(ack({...inspection(nonce),stop:{...inspection(nonce).stop,...change}}));
	assert.equal(state(),before);console.log('PASS: stop challenge and acknowledgement reject foreign, malformed and broadened identities without cleanup or release');
	const count=Number(execute('select count(*) from public.qorpera_runtime_office_stop_challenges;'));
	const exhausted=await deny('begin; '+Array.from({length:65-count},()=>prepare(randomUUID())).join(' ')+' rollback;');
	assert.match(exhausted.error,/inspection budget exhausted/);
	assert.equal(Number(execute('select count(*) from public.qorpera_runtime_office_stop_challenges;')),count);
	console.log('PASS: SQL bounds retained inspection attempts without allowing command rebinding or expiry-based reset');
	// Owner revocation remains legal while maintenance is in force, and can
	// issue a newer drain than both the original revocation and stop challenge.
	const profile=call(`select jsonb_build_object('id',p.id,'owner',p.owner_user_id,'version',p.version,'grantVersion',g.version,'staff',g.staff_agent_id)
		from public.qorpera_runtime_browser_profiles p join public.qorpera_runtime_browser_grants g on g.profile_id=p.id limit 1;`,'');
	const browserOwner=`set request.jwt.claims='{"role":"authenticated","sub":"${profile.owner}"}'; set role authenticated;`;
	const revoke=()=>call(`select public.qorpera_set_runtime_browser_grant(${literal(scope)},'${profile.id}','${profile.staff}',${profile.version},${profile.grantVersion++},false);`,browserOwner);
	const current=revoke();assert.equal(current.drains.length,1);assert.notEqual(current.drains[0].drainId,revocation.drains[0].drainId);
	await deny(ack(inspection(nonce)));await deny(prepare(nonce));
	const freshNonce=randomUUID(),fresh=call(prepare(freshNonce));assert.deepEqual(fresh.drains,current.drains);
	console.log('PASS: real owner grant revocation replaces historical drains and invalidates an earlier stop challenge');
	// Reject a late acknowledgement even when it already holds the office lock
	// but must wait for an outstanding resource-row lock before cleanup.
	execute("update public.qorpera_runtime_office_resources set state='draining',drained_at=null;");
	const blocker=session();blocker.child.stdin.write("begin; select id from public.qorpera_runtime_office_resources for update; select 'STOP_RESOURCE_LOCKED';\n");
	await until(()=>blocker.output().includes('STOP_RESOURCE_LOCKED'));
	const blockedNonce=randomUUID();call(prepare(blockedNonce));const waiting=session();
	waiting.child.stdin.end(`${service} set application_name='office-stop-expiry-race'; ${ack(inspection(blockedNonce))}`);
	await until(()=>execute("select count(*) from pg_stat_activity where application_name='office-stop-expiry-race' and wait_event_type='Lock';")==='1');
	blocker.child.stdin.end("select pg_sleep(5.1); commit;");assert.equal((await blocker.done).code,0);
	const expired=await waiting.done;assert.notEqual(expired.code,0);assert.match(expired.error,/acknowledgement expired/);
	assert.equal(call(status),null);assert.equal(execute('select state from public.qorpera_runtime_office_resources;'),'draining');
	await deny(prepare(blockedNonce));console.log('PASS: SQL rechecks expiry after blocked cleanup and rolls the entire acknowledgement back');
	const privacy={state:'private',version:11,challenge:{schema:'synthetic-retained-private-challenge',nonce:randomUUID()}};
	execute(`update public.qorpera_runtime_offices set privacy_state='${privacy.state}',privacy_version=${privacy.version},privacy_challenge=${literal(privacy.challenge)},revision=revision+1;
		update public.qorpera_runtime_office_providers set preparation_enabled=false;
		insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001');`);
	const methods=[];let loseAck=true;
	const control=new LxdOfficeStopControl(stopRequest,command,{call:async(method,args,signal)=>{
		signal.throwIfAborted();methods.push(method);
		const sql=method==='qorpera_prepare_runtime_office_stop'?prepare(args.p_inspection_id,args.p_command,args.p_request,args.p_start_completion_sha256):
			method==='qorpera_ack_runtime_office_stop'?ack(args.p_inspection):status;
		if(method==='qorpera_ack_runtime_office_stop'&&loseAck){
			const concurrent=await race([`${service} ${sql}`,`${service} ${sql}`]);
			for(const item of concurrent)assert.equal(item.code,0,item.error);
			assert.deepEqual(JSON.parse(concurrent[0].output),JSON.parse(concurrent[1].output));
			loseAck=false;throw new Error('Synthetic lost committed acknowledgement');
		}return call(sql);
	}});
	const finalNonce=randomUUID(),prepared=await control.prepare(finalNonce,new AbortController().signal);
	assert.deepEqual(prepared.drains,current.drains);
	await assert.rejects(control.acknowledge(inspection(finalNonce),new AbortController().signal),/UNCONFIRMED/);
	const result=await control.status(new AbortController().signal);assert.equal(result.state,'stopped');assert.deepEqual(result.inspection,inspection(finalNonce));
	assert.equal(execute('select state from public.qorpera_runtime_office_resources;'),'drained');
	assert.equal(execute('select state from public.qorpera_runtime_office_viewers;'),'ended');
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_screens where drain_pending;'),'0');
	assert.deepEqual(call(`select jsonb_build_object('state',privacy_state,'version',privacy_version,'challenge',privacy_challenge) from public.qorpera_runtime_offices;`,''),privacy);
	assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
	assert.equal(execute('select state from public.qorpera_runtime_office_lifecycle_transitions;'),'draining');
	assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
	assert.equal(execute('select state from public.qorpera_runtime_office_activations;'),'active');
	let screenHistory;
	if(screenLifetimeId){
		screenHistory=call(`select public.qorpera_runtime_screen_history('${screenLifetimeId}',statement_timestamp()-interval '1 hour',statement_timestamp());`);
		assert.equal(screenHistory.guestClosedAt,null);
		assert.equal(screenHistory.termination.source,'office_service_stop');
		assert.equal(screenHistory.termination.transitionId,request.transitionId);
		assert.equal(screenHistory.termination.exactScreenCloseTime,false);
		assert.equal(Math.floor(Date.parse(screenHistory.termination.confirmedGoneAt)),result.acknowledgedAtMs);
		const stopSeconds=(Date.parse(screenHistory.termination.confirmedGoneAt)-Date.parse(screenHistory.requestedAt))/1000;
		assert(Math.abs(Number(screenHistory.usage.observedLifetimeHours)*3600-stopSeconds)<0.002);
		assert(Number(screenHistory.usage.estimatedReadyScreenHours)*3600<=15.001);
		const retained=call(`select public.qorpera_runtime_screen_events('${screenLifetimeId}',0,1000);`);
		assert.equal(retained.state,'ready');assert.equal(retained.closedAt,null);
		assert.deepEqual(retained.events.map(e=>e.event.state),['requested','ready']);
	}
	await restartDatabase();assert.deepEqual(await control.status(new AbortController().signal),result);
	if(screenHistory){
		assert.deepEqual(call(`select public.qorpera_runtime_screen_history('${screenLifetimeId}',(${literal(screenHistory.from)}#>>'{}')::timestamptz,(${literal(screenHistory.until)}#>>'{}')::timestamptz);`),screenHistory);
		console.log('SCREEN_STOP_HISTORY_SQL_PROOF='+JSON.stringify({schema:'qorpera.screen-stop-history-sql-proof/v1',actualProviderSqlAcknowledgement:true,physicalStop:'fixture',missingGuestClosePreserved:true,heartbeatHoldBounded:true,providerStopBoundsLifetime:true,historySurvivesRestart:true,allocationStillCharged:true}));
	}
	assert.deepEqual(call(ack(inspection(finalNonce))),result);await deny(ack(inspection(freshNonce)));await deny(prepare(randomUUID()));
	assert.equal(execute('select count(*) from public.qorpera_runtime_office_stops;'),'1');
	// A later real grant revocation can fence screens again. Replaying a
	// historical stop acknowledgement must preserve that newer challenge.
	const replay=call(`begin; reset role; update public.qorpera_runtime_offices set privacy_state='shared',revision=revision+1;
		${browserOwner} select public.qorpera_set_runtime_browser_grant(${literal(scope)},'${profile.id}','${profile.staff}',${profile.version},${profile.grantVersion},false);
		${service} ${ack(inspection(finalNonce))} reset role;
		select jsonb_build_object('pending',(select count(*) from public.qorpera_runtime_office_screens where drain_pending),'receipt',public.qorpera_runtime_office_stop_status(${literal(request)})); rollback;`,'');
	assert.equal(replay.pending,1);assert.deepEqual(replay.receipt,result);
	await deny(`select public.qorpera_check_runtime_office_startup(${literal(request.startup)});`);
	assert.equal(call(`select public.qorpera_runtime_office_lifecycle_status(${literal(request)});`).state,'draining');
	assert.equal(methods.filter(m=>m==='qorpera_ack_runtime_office_stop').length,1);
	console.log('PASS: concurrent acknowledgements commit once; actual stop adapter recovers lost committed reply and database restart, preserves newer drains/private state and leaves admission and machine capacity fenced');
	return { request: stopRequest, command, acknowledgement: result };
}
