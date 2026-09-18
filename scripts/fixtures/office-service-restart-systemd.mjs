import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,chmod,lstat} from 'node:fs/promises';
const hash=b=>createHash('sha256').update(b).digest('hex'),encode=v=>Buffer.from(JSON.stringify(v)+'\n');
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const root='/run/qorpera-office-preparation',base='/opt/qorpera-office',preparation='qorpera-company-computer-preparation.service';

// Initial configuration/SQL evidence remains synthetic. Run the unchanged
// preparation unit with a synthetic report producer so the restart controller
// must verify a real retained systemd invocation rather than a mocked manager.
export async function prepareActualRestartFixture(ok) {
	const report=await load(root+'/result.json');
	await writeFile(base+'/qorpera-company-computer-preparation.mjs',`console.log(JSON.stringify({...${JSON.stringify(report)},invocationId:process.env.INVOCATION_ID}));\n`,{mode:0o444});
	await chmod(base+'/qorpera-company-computer-preparation.mjs',0o444);
	ok('/usr/bin/systemctl',['start',preparation],30000);
	const actualReport=await load(root+'/result.json');
	assert.equal(actualReport.invocationId,ok('/usr/bin/systemctl',['show','--property=InvocationID','--value',preparation]));
	const completed=await load(root+'/completion.json');
	completed.report=actualReport;completed.invocationId=actualReport.invocationId;completed.reportSha256=hash(await readFile(root+'/result.json'));
	await writeFile(root+'/completion.json',encode(completed));
	const configured=await load(root+'/configuration-completion.json');
	configured.preparationCompletionSha256=hash(await readFile(root+'/completion.json'));
	await writeFile(root+'/configuration-completion.json',encode(configured));
	const first=await load(root+'/service-start-completion.json');
	const request=await load(root+'/service-start-incoming-'+first.command.requestSha256+'.json');
	request.configuration=configured;request.configurationCompletionSha256=hash(await readFile(root+'/configuration-completion.json'));
	const command={...first.command,requestSha256:hash(encode(request))};
	await writeFile(root+'/service-start-incoming-'+command.requestSha256+'.json',encode(request),{mode:0o400});
	await writeFile(root+'/service-start-claim.json',encode({schema:'qorpera.office-service-start-claim/v1',command,activationId:first.activationId,configurationCompletionSha256:request.configurationCompletionSha256}));
	await writeFile(root+'/service-start-completion.json',encode({...first,command,configurationCompletionSha256:request.configurationCompletionSha256}));
}

