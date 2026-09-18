import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { FileSystemObjectStore } from "../packages/object-gateway/src/object-store.ts";
import { createObjectGatewayHandler } from "../packages/object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../packages/object-gateway/src/supabase-authority.ts";

/** Run after committing the isolated 340 SQL fixture to a disposable database.
 * Real Chromium/CORS, shared browser SDK, gateway, disk and current SQL policy;
 * the small auth/RPC transport is fixture-only and admits three named RPCs. */
export async function testMemberSnapshotSql({ root, query, executablePath }) {
 const companyId = "34000000-0000-4000-8000-000000000010", environmentId = "34000000-0000-4000-8000-000000000020";
 const user = n => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
 const snapshotId = query(`select s.id from public.qorpera_company_snapshots s join public.qorpera_company_snapshot_publications p on p.snapshot_id=s.id and p.status='published' where s.environment_id='${environmentId}' order by s.created_at,s.id limit 1;`);
 assert.match(snapshotId, /^[0-9a-f-]{36}$/);
 const bytes = Buffer.from("Human snapshot fixture"), hash = value => createHash("sha256").update(value).digest("hex");
 const manifest = Buffer.from(query(`select jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256','${hash(bytes)}','bytes',${bytes.length},'mediaType','application/octet-stream','chunks',jsonb_build_array(jsonb_build_object('sha256','${hash(bytes)}','bytes',${bytes.length})))::text;`));
 const methods = new Set(["qorpera_list_member_company_snapshot_paths", "qorpera_read_member_company_snapshot_path", "qorpera_authorize_member_company_snapshot_object"]);
 const calls = [], failures = [], servers = [];
 const literal = value => value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
 function rpc(method, args, bearer) {
  assert(methods.has(method));
  const member = [1,2,3].find(n => bearer === `Bearer member-${n}`);
  assert(member);
  calls.push({method, member});
  const params = Object.entries(args).map(([key,value]) => { assert(/^p_[a-z][a-z0-9_]*$/.test(key)); return `${key}=>${literal(value)}`; });
  return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({role:"authenticated",sub:user(member)})}';set role authenticated; select public.${method}(${params.join(",")});`));
 }
 const listen = async server => { servers.push(server); await new Promise(resolve => server.listen(0,"127.0.0.1",resolve)); return `http://127.0.0.1:${server.address().port}`; };
 const scratch = await mkdtemp(join(tmpdir(),"qorpera-snapshot-sql-"));
 let browser;
 try {
  const store = new FileSystemObjectStore(scratch);
  await store.put(companyId,hash(bytes),bytes);
  await store.put(companyId,hash(manifest),manifest);
  let revoke = false, revoked = false, preflights = 0;
  const get = store.get.bind(store);
  store.get = async (...args) => {
   const result = await get(...args);
   if (revoke) {
    revoke = false;
    query(`delete from public.qorpera_profile_members where profile_id='${companyId}' and user_id='${user(2)}';`);
    revoked = true;
   }
   return result;
  };
  const authority = new SupabaseObjectAuthority({ projectUrl:"https://sql.fixture.invalid",publishableKey:"fixture-publishable",secretKey:"fixture-service",
   fetch: async (input,init) => {
    try {
     const url = new URL(String(input));
     assert.equal(url.origin,"https://sql.fixture.invalid");
     assert.equal(new Headers(init.headers).get("apikey"),"fixture-publishable");
     return Response.json(rpc(url.pathname.split("/").at(-1),JSON.parse(init.body),new Headers(init.headers).get("authorization")));
    } catch(error) { if (!error.message.includes("ERROR:")) failures.push(error.message); return Response.json({}, {status:403}); }
   }
  });
  const bundle = await build({absWorkingDir:root,stdin:{resolveDir:root,contents:'import {CloudMemberCompanyFileReader} from "./packages/cloud-client/src/cloud-member-company-file.ts"; globalThis.SnapshotReader=CloudMemberCompanyFileReader;'},bundle:true,write:false,platform:"browser",format:"esm",target:"es2022"});
  const appOrigin = await listen(createServer((request,response) => { void (async () => {
   if(request.url === "/") { response.writeHead(200,{"content-type":"text/html"});response.end('<script type="module" src="/reader.js"></script>');return; }
   if(request.url === "/reader.js") { response.writeHead(200,{"content-type":"text/javascript"});response.end(bundle.outputFiles[0].contents);return; }
   if(request.url === "/favicon.ico") { response.writeHead(204);response.end();return; }
   assert.equal(request.method,"POST");assert(request.url.startsWith("/rest/v1/rpc/"));
   assert.equal(request.headers.apikey,"fixture-publishable");
   let body="";for await(const chunk of request){ body+=chunk;assert(body.length<16384); }
   const result=rpc(request.url.split("/").at(-1),JSON.parse(body),request.headers.authorization);
   response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify(result));
  })().catch(error => { if(!error.message.includes("ERROR:"))failures.push(error.message);response.writeHead(403);response.end(); }); }));
  const handler = createObjectGatewayHandler({store,authority,memberObjects:authority,controlToken:"fixture-control",verifierToken:"fixture-verifier",memberClientOrigins:[appOrigin]});
  const gatewayOrigin = await listen(createServer((request,response) => { response.once("finish",()=>{ if(request.method==="OPTIONS"&&response.statusCode===204)preflights++; });handler(request,response); }));
  browser = await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
  const page = await browser.newPage();
  page.on("pageerror", error => failures.push(error.message));
  await page.goto(appOrigin);await page.waitForFunction(()=>!!globalThis.SnapshotReader);
  const options={companyId,environmentId,snapshotId,supabaseUrl:appOrigin,objectGatewayUrl:gatewayOrigin,publishableKey:"fixture-publishable"};
  for(const member of [1,2,3]) {
   const result=await page.evaluate(async ({options,member})=>{
    const reader=new globalThis.SnapshotReader({...options,accessToken:async()=>`member-${member}`});
    const signal=new AbortController().signal;
    const entries=await reader.listSnapshotEntries(signal);
    const file=await reader.read("note.md",signal);
    return {paths:entries.map(entry=>entry.path),version:file.version,text:new TextDecoder().decode(file.bytes)};
   },{options,member});
   assert.deepEqual(result,{paths:["note.md"],version:snapshotId,text:bytes.toString()});
  }
  // The current canonical head differs, while all three humans saw the old bytes.
  assert.notEqual(query(`select head_snapshot_id from public.qorpera_company_files where environment_id='${environmentId}';`),snapshotId);
  revoke=true;
  const denied=await page.evaluate(async options=>{
   const reader=new globalThis.SnapshotReader({...options,accessToken:async()=>"member-2"});
   try { await reader.read("note.md",new AbortController().signal);return false; } catch { return true; }
  },options);
  assert(denied&&revoked);
  assert(preflights>=7);
  assert.deepEqual(failures,[]);
  const receipt={schema:"qorpera.member-snapshot-sql/v1",passed:true,browser:browser.version(),realSql:true,realGateway:true,realDiskStore:true,realBrowserSdk:true,nativeCorsPreflights:preflights,ownerContributorViewerReadOldVersion:true,headAdvanced:true,revokedDuringStorageReadDenied:true,authorityCalls:calls.length,fixtureAuth:true,fixtureSqlHttpTransport:true,hosted:false,nas:false,fullProductWeb:false};
  console.log(JSON.stringify(receipt));return receipt;
 } catch (error) {
  console.error(JSON.stringify({failures,calls}));throw error;
 } finally {
  await browser?.close();
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(scratch,{recursive:true,force:true});
 }
}
