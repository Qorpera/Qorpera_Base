import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testMemberWebOfficeSql } from "./test-member-web-office-sql.mjs";
const root=dirname(dirname(fileURLToPath(import.meta.url))),container=`qorpera-member-office-${randomUUID()}`;
const docker=(args,input)=>{const result=spawnSync("docker",args,{input,encoding:"utf8",timeout:60000,maxBuffer:8*1024**2});assert(!result.error&&result.status===0,`${result.stderr}\n${result.stdout?.slice(-2500)??""}`);return result.stdout.trim();};
const sql=value=>docker(["exec","-i",container,"psql","-X","-qAt","-U","postgres","-d","office","-v","ON_ERROR_STOP=1"],value);
let started=false;
try {
	docker(["run","-d","--rm","--pull","never","--name",container,"--network","none","-e","POSTGRES_PASSWORD=disposable-office","-e","POSTGRES_DB=office",POSTGRES_IMAGE]);started=true;
	let ready=0;for(let i=0;i<60&&ready<2;i++){const result=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d","office"],{timeout:2000});ready=result.status===0?ready+1:0;if(ready<2)await new Promise(resolve=>setTimeout(resolve,500));}assert.equal(ready,2);
	sql(readFileSync(join(root,"supabase/tests/bootstrap.sql"),"utf8"));
	const migrations=sortMigrationNames(readdirSync(join(root,"supabase/migrations")));for(const name of migrations)sql(readFileSync(join(root,"supabase/migrations",name),"utf8"));
	const wake=readFileSync(join(root,"supabase/tests/300_runtime_wake_bus.test.sql"),"utf8").split("-- END WAKE FIXTURE");assert.equal(wake.length,2);
	const office=readFileSync(join(root,"supabase/tests/fixtures/runtime-office-registry-cases.sql"),"utf8").split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");assert.equal(office.length,2);
	sql(`${wake[0]}\n${office[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/member-office-catalog-cases.sql"),"utf8")}\nrollback;`);
	console.log(JSON.stringify({schema:"qorpera.member-office-catalog-sql/v1",migrations:migrations.length,actualAuthority:true,memberOnly:true,removedMemberDenied:true,ownerManagementOnly:true,boundedRoster:true,privateInfrastructureExcluded:true,hosted:false}));
	sql(`${wake[0]}\n${office[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/member-browser-profile-cases.sql"),"utf8")}\nrollback;`);
	console.log(JSON.stringify({schema:"qorpera.member-browser-profiles-sql/v1",migrations:migrations.length,ownerOnly:true,boundedProfiles:true,preparedAfterPrivateAcknowledgement:true,grantVersions:true,removedOwnerCleanup:true,rejoinedConsentNotRevived:true,physicalDrain:"fixture",hosted:false}));
	if(process.env.QORPERA_WEB_OFFICE_TEST_BROWSER) await testMemberWebOfficeSql({root,query:sql,seed:`${wake[0]}\n${office[0]}\nset local role service_role;select pg_temp.office_call('acquire');reset role;commit;`});
}finally{if(started)docker(["rm","-f",container]);}
