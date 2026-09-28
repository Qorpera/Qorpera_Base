import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SYSTEMD_CONTAINER_SECURITY,systemdContainerBoot} from './fixtures/systemd-container.mjs';
const repository=resolve(import.meta.dirname,'..'),image=process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE;
if(process.argv.length!==2||!image||!/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image))throw new Error('Usage: QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<digest-pinned local image> node scripts/test-node-observer-installation-systemd.mjs');
// Package as a root build would: Ubuntu's default user umask 0002 leaves files group-writable,
// and the installers refuse those as unprotected. Docker Desktop shows every mounted file as root 0644.
process.umask(0o022);
const temporary=await mkdtemp(join(tmpdir(),'node-observer-install-systemd-'));let container;
const command=(file,args,timeout=60000)=>{const r=spawnSync(file,args,{cwd:repository,encoding:'utf8',timeout});assert.equal(r.status,0,`${file}: ${r.stderr}`);return r.stdout.trim();};
try {
	const packaged=join(temporary,'package');command(process.execPath,['scripts/package-runtime-node-observer.mjs','--out',packaged]);
	command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temporary,'key.pem'),'-out',join(temporary,'cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
	const args=['run','-d','--name',basename(temporary),'--pull','never','--network','none','--cgroupns','private','--cap-drop','ALL'];
	// Container-only capabilities for its private systemd manager. The actual
	// installed observer unit retains an empty capability bounding set.
	for(const cap of ['SYS_ADMIN','SYS_PTRACE','SYS_RESOURCE','SYS_CHROOT','CHOWN','DAC_OVERRIDE','FOWNER','FSETID','KILL','SETGID','SETUID','SETPCAP','AUDIT_WRITE'])args.push('--cap-add',cap);
	args.push(...SYSTEMD_CONTAINER_SECURITY,'--cpus','2','--memory','768m','--pids-limit','1024','--tmpfs','/run:rw,nosuid,nodev,size=128m,mode=755','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/var/log/journal:rw,nosuid,nodev,size=16m,mode=755','--tmpfs','/etc/systemd/system:rw,nosuid,nodev,size=16m,mode=755','--env','container=docker');
	for(const [source,target] of [[packaged,'/fixture/package'],[join(repository,'scripts/fixtures/node-observer-installation-systemd.mjs'),'/fixture/check.mjs'],[temporary,'/fixture/tls']])args.push('--mount',`type=bind,src=${source},dst=${target},readonly`);
	args.push(image,'/bin/bash','-c',systemdContainerBoot('groupadd --gid 2302 node-lxd-fixture'));
	container=command('docker',args);let ready=false;
	for(let n=0;n<40;n++){const state=spawnSync('docker',['exec',container,'systemctl','is-system-running'],{encoding:'utf8',timeout:10000}).stdout?.trim();if(['running','degraded'].includes(state)){ready=true;break;}await delay(500);}assert(ready,'Private systemd did not start: '+command('docker',['logs',container]));
	await new Promise((done,reject)=>{const child=spawn('docker',['exec',container,'node','/fixture/check.mjs'],{stdio:'inherit',timeout:180000});child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error('Observer systemd installation proof failed')));});
	console.log(JSON.stringify({image,network:'none',privateCgroupNamespace:true,hostCgroupBind:false}));
} finally {try{if(container)command('docker',['rm','-f',container]);}finally{await rm(temporary,{recursive:true,force:true});}}
