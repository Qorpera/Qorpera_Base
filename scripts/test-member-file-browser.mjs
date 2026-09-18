// Offline Chromium proof of shared member file reads and explicit downloads.
// The local HTTP authority/object endpoint is a fixture. No hosted CORS or
// deployment claim; the library must execute without Node globals/polyfills.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const executablePath=process.env.QORPERA_FILE_TEST_BROWSER;
if(!executablePath)throw new Error("Set QORPERA_FILE_TEST_BROWSER to an existing Chromium executable");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const bytes=Buffer.from([0,255,128,13,10,1]),fileSha256=sha(bytes),path="documents/æble.bin";
const manifest=Buffer.from(JSON.stringify({schema:"qorpera.cloud-file-manifest/v1",fileSha256,bytes:bytes.length,
 mediaType:"application/octet-stream",chunks:[{sha256:fileSha256,bytes:bytes.length}]}));
const manifestSha256=sha(manifest),objects=new Map([[manifestSha256,manifest],[fileSha256,bytes]]);
const bundle=await build({absWorkingDir:root,entryPoints:["packages/cloud-client/src/cloud-member-company-file.ts"],bundle:true,write:false,
 platform:"browser",format:"iife",globalName:"QorperaMemberFiles",target:"es2022"});
let state={version:id(3),deny:false,corrupt:false},origin,reads=0,describes=0;
const failures=[];
const server=createServer((req,res)=>{void(async()=>{
 if(req.method==="GET"&&req.url==="/"){res.writeHead(200,{"content-type":"text/html"});res.end('<!doctype html><script src="/client.js"></script>');return;}
 if(req.method==="GET"&&req.url==="/client.js"){res.writeHead(200,{"content-type":"text/javascript"});res.end(bundle.outputFiles[0].text);return;}
 assert.equal(req.headers.authorization,"Bearer member-token");
 if(state.deny){res.writeHead(403);res.end();return;}
 if(req.method==="POST"&&req.url==="/rest/v1/rpc/qorpera_read_company_path"){
  assert.equal(req.headers.apikey,"publishable-fixture");let text="";for await(const chunk of req){text+=chunk;assert(text.length<32768);}
  assert.deepEqual(JSON.parse(text),{p_environment_id:id(2),p_binding:null,p_path:path});describes++;
  res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({companyId:id(1),path,version:state.version,
   entry:{path,kind:"file",executable:false,file:{manifestSha256,fileSha256,bytes:bytes.length,mediaType:"application/octet-stream"}},manifestBytes:manifest.length}));return;
 }
 const prefix=`/v1/member-company-objects/${id(2)}/${id(3)}/`;
 assert.equal(req.method,"GET");assert(req.url.startsWith(prefix));assert.equal(req.headers["x-qorpera-company-path"],Buffer.from(path).toString("base64url"));
 const body=objects.get(req.url.slice(prefix.length));assert(body);reads++;
 const result=state.corrupt?Buffer.alloc(body.length,1):body;
 res.writeHead(200,{"content-type":"application/octet-stream","content-length":String(result.length),"cache-control":"no-store","x-qorpera-access-mode":"live-path-authority"});res.end(result);
 })().catch(error=>{failures.push(error.message);res.writeHead(500);res.end();});});
let browser;
try{
 await new Promise((accept,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",accept);});origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath,headless:true});const context=await browser.newContext();
 await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));await page.goto(origin);
 const selection={realm:"company_file",path,version:id(3)};
 const execute=()=>page.evaluate(async({origin,companyId,environmentId,selection})=>{
  if(typeof Buffer!=="undefined"||typeof process!=="undefined"||!crypto.subtle)throw new Error("Native browser APIs required");
  const reader=new QorperaMemberFiles.CloudMemberCompanyFileReader({companyId,environmentId,supabaseUrl:origin,
   objectGatewayUrl:origin,publishableKey:"publishable-fixture",accessToken:async()=>"member-token"});
  try{const result=await reader.download(selection,new AbortController().signal);return{ok:true,source:result.source,bytes:Array.from(result.bytes)};}
  catch(error){return{ok:false,message:error.message};}
 },{origin,companyId:id(1),environmentId:id(2),selection});
 const result=await execute();assert.equal(result.ok,true,JSON.stringify({result,failures}));assert.deepEqual(result.bytes,Array.from(bytes));
 assert.deepEqual(result.source,{...selection,companyId:id(1),environmentId:id(2),sha256:fileSha256,manifestSha256});
 assert.equal(reads,2);assert.equal(describes,2);
 state.version=id(4);const stale=await execute();assert.equal(stale.ok,false);assert.match(stale.message,/version changed/);assert.equal(reads,2);
 state.version=id(3);state.corrupt=true;const corrupt=await execute();assert.equal(corrupt.ok,false);assert.match(corrupt.message,/integrity/);
 state.corrupt=false;state.deny=true;const revoked=await execute();assert.equal(revoked.ok,false);assert.match(revoked.message,/403/);
 assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({schema:"qorpera.member-file-browser-proof/v1",browser:browser.version(),binaryBytes:bytes.length,
  nodeGlobals:false,actualHttp:true,webCrypto:true,exactVersion:true,sourceHashes:true,staleRejected:true,corruptRejected:true,revokedRejected:true,
  authority:"fixture",hosted:false,hostedCors:false,memberFilesystemAccess:false}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(accept=>server.close(accept));}
