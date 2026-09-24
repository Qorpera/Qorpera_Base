import assert from 'node:assert/strict';
import {verifyOfficeBootCredentials} from './boot-credentials.mjs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,cp,lstat,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root='/run/office-image-input',pkg=root+'/package',exe=pkg+'/qorpera-office-image-install.cjs',specPath=root+'/spec.json';
const unit='qorpera-company-computer.service',mountUnit='run-qorpera\\x2doffice-private.mount';
const exec=(file,args,timeout=60000)=>spawnSync(file,args,{encoding:'utf8',timeout});
const ok=(file,args,timeout)=>{const p=exec(file,args,timeout);assert.equal(p.status,0,p.stdout+' '+p.stderr);return p.stdout.trim();};
const ctl=(...args)=>ok('/usr/bin/systemctl',args);
const prop=(name,key)=>ctl('show',name,'--property='+key,'--value');
const exists=async p=>!!await lstat(p).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
const cases=[];const check=name=>{cases.push(name);console.log('PASS '+name);};
await mkdir(root,{mode:0o755});await cp('/fixture/package',pkg,{recursive:true});await chmod(pkg,0o755);
// Docker bind source ownership is irrelevant after copying into root-owned local staging.
const manifest=await readFile(pkg+'/manifest.json');const artifacts=JSON.parse(manifest).artifacts;
for(const a of artifacts)await chmod(pkg+'/'+a.file,0o444);await chmod(pkg+'/manifest.json',0o444);
const measured=JSON.parse(ok('/usr/bin/node',[exe,'--measure-dependencies']));
const spec={schema:'qorpera.office-image-installation/v1',packageRoot:pkg,packageManifestSha256:hash(manifest),uid:1100,gid:1100,architecture:process.arch,dependencies:measured};
await writeFile(specPath,JSON.stringify(spec),{mode:0o444});
function install(stage='--apply',success=true,code){const p=exec('/usr/bin/node',[exe,stage,'--spec',specPath],120000);if(success&&p.status!==0){const v=exec('/usr/bin/systemd-analyze',['verify','/etc/systemd/system/'+unit,'/etc/systemd/system/qorpera-company-computer-preparation.service','/etc/systemd/system/'+mountUnit]);console.log('UNIT_DIAGNOSTIC '+v.stdout+' '+v.stderr);console.log(exec('/usr/bin/ls',['-ld','/opt/qorpera-office','/etc/qorpera-office','/usr/local','/usr/local/lib','/usr/local/share','/usr/share/backgrounds']).stdout);}assert.equal(p.status,success?0:1,p.stdout+' '+p.stderr);if(code)assert(p.stderr.includes(code),p.stderr);return p;}
install('--check');assert.equal(await exists('/opt/qorpera-office'),false);assert.equal(await exists('/run/qorpera-office-image-install.lock'),false);assert.equal(exec('getent',['passwd','1100']).status,2);check('complete read-only preflight');
await writeFile(specPath,JSON.stringify({...spec,dependencies:{...measured,browserTreeSha256:'a'.repeat(64)}}));install('--apply',false,'OFFICE_IMAGE_DEPENDENCIES_CHANGED');await writeFile(specPath,JSON.stringify(spec));assert.equal(await exists('/opt/qorpera-office'),false);check('changed browser or dependency pins refused');
await writeFile(specPath,JSON.stringify({...spec,uid:1000,gid:1000}));install('--apply',false,'OFFICE_IMAGE_IDENTITY_CONFLICT');await writeFile(specPath,JSON.stringify(spec));check('interactive image identity cannot be reused');
install('--locked',false);assert.equal(await exists('/opt/qorpera-office'),false);check('internal apply requires kernel lock');
install();assert.equal(prop(unit,'ActiveState'),'inactive');assert.equal(prop(unit,'UnitFileState'),'disabled');assert.equal(prop(mountUnit,'ActiveState'),'inactive');assert.equal(prop('qorpera-company-computer-preparation.service','ActiveState'),'inactive');check('image installation leaves every service and mount inactive');
for(const u of ['apt-daily.timer','apt-daily-upgrade.timer','apt-daily.service','apt-daily-upgrade.service','unattended-upgrades.service'])assert.equal(prop(u,'UnitFileState'),'masked');check('image installation masks the apt self-update units');
const receiptPath='/opt/qorpera-office/installation.json',receipt=JSON.parse(await readFile(receiptPath));
async function snapshot(){return Promise.all([...receipt.files.map(f=>f.path),receiptPath,'/run/qorpera-office-preparation/control.lock'].map(async p=>{const s=await lstat(p);return{p,ino:s.ino,mode:s.mode,uid:s.uid,gid:s.gid,sha256:hash(await readFile(p))};}));}
const original=await snapshot();for(const f of receipt.files){const b=await readFile(f.path);assert.equal(hash(b),f.sha256);assert.equal(b.length,f.bytes);assert.equal((await lstat(f.path)).mode&0o7777,f.mode);}
assert.equal((await lstat('/etc/qorpera-office/credentials')).mode&0o7777,0o700);assert.deepEqual(await readdir('/etc/qorpera-office/credentials'),[]);assert.deepEqual(await readdir('/var/lib/qorpera-office'),[]);
for(const p of ['private','display','browser','captures']){const s=await lstat('/run/qorpera-office/'+p);assert.equal(s.uid,1100);assert.equal(s.gid,1100);assert.equal(s.mode&0o7777,0o700);}
check('all package assets and private runtime custody installed exactly');
assert.equal(ok('/usr/bin/node',[process.env.OFFICE_IMAGE_CONSUMER??'/fixture/consumer.mjs']),'OFFICE_IMAGE_PREPARATION_CONSUMER_ACCEPTED');check('actual preparation controller accepts installed units and immutable references');
install();assert.deepEqual(await snapshot(),original);check('identical unconfigured reinstall preserves inodes and lock');
ctl('start',mountUnit);assert.equal(prop(mountUnit,'ActiveState'),'active');const observation=ok('findmnt',['-n','-o','FSTYPE,SOURCE,OPTIONS','--target','/run/qorpera-office/private']);assert.match(observation,/tmpfs/);for(const option of ['nosuid','nodev','noexec','uid=1100','gid=1100'])assert(observation.includes(option),observation);assert.equal((await lstat('/run/qorpera-office/private')).uid,1100);check('actual systemd demand mount has private tmpfs identity and flags');
install('--apply',false,'OFFICE_IMAGE_UNIT_NOT_STOPPED');ctl('stop',mountUnit);check('active private mount prevents image installation');
const unconfigured=exec('/usr/bin/systemctl',['start',unit]);assert.notEqual(unconfigured.status,0);assert.equal(prop(unit,'MainPID'),'0');assert.deepEqual(await readdir('/etc/qorpera-office/credentials'),[]);check('unconfigured clean image cannot start office listeners');
ctl('stop',unit);ctl('stop',mountUnit);
await writeFile('/etc/qorpera-office/credentials/native','synthetic staged credential',{mode:0o400});install('--apply',false,'OFFICE_IMAGE_EXISTING_STATE');await rm('/etc/qorpera-office/credentials/native');check('configured guest cannot be repurposed as an image');
await writeFile('/var/lib/qorpera-office/retained-company-bytes','synthetic company state',{mode:0o600});install('--apply',false,'OFFICE_IMAGE_EXISTING_STATE');assert.equal(await readFile('/var/lib/qorpera-office/retained-company-bytes','utf8'),'synthetic company state');await rm('/var/lib/qorpera-office/retained-company-bytes');check('company state is refused and preserved');
await mkdir('/etc/systemd/system/'+mountUnit+'.d');await writeFile('/etc/systemd/system/'+mountUnit+'.d/proof.conf','[Mount]\nOptions=mode=0777\n');install('--apply',false);await rm('/etc/systemd/system/'+mountUnit+'.d',{recursive:true});check('unloaded mount override refused');
assert.deepEqual(await snapshot(),original);assert.equal(await exists('/etc/qorpera-office/adoption.json'),false);check('no adoption receipt or credentials invented');
const bootCredentials=await verifyOfficeBootCredentials();check('systemd selects current boot credentials and refuses old-boot fallback');assert.deepEqual(await snapshot(),original);
console.log('GUEST_IMAGE_INSTALL_PROOF='+JSON.stringify({schema:'qorpera.office-image-installation-systemd-proof/v1',node:process.version,arch:process.arch,bootCredentials,packageManifestSha256:hash(manifest),dependencyPins:measured,installedFiles:receipt.files.length,checks:cases,actualSystemd:true,actualTmpfs:true,realNas:false,realKvm:false,configured:false,deployed:false,modelCalls:false}));
