// Actual PostgreSQL and admission RPCs. The extra offered dispatch records and
// host measurements are explicit fixtures; no physical machines or model calls.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {POSTGRES_IMAGE,sortMigrationNames} from './test-hosted-db.mjs';
const root=resolve(import.meta.dirname,'..'),container='qorpera-compute-requests-'+randomUUID();
const psql=['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d','requests','-v','ON_ERROR_STOP=1'];
const read=path=>readFileSync(join(root,path),'utf8');
const docker=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:60000,maxBuffer:4*1024**2});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const sql=text=>docker(psql,text);
let started=false;
async function ready(){for(let n=0;n<60;n++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d','requests'],{timeout:2000}).status===0)return;await delay(500);}throw Error('Database not ready');}
try{
 docker(['run','-d','--rm','--name',container,'--network','none','-e','POSTGRES_PASSWORD=disposable-requests-only','-e','POSTGRES_DB=requests',POSTGRES_IMAGE]);started=true;await ready();
 sql(read('supabase/tests/bootstrap.sql'));
 const migrations=sortMigrationNames(readdirSync(join(root,'supabase/migrations')));
 const migration='20260909000900_runtime_compute_requests.sql',migrationIndex=migrations.indexOf(migration);assert(migrationIndex>=0);
 for(const name of migrations.slice(0,migrationIndex))sql(read('supabase/migrations/'+name));
 const wake=read('supabase/tests/300_runtime_wake_bus.test.sql').split('-- END WAKE FIXTURE');assert.equal(wake.length,2);
 const office=read('supabase/tests/fixtures/runtime-office-registry-cases.sql').split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");assert.equal(office.length,2);
 const cases=read('supabase/tests/fixtures/runtime-compute-requests-cases.sql').split('-- APPLY COMPUTE REQUEST MIGRATION');assert.equal(cases.length,2);
 sql(wake[0]+'\n'+office[0]+'\n'+cases[0]+'\n'+migrations.slice(migrationIndex).map(name=>read('supabase/migrations/'+name)).join('\n')+'\n'+read('supabase/tests/fixtures/runtime-node-inventory-observer.sql')+'\n'+cases[1]+'\ncommit;');
 const query=`set request.jwt.claims='{"role":"service_role"}';set role service_role;select public.qorpera_runtime_compute_requests('30000000-0000-4000-8000-000000000010');`;
 const before=JSON.parse(sql(query));assert.equal(before.requests.find(r=>r.kind==='native').dispatchAttempts.deliveryFailedAttempts,2);
 docker(['restart',container]);await ready();const after=JSON.parse(sql(query));
 delete before.asOf;delete after.asOf;assert.deepEqual(after,before);
 console.log('COMPUTE_REQUESTS_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-compute-requests-proof/v1',migrations:migrations.length,
  actualSql:true,actualAdmissionAndDispatchRelease:true,offeredDispatchRecordsAndHostMeasurements:'fixtures',
  historicalFailureNotBackfilled:true,newFailureTimeAndReplay:true,preAllocationDemand:true,
  configuredTargetSeparate:true,pagination:true,companyIsolation:true,accessAndBounds:true,noRawErrorsOrCapabilities:true,
  refusedNodePlacement:true,cancelledStillCharged:true,readOnly:true,databaseRestart:true}));
}finally{if(started)docker(['rm','-f',container]);}
