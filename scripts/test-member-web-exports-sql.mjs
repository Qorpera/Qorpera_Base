import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

// Called after real native/SQL/Linux export and Company File publication.
// Actual static web app, Auth SDK, gateway, object bytes, CORS and downloads;
// Auth sessions and the HTTP-to-SQL adapter are disposable fixtures.
export async function testMemberWebExportsSql({root,query,store,replication,companyId,environmentId,asset,bytes}) {
	const executablePath=process.env.QORPERA_WEB_EXPORT_TEST_BROWSER;if(!executablePath)return;
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-web-exports-sql-")),servers=[],assets=new Map(),errors=[],downloads=[],calls=[];
	const memberId="30000000-0000-4000-8000-000000000003",ownerId="30000000-0000-4000-8000-000000000001",expiry=Math.floor(Date.now()/1000)+3600;
	const token=`e30.${Buffer.from(JSON.stringify({sub:memberId,role:"authenticated",aud:"authenticated",exp:expiry})).toString("base64url")}.fixture`,session={access_token:token,refresh_token:"fixture-refresh",token_type:"bearer",expires_in:3600,expires_at:expiry,user:{id:memberId,email:"member@fixture.test",aud:"authenticated",role:"authenticated",app_metadata:{},user_metadata:{},created_at:"2026-09-08T00:00:00Z"}};
	const literal=value=>value===null?"null":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'${typeof value==="object"?"::jsonb":""}`;
	const methods=new Set(["qorpera_list_hosted_profiles","qorpera_member_company_file_mode","qorpera_list_company_paths","qorpera_list_member_company_path_commands","qorpera_list_company_path_proposals","qorpera_member_file_export_source","qorpera_list_member_file_exports","qorpera_remove_profile_member"]);
	const rpc=(method,args,sub=memberId)=>{assert(methods.has(method),method);calls.push(method);const parameters=Object.entries(args).map(([key,value])=>{assert(/^p_[a-z][a-z0-9_]*$/.test(key));return `${key}=>${literal(value)}`;});return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({role:"authenticated",sub})}';set role authenticated;select to_jsonb(public.${method}(${parameters.join(",")}));`));};
	const listen=async server=>{servers.push(server);await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});return `http://127.0.0.1:${server.address().port}`;};
	const get=store.get.bind(store),membership=JSON.parse(query(`select to_jsonb(m) from public.qorpera_profile_members m where profile_id=${literal(companyId)}::uuid and user_id='${memberId}';`));
	const grants=JSON.parse(query(`select coalesce(jsonb_agg(jsonb_build_object('id',grant_id,'state',state)),'[]') from public.qorpera_runtime_office_access where office_id=${literal(asset.source.companyComputerId)}::uuid;`));
	let browser,page,preflights=0,revokeDuringRead=false,revoked=false;
	try {
		const modulePath=join(scratch,"gateway.mjs");await build({absWorkingDir:root,stdin:{resolveDir:root,contents:[
			'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
			'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
			'export {ObjectDependencyError} from "./packages/object-gateway/src/dependency.ts";',
		].join("\n")},bundle:true,platform:"node",format:"esm",target:"node22",outfile:modulePath});const code=await import(pathToFileURL(modulePath).href);
		let csp;const origin=await listen(createServer((request,response)=>{void(async()=>{
			if(request.url==="/favicon.ico"){response.writeHead(204);response.end();return;}
			if(request.method==="GET"&&assets.has(request.url)){const file=assets.get(request.url);response.writeHead(200,{"content-type":file.mime,"content-security-policy":csp,"cache-control":"no-store"});response.end(file.bytes);return;}
			if(request.url?.startsWith("/realtime/")){response.writeHead(503);response.end();return;}
			assert(request.method==="POST"&&request.url.startsWith("/rest/v1/rpc/"));assert.equal(request.headers.authorization,`Bearer ${token}`);assert.equal(request.headers.apikey,"sb_publishable_fixture1");let body="";for await(const chunk of request){body+=chunk;assert(body.length<16384);}const method=request.url.split("/").at(-1);assert.notEqual(method,"qorpera_remove_profile_member");const value=rpc(method,JSON.parse(body));response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(value));
		})().catch(error=>{if(!String(error.message).includes("ERROR:"))errors.push(error.message);response.writeHead(403);response.end();});}));
		const authority={member:async(method,bearer,args)=>{assert.equal(bearer,token);assert(["qorpera_member_file_export_source","qorpera_list_member_file_exports"].includes(method));try{return rpc(method,args);}catch{throw new code.ObjectDependencyError(403);}},publisher:async()=>{throw new Error("Unexpected export mutation");}};
		const objectAuthority=new code.SupabaseObjectAuthority({projectUrl:"https://fixture.invalid",publishableKey:"sb_publishable_fixture1",secretKey:"fixture-secret",fetch:async()=>{throw new Error("Unexpected external object request");}});
		const handler=code.createObjectGatewayHandler({store,replication,authority:objectAuthority,memberFiles:authority,controlToken:"fixture-control",verifierToken:"fixture-verifier",memberClientOrigins:[origin]});
		const objectOrigin=await listen(createServer((request,response)=>{response.once("finish",()=>{if(request.method==="OPTIONS"&&response.statusCode===204)preflights++;});handler(request,response);}));
		store.get=async(...args)=>{const data=await get(...args);if(revokeDuringRead){revokeDuringRead=false;rpc("qorpera_remove_profile_member",{p_profile_id:companyId,p_member_user_id:memberId},ownerId);revoked=true;}return data;};
		const out=join(scratch,"package"),manifest=await packageMemberWeb({root,out,config:{schema:"qorpera.member-web-config/v1",supabaseUrl:origin,publishableKey:"sb_publishable_fixture1",objectGatewayUrl:objectOrigin,officeViewerOrigin:null}});
		for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])assets.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});csp=(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0];
		query(`update public.qorpera_runtime_office_access set state='revoked' where office_id=${literal(asset.source.companyComputerId)}::uuid;`);assert.equal(query("select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"),"0");
		browser=await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});const context=await browser.newContext({acceptDownloads:true,viewport:{width:1360,height:1000}});context.on("request",request=>{if(![origin,objectOrigin].includes(new URL(request.url()).origin))errors.push("Unexpected external request");});page=await context.newPage();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));page.on("download",download=>downloads.push(download));
		await page.goto(origin);await page.getByRole("button",{name:"Continue with Google"}).waitFor();await page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session);
		await page.getByRole("button",{name:"Path gateway fixture · Environment",exact:true}).click();await page.getByRole("heading",{name:"Company root",exact:true}).waitFor();await page.getByRole("button",{name:"Browse exports",exact:true}).click();const download=page.getByRole("button",{name:`${asset.source.path} · ${asset.bytes.toLocaleString()} bytes · Download…`,exact:true});await download.waitFor();assert.equal(downloads.length,0);const before=calls.filter(method=>method==="qorpera_member_file_export_source").length;
		await download.click();await page.getByRole("status").filter({hasText:"Shared export handed to your browser."}).waitFor();assert.equal(downloads.length,1);assert.deepEqual(await readFile(await downloads[0].path()),Buffer.from(bytes));
		// Both client and gateway reauthorize before and after reading bytes.
		assert.equal(calls.filter(method=>method==="qorpera_member_file_export_source").length-before,4);
		if(process.env.QORPERA_WEB_EXPORT_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_EXPORT_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_EXPORT_PROOF_OUTPUT,"member-web-shared-export.png"),fullPage:true});}
		revokeDuringRead=true;await download.click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();assert.equal(revoked,true);assert.equal(downloads.length,1);await page.getByRole("button",{name:"Companies",exact:true}).click();await page.getByText("No companies are available for this account.",{exact:true}).waitFor();assert(preflights>0);assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.member-web-exports-sql/v1",browser:browser.version(),actualStaticPackage:true,browserInputs:manifest.browserInputs.length,actualAuthSdk:true,actualSqlAuthority:true,actualNativeExportReceipt:true,actualLinuxSource:true,actualGateway:true,actualDiskStore:true,actualReplicationJournal:true,nativePreflights:preflights,nonEmptyExportDiscovery:true,explicitDownload:true,exactBinaryBytes:bytes.length,readOnlyMember:true,closedOfficeConnection:true,revokedOfficeGrant:true,removedMemberDuringReadDenied:true,noDownloadAfterRevocation:true,authSessions:"fixture",sqlHttpTransport:"fixture",officeMountAdmission:"fixture",hosted:false,nas:false,electron:false}));
	}catch(error){console.error(JSON.stringify({errors,calls,text:await page?.locator("body").innerText().catch(()=>"closed")}));throw error;}
	finally{store.get=get;await browser?.close();for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}for(const grant of grants)query(`update public.qorpera_runtime_office_access set state=${literal(grant.state)} where grant_id=${literal(grant.id)}::uuid;`);query(`insert into public.qorpera_profile_members select * from jsonb_populate_record(null::public.qorpera_profile_members,${literal(membership)}) on conflict do nothing;`);await rm(scratch,{recursive:true,force:true});}
}
