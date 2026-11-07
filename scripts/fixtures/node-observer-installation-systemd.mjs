import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {chmod,chown,cp,lstat,mkdir,readFile,readdir,readlink,rename,rm,writeFile} from 'node:fs/promises';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const exec=(file,args,timeout=10000)=>spawnSync(file,args,{encoding:'utf8',timeout});
const ok=(file,args,timeout)=>{const r=exec(file,args,timeout);assert.equal(r.status,0,`${file}: ${r.stderr} ${r.stdout}`);return r.stdout.trim();};
const ctl=(...args)=>ok('/usr/bin/systemctl',args,30000),prop=(key)=>ctl('show',unit,'--property='+key,'--value');
const unit='qorpera-node-observer.service',uid=2301,gid=2301,socketGid=2302,root='/run/node-observer-install-input',output='/opt/qorpera/node-observer';
const installer=root+'/package/qorpera-node-observer-install.cjs',specPath=root+'/spec.json',lock='/run/qorpera-node-observer-install/install.lock';
const installedKey='/etc/qorpera/node-observer.key',checks=[],requests=[],observations=[],errors=[],lxdReads=[],healthObservations=[];
let registry,lxd,broken=false,stall=false,healthStall=false,collectionFault=false,healthReplies=0;
const check=name=>{checks.push(name);console.log('PASS '+name);};
// The health loop waits 20 seconds after each settled attempt (RUNTIME_NODE_HEALTH_WAIT_MS).
const healthWait=40000;
async function until(fn,label,ms=20000){const start=performance.now();while(!await fn()){assert(performance.now()-start<ms,label+' '+exec('/usr/bin/systemctl',['status',unit,'--no-pager']).stdout+' '+exec('/usr/bin/journalctl',['-u',unit,'--no-pager','-n','10']).stdout);await delay(50);}}
function install(stage='--apply',success=true,code){const r=exec('/usr/bin/node',['--jitless','--disable-proto=throw','--disallow-code-generation-from-strings',installer,stage,'--spec',specPath],60000);assert.equal(r.status,success?0:1,JSON.stringify({error:String(r.error),signal:r.signal})+' '+r.stdout+' '+r.stderr);if(code)assert(r.stderr.includes(code),r.stderr);return r;}
const exists=async p=>!!await lstat(p).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
async function snapshot(){const receipt=JSON.parse(await readFile(output+'/installation.json','utf8'));return Promise.all([...receipt.files.map(f=>f.path),output+'/installation.json'].map(async p=>{const s=await lstat(p);return {p,ino:s.ino,mode:s.mode,uid:s.uid,gid:s.gid,sha256:hash(await readFile(p))};}));}
try {
	// The packager creates the folder with the host umask: 0775 under Ubuntu's user default 0002.
	assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);await mkdir(root,{mode:0o755});await cp('/fixture/package',root+'/package',{recursive:true});await chmod(root+'/package',0o755);
	for(const name of await readdir(root+'/package')){await chown(root+'/package/'+name,0,0);await chmod(root+'/package/'+name,0o444);}
	const cert=await readFile('/fixture/tls/cert.pem'),certificateSha256=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase(),socketPath=root+'/lxd.socket';
	const policy={schema:'qorpera.runtime-node-inventory-policy/v1',nodeId:randomUUID(),host:{machineIdSha256:hash((await readFile('/etc/machine-id','utf8')).trim()),socketPath,socketGid,certificateSha256,serverName:'fixture-node',serverVersion:'6.9',architecture:process.arch==='arm64'?'aarch64':'x86_64'},operatingCpuMillis:1000,operatingMemoryBytes:1024**3,infrastructure:[]};
	lxd=httpServer((request,response)=>{lxdReads.push(request.url);if(stall)return;
		let metadata;if(request.url==='/1.0?project=default')metadata={auth:'trusted',auth_user_method:'unix',api_version:'1.0',api_status:'stable',public:false,api_extensions:['instance_all_projects'],environment:{server:'lxd',kernel:'Linux',server_clustered:false,project:'default',driver:'lxc | qemu',instance_types:['container','virtual-machine'],certificate:cert.toString(),certificate_fingerprint:certificateSha256,server_name:'fixture-node',server_version:'6.9',kernel_architecture:policy.host.architecture}};
		else if(['/1.0/instances?all-projects=true&recursion=0','/1.0/instances?all-projects=true&recursion=1'].includes(request.url))metadata=[];
		else {response.writeHead(404).end();return;}
		assert.equal(request.method,'GET');response.writeHead(broken?500:200,{'content-type':'application/json'}).end(JSON.stringify({type:'sync',status_code:200,metadata}));
	});await new Promise(done=>lxd.listen(socketPath,done));await chown(socketPath,0,socketGid);await chmod(socketPath,0o660);
	const key='synthetic-node-observer-token-'.repeat(3),context={policy,nodeVersion:1,contextSha256:'c'.repeat(64),headroomCpuMillis:1000,headroomMemoryBytes:1024**3,allocations:[]};
	registry=httpsServer({key:await readFile('/fixture/tls/key.pem'),cert},(request,response)=>{const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{try {
		assert.equal(request.headers.authorization,'Bearer '+key);assert.equal(request.method,'POST');const args=JSON.parse(Buffer.concat(chunks));requests.push(request.url);let value;
		if(request.url==='/rest/v1/rpc/qorpera_runtime_node_inventory_context'){assert.deepEqual(args,{p_node_id:policy.nodeId});value=context;}
		else if(request.url==='/rest/v1/rpc/qorpera_observe_runtime_node_health'){
			const o=args.p_observation;assert.equal(o.schema,'qorpera.runtime-node-health/v1');assert.equal(o.nodeId,policy.nodeId);
			assert.equal(o.machineIdSha256,policy.host.machineIdSha256);assert.equal(o.policySha256,spec.policySha256);
			assert(Date.now()-Date.parse(o.observedAt)<15000);
			if(o.bootId===null){assert(collectionFault);assert.equal(o.observerPackageSha256,null);assert.deepEqual(o.errors,['COLLECTION_UNCONFIRMED']);
				for(const k of ['cpu','memory','rootFilesystem','network'])assert.equal(o[k],null);}
			else {assert.equal(o.bootId,awaitBootId);assert.equal(o.observerPackageSha256,spec.packageManifestSha256);
				assert(o.cpu.usedBasisPoints>=0&&o.cpu.usedBasisPoints<=10000);assert(Date.parse(o.cpu.until)-Date.parse(o.cpu.from)>=500);
				assert(o.memory.totalBytes>0&&o.memory.availableBytes>=0&&o.memory.availableBytes<=o.memory.totalBytes);
				assert(o.rootFilesystem.totalBytes>0&&o.rootFilesystem.availableBytes<=o.rootFilesystem.freeBytes&&o.rootFilesystem.freeBytes<=o.rootFilesystem.totalBytes);
				// Network isolation does not imply that the kernel exposes only
				// loopback: inert tunnel interfaces can also exist. Compare against
				// this guest's counters, without claiming external reachability.
				assert.deepEqual(o.network,expectedNetwork);assert.deepEqual(o.errors,expectedNetwork?[]:['NETWORK_COUNTERS_UNAVAILABLE']);}
			healthObservations.push(o);if(healthStall)return;
			healthReplies++;value={nodeId:o.nodeId,observationId:o.observationId,observedAt:o.observedAt};
		}
		else if(request.url==='/rest/v1/rpc/qorpera_observe_runtime_node_agent_exit'){
			// This guest has no agent exit, so the observer reports an unhealthy one with no check.
			const o=args.p_observation;assert.equal(o.schema,'qorpera.runtime-node-agent-exit/v1');assert.equal(o.nodeId,policy.nodeId);
			assert.equal(o.machineIdSha256,policy.host.machineIdSha256);assert.equal(o.policySha256,spec.policySha256);
			assert.equal(o.healthy,false);assert.equal(o.checkedAt,null);
			value={nodeId:o.nodeId,healthy:o.healthy};
		}
		else {
			assert(['/rest/v1/rpc/qorpera_observe_runtime_node','/rest/v1/rpc/qorpera_observe_runtime_node_inventory'].includes(request.url));const o=args.p_observation;
			assert.equal(o.nodeId,policy.nodeId);assert.equal(o.machineIdSha256,policy.host.machineIdSha256);assert(o.cpuMillis>=1000&&o.memoryBytes>0);assert(Date.now()-Date.parse(o.observedAt)<15000);
			if(o.state==='ready'){assert.equal(args.p_context_sha256,context.contextSha256);assert.deepEqual(args.p_inventory.entries,[]);assert.equal(args.p_inventory.bootId,(awaitBootId));}
			else assert.equal(o.state,'unavailable');assert(!observations.some(v=>v.observationId===o.observationId));observations.push(o);value={nodeId:o.nodeId,observationId:o.observationId,observedAt:o.observedAt};
		}
		response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
	}catch(e){errors.push(String(e));console.error('FIXTURE_REGISTRY_REJECTION '+String(e));response.writeHead(500).end();}});});
	const awaitBootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
	const networkRows=(await readFile('/proc/net/dev','utf8')).trimEnd().split('\n').slice(2).map(line=>line.trim().split(/:\s*/)).filter(([name])=>name!=='lo');
	const expectedNetwork=networkRows.length?{receivedBytes:0,sentBytes:0,receiveErrors:0,sendErrors:0,receiveDrops:0,sendDrops:0}:null;
	for(const [,text] of networkRows){const fields=text.split(/\s+/).map(Number);assert.equal(fields.length,16);for(const [key,index] of [['receivedBytes',0],['sentBytes',8],['receiveErrors',2],['sendErrors',10],['receiveDrops',3],['sendDrops',11]])expectedNetwork[key]+=fields[index];}
	await new Promise(done=>registry.listen(0,'127.0.0.1',done));
	const documents={service:Buffer.from(JSON.stringify({registryUrl:`https://127.0.0.1:${registry.address().port}`,policy})),key:Buffer.from(key),ca:cert};
	const spec={schema:'qorpera.node-observer-installation/v1',packageRoot:root+'/package',packageManifestSha256:hash(await readFile(root+'/package/manifest.json')),policySha256:hash(JSON.stringify(canonical(policy))),uid,gid,documents:{}};
	for(const [name,bytes] of Object.entries(documents)){const path=root+'/'+name;await writeFile(path,bytes,{mode:name==='key'?0o400:0o444});spec.documents[name]={path,bytes:bytes.length,sha256:hash(bytes)};}await writeFile(specPath,JSON.stringify(spec),{mode:0o444});
	install('--check');assert.equal(await exists(output),false);assert.equal(await exists(installedKey),false);assert.equal(await exists(lock),false);assert.equal(exec('/usr/bin/getent',['passwd',String(uid)]).status,2);assert.equal(requests.length,0);check('read-only preview creates no account, files or network request');
	install('--commit',false);assert.equal(await exists(output),false);check('internal commit requires actual inherited kernel flock');
	await chmod(root+'/key',0o644);install('--apply',false);await chmod(root+'/key',0o400);check('unsafe source credential refused');
	await writeFile(root+'/package/qorpera-node-observer.cjs',Buffer.concat([await readFile(root+'/package/qorpera-node-observer.cjs'),Buffer.from(' ')]));install('--apply',false);await writeFile(root+'/package/qorpera-node-observer.cjs',await readFile('/fixture/package/qorpera-node-observer.cjs'));check('changed packaged artifact refused');
	const override='/etc/systemd/system/qorpera-node-.service.d';await mkdir(override);await writeFile(override+'/fixture.conf','[Service]\nMemoryDenyWriteExecute=no\n');install('--apply',false);await rm(override,{recursive:true});check('unloaded systemd prefix override refused');
	install();assert.equal(prop('ActiveState'),'inactive');assert.equal(prop('UnitFileState'),'disabled');assert.equal(requests.length,0);assert.equal(ok('/usr/bin/id',['-G','qorpera-node-observer']),`${gid} ${socketGid}`);const first=await snapshot();
	const privateKey=first.find(f=>f.p===installedKey);assert.equal(privateKey.mode&0o7777,0o440);assert.equal(privateKey.uid,0);assert.equal(privateKey.gid,gid);check('verified installation is disabled, stopped and private');
	install('--commit',false);check('lock pathname alone does not authorize commit');
	const held=spawn('/usr/bin/flock',['-xn','--no-fork',lock,'/usr/bin/node','-e','process.stdout.write("held");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','pipe']});await new Promise((done,reject)=>{held.stdout.once('data',done);held.once('exit',()=>reject(new Error('mutex failed')));});
	try{install('--apply',false);assert.deepEqual(await snapshot(),first);}finally{held.kill('SIGTERM');await until(()=>held.exitCode!==null||held.signalCode!==null,'mutex cleanup');}check('competing install mutex preserves all files');
	ctl('start',unit);await until(()=>observations.length>=2,'complete headless inventory polling');const pid=Number(prop('MainPID'));assert(pid>1);
	const status=await readFile(`/proc/${pid}/status`,'utf8');for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+field+':\\s+0+$','m'));assert.match(status,/^NoNewPrivs:\s+1$/m);assert.equal(await readlink(`/proc/${pid}/ns/mnt`),await readlink('/proc/1/ns/mnt'));assert(observations.every(o=>o.state==='ready'));check('actual unprivileged systemd observer publishes complete inventory over trusted TLS');
	await until(()=>healthReplies>0,'actual kernel health publication');check('bounded unprivileged health child reports CPU memory root disk and actual network counters with installed package provenance');
	healthStall=true;const healthStart=healthObservations.length,inventoryStart=observations.length;
	await until(()=>healthObservations.length>healthStart&&observations.length>inventoryStart+1,'inventory continues during diagnostic export stall',healthWait);
	healthStall=false;const oldReplies=healthReplies;await until(()=>healthReplies>oldReplies,'health export recovers',healthWait);check('stalled diagnostic TLS export does not block inventory publication');
	// Root-only fault injection inside this disposable guest. The running main
	// process stays intact while its next child is deliberately nonresponsive.
	const executable=await readFile(output+'/qorpera-node-observer.cjs');collectionFault=true;
	try {await writeFile(output+'/qorpera-node-observer.cjs','setInterval(()=>{},1000);');const start=observations.length;
		await until(()=>healthObservations.some(o=>o.bootId===null)&&observations.length>start,'hung child bounded without blocking inventory',healthWait);}
	finally {await writeFile(output+'/qorpera-node-observer.cjs',executable);}
	await until(()=>healthObservations.at(-1)?.bootId===awaitBootId,'health collection recovery',healthWait);collectionFault=false;
	assert.deepEqual(await snapshot(),first);check('hung diagnostic child is killed and reaped before recovery while inventory remains independent');
	install('--apply',false,'NODE_OBSERVER_INSTALL_SERVICE_NOT_STOPPED');assert.deepEqual(await snapshot(),first);check('running observer blocks installation');
	const before=observations.length;ctl('restart',unit);await until(()=>observations.length>before,'restart polling');const replacement=Number(prop('MainPID'));assert.notEqual(replacement,pid);assert.deepEqual(await snapshot(),first);check('ordinary restart preserves credentials and package inodes');
	const beforeCrash=observations.length;process.kill(replacement,'SIGKILL');await until(()=>observations.length>beforeCrash&&Number(prop('MainPID'))!==replacement,'crash restart');assert.deepEqual(await snapshot(),first);check('failure restart resumes fresh observations');
	broken=true;await until(()=>observations.at(-1)?.state==='unavailable','failed daemon reports unavailable');broken=false;await until(()=>observations.at(-1)?.state==='ready','daemon recovery reports ready');check('daemon failure and recovery publish explicit bounded state');
	stall=true;const startReads=lxdReads.length;await until(()=>lxdReads.length>startReads,'stalled daemon request');const beforeStop=observations.length,startStop=performance.now();ctl('stop',unit);const stopMs=Math.round(performance.now()-startStop);assert(stopMs<10000);assert.equal(prop('ActiveState'),'inactive');await delay(300);assert.equal(observations.length,beforeStop);stall=false;check('SIGTERM cancels outstanding socket observation without publishing readiness');
	install();assert.deepEqual(await snapshot(),first);check('inactive exact reinstall preserves identity and inodes');
	await chmod(installedKey,0o444);install('--apply',false,'NODE_OBSERVER_INSTALL_EXISTING_FILES_DIFFER');await chmod(installedKey,0o440);check('changed credential custody refused');
	await rename(output+'/qorpera-node-observer.cjs',output+'/preserved.cjs');install('--apply',false,'NODE_OBSERVER_INSTALL_STATE_REQUIRES_RECOVERY');await rename(output+'/preserved.cjs',output+'/qorpera-node-observer.cjs');assert.deepEqual(await snapshot(),first);check('partial retained installation requires explicit recovery');
	await mkdir('/etc/systemd/system/'+unit+'.d');await writeFile('/etc/systemd/system/'+unit+'.d/fixture.conf','[Service]\nMemoryDenyWriteExecute=no\n');ctl('daemon-reload');install('--apply',false);await rm('/etc/systemd/system/'+unit+'.d',{recursive:true});ctl('daemon-reload');check('loaded override refused');
	install('--check');assert.equal(prop('ActiveState'),'inactive');assert.equal(prop('UnitFileState'),'disabled');assert.deepEqual(errors,[]);
	console.log('NODE_OBSERVER_SYSTEMD_PROOF='+JSON.stringify({schema:'qorpera.node-observer-installation-systemd-proof/v2',node:process.version,platform:process.platform,arch:process.arch,actualSystemd:true,actualKernelFlock:true,observerCapabilities:'zero',checks,stopMs,observations:observations.length,healthObservations:healthObservations.length,actualKernelHealth:true,independentDiagnosticExport:true,boundedHealthChild:true,lxdReads:lxdReads.length,packageManifestSha256:spec.packageManifestSha256,daemonAndRegistry:'fixtures',actualSql:false,realLxd:false,deployed:false,modelCalls:false}));
} finally {exec('/usr/bin/systemctl',['stop',unit],30000);for(const server of [registry,lxd])if(server){server.closeAllConnections();await new Promise(done=>server.close(()=>done()));}}
