// Exact new SQL reason validator versus JavaScript contract semantics; fixture-only PostgreSQL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { POSTGRES_IMAGE } from "./test-hosted-db.mjs";
const container=`qorpera-delete-reason-${randomBytes(6).toString("hex")}`;
const migration=readFileSync(new URL("../supabase/migrations/20260913010000_runtime_office_delete_administrative_disposition.sql",import.meta.url),"utf8");
const helper=migration.match(/create function public\.qorpera_office_delete_reason_valid\(v jsonb\)[\s\S]*?\n\$\$;/)?.[0];
assert(helper,"Exact reason helper unavailable");
const docker=(args,input)=>{const r=spawnSync("docker",args,{input,encoding:"utf8",timeout:60000,maxBuffer:1048576});assert(!r.error&&r.status===0,r.stderr||String(r.error));return r.stdout.trim();};
const ws=[9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279];
const cases=[null,{},7,"","ASCII operator reason","valid reason","v","f","t","a".repeat(512),"a".repeat(513),"😀".repeat(256),"😀".repeat(257),"😀".repeat(300),"a".repeat(510)+"😀","a".repeat(511)+"😀","a\u0085b","\u0085",...ws.flatMap(c=>{const x=String.fromCodePoint(c);return [x+"reason","reason"+x,"a"+x+"b"];}),"a\x01b","a\x7fb"];
const valid=v=>typeof v==="string"&&v.length>=1&&v.length<=512&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const lit=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
let started=false;
try{
 docker(["run","--rm","-d","--network","none","--pull","never","--name",container,"--tmpfs","/var/lib/postgresql/data:rw,size=128m","-e","POSTGRES_PASSWORD=local-fixture-only",POSTGRES_IMAGE]);started=true;
 let ready=false;
 for(let i=0;i<80;i++){const r=spawnSync("docker",["logs",container],{encoding:"utf8",timeout:2000,maxBuffer:1048576});if((r.stdout+r.stderr).includes("PostgreSQL init process complete")&&spawnSync("docker",["exec",container,"pg_isready","-U","postgres"],{timeout:2000}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,250));}
 assert(ready,"Disposable PostgreSQL not ready");
 const rows=cases.map((v,i)=>`(${i},${lit(v)},${valid(v)})`).join(",");
 const query=helper+`\nselect coalesce(jsonb_agg(jsonb_build_object('i',i,'v',v,'expected',expected,'actual',public.qorpera_office_delete_reason_valid(v))),'[]'::jsonb) from (values ${rows}) as fixture(i,v,expected) where coalesce(public.qorpera_office_delete_reason_valid(v),false) is distinct from expected;`;
 assert.equal(docker(["exec","-i",container,"psql","-X","-qAt","-U","postgres","-v","ON_ERROR_STOP=1"],query),"[]");
 console.log(JSON.stringify({schema:"qorpera.office-delete-reason-parity/v1",passed:true,cases:cases.length,actualPostgresql17:true,expectedSemantics:"JavaScript UTF16 length, trim, ASCII controls",liveAccess:false}));
}finally{if(started)docker(["rm","-f","-v",container]);}