export async function testActualServiceRestarts({ok,run,observe,check,originalStopRequest,originalStopInspection,work,workBytes}) {
	const restartExe=base+'/qorpera-company-computer-service-restart-control.mjs',stopExe=base+'/qorpera-company-computer-service-stop-control.mjs';
	const initial=await load(root+'/service-start-completion.json'),initialRequest=await load(root+'/service-start-incoming-'+initial.command.requestSha256+'.json');
	const retainedPaths=['service-start-claim.json','service-start-completion.json','service-stop-claim.json','service-stop-completion.json'];
	const retained=await Promise.all(retainedPaths.map(async path=>({path:root+'/'+path,bytes:await readFile(root+'/'+path),inode:(await lstat(root+'/'+path)).ino})));
	let stopRequest=originalStopRequest,stopInspection=originalStopInspection,stopPath=root+'/service-stop-completion.json';
	const oldCommands=[];
	for(let cycle=0;cycle<2;cycle++){
		const activationId=randomUUID(),attestation={...initialRequest.attestation,activationId};
		const acknowledgement={schema:'qorpera.office-service-stop-acknowledgement/v1',state:'stopped',request:stopRequest.revocation.request,inspection:stopInspection,acknowledgedAtMs:Date.now()};
		const successorRequest={schema:'qorpera.office-service-successor-request/v1',predecessor:stopRequest.revocation.request,attestation};
		const request={schema:'qorpera.office-service-restart-request/v1',start:{...initialRequest,attestation},stop:stopRequest,acknowledgement,stopCompletionSha256:hash(await readFile(stopPath)),
			successor:{schema:'qorpera.office-service-successor/v1',request:successorRequest,state:'prepared',serviceInvocationId:null,readinessFresh:false,stopAcknowledgedAtMs:acknowledgement.acknowledgedAtMs,officeRevision:cycle+3,privacyVersion:11,validForMs:5000}};
		const command={commandId:randomUUID(),requestSha256:hash(encode(request)),bootId:attestation.bootId},args=[command.commandId,command.requestSha256,command.bootId];
		await writeFile(root+'/service-restart-incoming-'+command.requestSha256+'.json',encode(request),{mode:0o400});
		assert.equal(run('/usr/bin/node',[restartExe,'--locked',...args]).status,1);assert.equal(observe().service.mainPid,0);
		ok('/usr/bin/node',[restartExe,...args],60000);
		const live=observe(),path=root+'/service-restart-completion-'+activationId+'.json',bytes=await readFile(path),completion=JSON.parse(bytes);
		assert.equal(live.service.activeState,'active');assert.equal(live.cgroupState,'populated');assert.equal(live.service.invocationId,completion.serviceInvocationId);assert.equal(live.service.mainPid,completion.mainPid);
		assert.notEqual(completion.serviceInvocationId,stopRequest.revocation.request.startup.serviceInvocationId);
		const inode=(await lstat(path)).ino;
		ok('/usr/bin/node',[restartExe,...args]);assert.equal((await lstat(path)).ino,inode);assert((await readFile(path)).equals(bytes));
		const nonce=randomUUID();ok('/usr/bin/node',[restartExe,...args,nonce]);
		assert.deepEqual((await load(root+'/service-restart-inspection-'+nonce+'.json')).start,completion);
		assert((await readFile(work)).equals(workBytes));
		for(const old of oldCommands)assert.equal(run('/usr/bin/node',[restartExe,...old]).status,1);
		oldCommands.push(args);
		check('packaged successor '+(cycle+1)+' starts one distinct real invocation, recovers without overwrite and supports fresh inspection');
		stopRequest={schema:'qorpera.office-service-stop-request/v1',startCompletionSha256:hash(bytes),revocation:{...stopRequest.revocation,requestedAtMs:Date.now(),revocationRevision:cycle+4,
			request:{...stopRequest.revocation.request,transitionId:randomUUID(),activationId,startup:{...stopRequest.revocation.request.startup,serviceInvocationId:completion.serviceInvocationId}}}};
		const stopCommand={commandId:randomUUID(),requestSha256:hash(encode(stopRequest)),bootId:attestation.bootId},stopArgs=[stopCommand.commandId,stopCommand.requestSha256,stopCommand.bootId];
		await writeFile(root+'/service-stop-incoming-'+stopCommand.requestSha256+'.json',encode(stopRequest),{mode:0o400});
		ok('/usr/bin/node',[stopExe,...stopArgs],100000);assert.equal(observe().service.mainPid,0);assert(['absent','empty'].includes(observe().cgroupState));
		stopPath=root+'/service-stop-completion-'+activationId+'.json';assert.equal((await load(stopPath)).fromServiceInvocationId,completion.serviceInvocationId);
		const stopNonce=randomUUID();ok('/usr/bin/node',[stopExe,...stopArgs,stopNonce]);stopInspection=await load(root+'/service-stop-inspection-'+stopNonce+'.json');
		assert.equal(run('/usr/bin/node',[restartExe,...args]).status,1);
		check('successor '+(cycle+1)+' stops its full real cgroup and permanently fences its restart command');
	}
	for(const previous of retained){assert((await readFile(previous.path)).equals(previous.bytes));assert.equal((await lstat(previous.path)).ino,previous.inode);}
	assert((await readFile(work)).equals(workBytes));
	check('two actual restart cycles preserve initial start/stop records and mutable workbench bytes');
}
