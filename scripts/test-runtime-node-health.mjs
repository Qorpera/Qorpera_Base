// Actual producer policy digest + publisher + complete migrations in disposable
// PostgreSQL. Kernel measurements are fixtures; no live host or provider access.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {POSTGRES_IMAGE,sortMigrationNames} from './test-hosted-db.mjs';
import {testRuntimeNodeHealth} from './test-runtime-node-health-cases.mjs';

if(process.argv.length!==2)throw new Error('Usage: node scripts/test-runtime-node-health.mjs');
const root=dirname(dirname(fileURLToPath(import.meta.url))),scratch=await mkdtemp(join(tmpdir(),'node-health-'));
const container=`qorpera-health-${randomBytes(6).toString('hex')}`,nodeId='36000000-0000-4000-8000-000000000010';
const psql=['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d','health','-v','ON_ERROR_STOP=1'];
const read=path=>readFileSync(join(root,path),'utf8'),quote=v=>`'${String(v).replaceAll("'","''")}'`,literal=v=>`${quote(JSON.stringify(v))}::jsonb`;
const service=`set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
function docker(args,input){const result=spawnSync('docker',args,{input,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});assert(!result.error&&result.status===0,`${result.stderr}\n${result.stdout}\n${result.error??''}`);return result.stdout.trim();}
const sql=s=>docker(psql,s);
async function ready(){let count=0;for(let n=0;n<60&&count<2;n++){const result=spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d','health'],{timeout:2000});count=result.status===0?count+1:0;if(count<2)await new Promise(resolve=>setTimeout(resolve,250));}assert.equal(count,2);}
let started=false;
try {
 await build({entryPoints:Object.fromEntries([['health','runtime-node-health'],['inventory','runtime-node-inventory'],['digest','lxd-office-image-provenance']].map(([key,file])=>[key,join(root,`packages/runner-orchestrator/src/${file}.ts`)])),outdir:scratch,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},target:'node22'});
 const require=createRequire(import.meta.url);
 docker(['run','-d','--rm','--name',container,'--network','none','-e','POSTGRES_PASSWORD=disposable-health','-e','POSTGRES_DB=health',POSTGRES_IMAGE]);started=true;await ready();
 sql(read('supabase/tests/bootstrap.sql'));
 const migrations=sortMigrationNames(readdirSync(join(root,'supabase/migrations')));
 for(const name of migrations)sql(read(`supabase/migrations/${name}`));
 const wake=read('supabase/tests/300_runtime_wake_bus.test.sql').split('-- END WAKE FIXTURE'),office=read('supabase/tests/fixtures/runtime-office-registry-cases.sql').split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
 assert.equal(wake.length,2);assert.equal(office.length,2);
 sql(`${wake[0]}\n${office[0]}\n${read('supabase/tests/fixtures/runtime-node-capacity-setup.sql')}\ncommit;`);
 const policy={schema:'qorpera.runtime-node-inventory-policy/v1',nodeId,host:{machineIdSha256:'c'.repeat(64),socketPath:'/var/lib/lxd/unix.socket',socketGid:2000,certificateSha256:'d'.repeat(64),serverName:'fixture-node',serverVersion:'6.9',architecture:'x86_64'},operatingCpuMillis:1000,operatingMemoryBytes:512*1024**2,
  infrastructure:[{project:'default',name:'management',physicalId:'36000000-0000-4000-8000-000000000099',type:'virtual-machine',configurationSha256:'a'.repeat(64),cpuMillis:1000,memoryBytes:512*1024**2}]};
 sql(`${service} select public.qorpera_enroll_runtime_node_inventory(${literal(policy)});`);
 await testRuntimeNodeHealth({nodeId,sql,psql,service,literal,quote,read,restartDatabase:async()=>{docker(['restart',container]);await ready();},
  officeDigest:require(join(scratch,'digest.cjs')).officeDigest,parsePolicy:require(join(scratch,'inventory.cjs')).parseRuntimeNodeInventoryPolicy,
  RuntimeNodeHealthPublisher:require(join(scratch,'health.cjs')).RuntimeNodeHealthPublisher});
 console.log('NODE_HEALTH_POLICY_MIGRATIONS='+migrations.length);
} finally {
 if(started)spawnSync('docker',['rm','-f',container],{timeout:15000});
 await rm(scratch,{recursive:true,force:true});
}
