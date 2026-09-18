// Actual viewer authority and PostgreSQL queries; allocation/host placement
// records are explicit fixtures. No installed guest, model or hosted service.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {POSTGRES_IMAGE,sortMigrationNames} from './test-hosted-db.mjs';
const root=resolve(import.meta.dirname,'..'),container='qorpera-compute-users-'+randomUUID();
const psql=['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d','users','-v','ON_ERROR_STOP=1'];
const read=path=>readFileSync(join(root,path),'utf8');
const docker=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:60000,maxBuffer:4*1024**2});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const sql=text=>docker(psql,text);
const node='37000000-0000-4000-8000-000000000010';let started=false;
// The image's temporary initialization server accepts Unix-socket connections.
// TCP is enabled only by the final server that will execute the migrations.
async function ready(){for(let n=0;n<60;n++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d','users'],{timeout:2000}).status===0)return;await delay(500);}throw Error('Database not ready');}
try{
 docker(['run','-d','--rm','--name',container,'--network','none','-e','POSTGRES_PASSWORD=disposable-users-only','-e','POSTGRES_DB=users',POSTGRES_IMAGE]);started=true;await ready();
 sql(read('supabase/tests/bootstrap.sql'));
 const migrations=sortMigrationNames(readdirSync(join(root,'supabase/migrations')));for(const name of migrations)sql(read('supabase/migrations/'+name));
 const wake=read('supabase/tests/300_runtime_wake_bus.test.sql').split('-- END WAKE FIXTURE');assert.equal(wake.length,2);
 const office=read('supabase/tests/fixtures/runtime-office-registry-cases.sql').split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");assert.equal(office.length,2);
 sql(wake[0]+'\n'+office[0]+'\n'+read('supabase/tests/fixtures/runtime-office-viewer-cases.sql')+'\n'+read('supabase/tests/fixtures/runtime-compute-users-cases.sql')+'\ncommit;');
 const window=JSON.parse(sql("select jsonb_build_object('from',clock_timestamp()-interval '1 hour','until',clock_timestamp());"));
 const query=`set request.jwt.claims='{"role":"service_role"}';set role service_role;select public.qorpera_runtime_compute_users('${node}','${window.from}','${window.until}');`;
 const before=JSON.parse(sql(query));assert.equal(before.activity.observedActiveUsers,3);
 docker(['restart',container]);await ready();const after=JSON.parse(sql(query));
 assert.deepEqual(after.activity,before.activity);
 const allocation=value=>{const copy=structuredClone(value.currentAllocation);delete copy.asOf;return copy;};assert.deepEqual(allocation(after),allocation(before));
 console.log('COMPUTE_USERS_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-compute-users-proof/v1',migrations:migrations.length,actualSql:true,
  actualViewerAuthority:true,physicalAndAllocationPlacement:'fixtures',observedUsers:3,distinctComputersAndCompanies:true,membershipSeparate:true,
  halfOpenWindow:true,endedAndRevokedHistoryRetained:true,missingIsUnknown:true,generationAndPlacementFenced:true,
  accessAndBounds:true,noRawInputs:true,readOnly:true,databaseRestart:true}));
}finally{if(started)docker(['rm','-f',container]);}
