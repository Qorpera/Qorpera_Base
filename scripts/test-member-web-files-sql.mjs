import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

/** Actual static web entry + SQL + gateway/disk/journal, with fixture Auth
 * sessions and a closed RPC transport to a disposable PostgreSQL container. */
export async function testMemberWebFilesSql({root,query,seed}) {
	const executablePath=process.env.QORPERA_WEB_SQL_TEST_BROWSER;assert(executablePath);query(seed);
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-web-files-sql-")),servers=[],failures=[],calls=[],assets=new Map();let browser,page;
	const companyId="29500000-0000-4000-8000-000000000010",environmentId="29500000-0000-4000-8000-000000000020",user=n=>`29500000-0000-4000-8000-${String(n).padStart(12,"0")}`;
	const expiry=Math.floor(Date.now()/1000)+3600,token=n=>`e30.${Buffer.from(JSON.stringify({sub:user(n),role:"authenticated",aud:"authenticated",exp:expiry})).toString("base64url")}.fixture`;
	const session=n=>({access_token:token(n),refresh_token:`fixture-refresh-${n}`,token_type:"bearer",expires_in:3600,expires_at:expiry,user:{id:user(n),email:`member-${n}@fixture.test`,aud:"authenticated",role:"authenticated",app_metadata:{},user_metadata:{},created_at:"2026-09-08T00:00:00Z"}});
	const memberId=value=>{const id=[1,2,3].find(n=>value===token(n));assert(id,"Unknown fixture member");return user(id);};
	const sql=value=>value===null?"null":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'${typeof value==="object"?"::jsonb":""}`;
	const memberMethods=new Set(["qorpera_list_hosted_profiles","qorpera_member_company_file_mode","qorpera_list_company_paths","qorpera_read_company_path","qorpera_list_member_company_path_commands","qorpera_list_company_path_proposals","qorpera_member_office_catalog","qorpera_list_member_file_exports","qorpera_member_browser_recovery","qorpera_remove_profile_member","qorpera_set_company_path_resource","qorpera_authorize_member_company_path_object","qorpera_begin_member_company_file_upload","qorpera_begin_member_company_path_command","qorpera_get_member_company_path_command","qorpera_review_member_company_path_command","qorpera_authorize_member_company_command_object","qorpera_company_presence_scope"]);
	const publisherMethods=new Set(["qorpera_stage_member_company_path_object","qorpera_verify_company_path_file","qorpera_prepare_member_company_path_command","qorpera_verify_company_path_tree","qorpera_apply_member_company_path_command_v3"]);
	function rpc(method,args,role,sub){
		assert((role==="authenticated"?memberMethods:publisherMethods).has(method),method);calls.push({method,args,role,sub});
		const parameters=Object.entries(args).map(([key,value])=>{assert(/^p_[a-z][a-z0-9_]*$/.test(key));return `${key}=>${sql(value)}`;});
		return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({role,...(sub?{sub}:{})})}';set role ${role};select to_jsonb(public.${method}(${parameters.join(",")}));`)||"null");
	}
	const listen=async server=>{servers.push(server);await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});return `http://127.0.0.1:${server.address().port}`;};
	try {
		const modulePath=join(scratch,"gateway.mjs");
		await build({absWorkingDir:root,stdin:{resolveDir:root,contents:[
			'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
			'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
			'export {ObjectGatewayReplication} from "./packages/object-gateway/src/replication.ts";',
			'export {ObjectGatewayJournal} from "./packages/object-gateway/src/journal.ts";',
			'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
			'export {SupabaseMemberCompanyAuthority} from "./packages/object-gateway/src/member-company-authority.ts";',
		].join("\n")},platform:"node",format:"esm",target:"node22",bundle:true,outfile:modulePath});
		const code=await import(pathToFileURL(modulePath).href);
		let loseApplied=true,lostReplies=0,revokeDuringRead=false,revokedDuringRead=false;
		const rpcFetch=async(url,init)=>{
			assert(String(url).startsWith("https://sql.fixture.invalid/rest/v1/rpc/"));const headers=new Headers(init.headers),publisher=headers.get("apikey")==="fixture-publisher";
			try{
				const method=String(url).split("/").at(-1),value=rpc(method,JSON.parse(init.body),publisher?"service_role":"authenticated",publisher?null:memberId(headers.get("authorization")?.slice(7)));
				if(loseApplied&&method==="qorpera_apply_member_company_path_command_v3"){loseApplied=false;lostReplies++;return new Response(null,{status:503});}
				return Response.json(value);
			}catch(error){if(!String(error.message).includes("ERROR:")){failures.push(error.message);}return Response.json({code:"42501"},{status:403});}
		};
		const settings={projectUrl:"https://sql.fixture.invalid",publishableKey:"sb_publishable_fixture1",secretKey:"fixture-publisher",fetch:rpcFetch};
		const authority=new code.SupabaseMemberCompanyAuthority(settings),objectAuthority=new code.SupabaseObjectAuthority(settings),store=new code.FileSystemObjectStore(join(scratch,"objects"));
		const replication=new code.ObjectGatewayReplication(new code.ObjectGatewayJournal(join(scratch,"journal")),store,objectAuthority);
		const get=store.get.bind(store);store.get=async(...args)=>{const bytes=await get(...args);if(revokeDuringRead){revokeDuringRead=false;rpc("qorpera_remove_profile_member",{p_profile_id:companyId,p_member_user_id:user(2)},"authenticated",user(1));revokedDuringRead=true;}return bytes;};
		let csp;
		const appOrigin=await listen(createServer((request,response)=>{void(async()=>{
			if(request.url==="/favicon.ico"){response.writeHead(204);response.end();return;}
			if(request.method==="GET"&&assets.has(request.url)){const file=assets.get(request.url);response.writeHead(200,{"content-type":file.mime,"content-security-policy":csp,"cache-control":"no-store","x-content-type-options":"nosniff"});response.end(file.bytes);return;}
			if(request.url?.startsWith("/realtime/")){response.writeHead(503);response.end();return;}
			assert(request.method==="POST"&&request.url?.startsWith("/rest/v1/rpc/"));assert.equal(request.headers.apikey,"sb_publishable_fixture1");
			let body="";for await(const chunk of request){body+=chunk;assert(body.length<16384);}const value=rpc(request.url.split("/").at(-1),JSON.parse(body),"authenticated",memberId(request.headers.authorization?.slice(7)));
			response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify(value));
		})().catch(error=>{if(!String(error.message).includes("ERROR:"))failures.push(error.message);response.writeHead(403);response.end();});}));
		let preflights=0;const handler=code.createObjectGatewayHandler({store,authority:objectAuthority,memberObjects:objectAuthority,memberFiles:authority,replication,memberClientOrigins:[appOrigin],controlToken:"fixture-control",verifierToken:"fixture-verifier"});
		const gatewayOrigin=await listen(createServer((request,response)=>{response.once("finish",()=>{if(request.method==="OPTIONS"&&response.statusCode===204)preflights++;});handler(request,response);}));
		const out=join(scratch,"package"),manifest=await packageMemberWeb({root,out,config:{schema:"qorpera.member-web-config/v1",supabaseUrl:appOrigin,publishableKey:"sb_publishable_fixture1",objectGatewayUrl:gatewayOrigin,officeViewerOrigin:null}});
		for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])assets.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});
		csp=(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0];
		browser=await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});const context=await browser.newContext({acceptDownloads:true,viewport:{width:1360,height:1000}});
		// Do not intercept browser requests: Chromium must perform native CORS preflights.
		context.on("request",request=>{if(![appOrigin,gatewayOrigin].includes(new URL(request.url()).origin))failures.push("Unexpected external request");});
		page=await context.newPage();const errors=[],downloads=[];page.on("pageerror",error=>errors.push(error.message));page.on("download",download=>downloads.push(download));page.on("dialog",dialog=>dialog.accept());
		await page.goto(appOrigin);await page.getByRole("button",{name:"Continue with Google"}).waitFor();
		const switchAccount=async n=>{await page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session(n));await page.getByRole("button",{name:"Path gateway fixture · Environment",exact:true}).click();await page.getByRole("heading",{name:"Company root",exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector("main").inert);};
		await switchAccount(1);
		await page.getByLabel("Company path",{exact:true}).fill("web-note.md");await page.getByRole("button",{name:"Open",exact:true}).click();await page.getByLabel("File content").fill("Actual SQL and member gateway\n");
		await page.getByRole("button",{name:"Save to company",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();
		// Exercise the real dependency circuit's five-second cooldown before
		// the member explicitly retries the same retained operation.
		await page.waitForTimeout(5100);await page.getByRole("button",{name:"Retry this exact save"}).click();await page.getByRole("status").filter({hasText:"Saved to the live company"}).waitFor();assert.equal(lostReplies,1);
		assert.equal(query(`select count(*) from public.qorpera_company_path_revisions where environment_id='${environmentId}' and change#>>'{plan,path}'='web-note.md';`),"1");
		rpc("qorpera_set_company_path_resource",{p_environment_id:environmentId,p_path:"protected.bin",p_path_match:"exact",p_scope:"company_shared",p_policy:"protected"},"authenticated",user(1));
		const bytes=Buffer.from([0,255,128,13,10,1]);await page.getByLabel("Select a file to upload").setInputFiles({name:"protected.bin",mimeType:"application/octet-stream",buffer:bytes});
		await page.getByRole("button",{name:"Check destination",exact:true}).click();await page.getByRole("button",{name:"Upload to company",exact:true}).click();await page.getByRole("heading",{name:"Review exact change"}).waitFor();
		assert.equal(query(`select count(*) from public.qorpera_company_path_entries where environment_id='${environmentId}' and path='protected.bin' and entry is not null;`),"0");
		await page.getByRole("button",{name:"Download proposed file…"}).click();await page.getByRole("status").filter({hasText:"Proposed file handed"}).waitFor();assert.deepEqual(await readFile(await downloads.at(-1).path()),bytes);
		await page.getByRole("button",{name:"Apply exact change…"}).click();await page.getByRole("status").filter({hasText:"Applied the exact"}).waitFor();
		const upload=JSON.parse(query(`select jsonb_build_object('source',u.source,'state',c.status,'plan',c.plan) from public.qorpera_member_company_file_uploads u join public.qorpera_member_company_path_commands c on c.id=u.command_id where c.plan->>'path'='protected.bin';`));assert.equal(upload.state,"applied");assert.equal(upload.source.sha256,createHash("sha256").update(bytes).digest("hex"));
		await page.getByRole("button",{name:"Download…",exact:true}).first().click();await page.getByRole("status").filter({hasText:"Download handed"}).waitFor();assert.deepEqual(await readFile(await downloads.at(-1).path()),bytes);
		await page.getByRole("button",{name:"Browse exports",exact:true}).click();await page.waitForFunction(()=>!document.querySelector("main").inert);assert(calls.some(call=>call.method==="qorpera_list_member_file_exports"));
		await page.getByRole("button",{name:"Company Computer",exact:true}).click();await page.getByText("A shared computer has not been provisioned for this company.",{exact:true}).waitFor();
		await page.getByRole("button",{name:"Browser access cleanup",exact:true}).click();await page.getByText("No browser profiles or private sessions need cleanup.",{exact:true}).waitFor();
		await switchAccount(3);await page.getByRole("button",{name:"web-note.md",exact:true}).click();assert.equal(await page.getByRole("button",{name:"Save to company",exact:true}).isDisabled(),true);
		const forged=await page.evaluate(async({gatewayOrigin,environmentId})=>{const session=JSON.parse(localStorage.getItem("qorpera.member-web.auth"));const response=await fetch(`${gatewayOrigin}/v1/member-company-file/${environmentId}/edits`,{method:"POST",headers:{authorization:`Bearer ${session.access_token}`,"content-type":"application/json"},body:JSON.stringify({operation:"write",operationKey:"viewer-forged",path:"viewer.txt",expectedVersion:null,text:"denied"})});return response.status;},{gatewayOrigin,environmentId});assert.equal(forged,403);
		await switchAccount(2);await page.getByRole("button",{name:"web-note.md",exact:true}).click();
		if(process.env.QORPERA_WEB_SQL_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_SQL_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_SQL_PROOF_OUTPUT,"member-web-real-sql.png"),fullPage:true});}
		const count=downloads.length;revokeDuringRead=true;await page.getByRole("button",{name:"Download…",exact:true}).first().click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();assert.equal(revokedDuringRead,true);assert.equal(downloads.length,count);
		await page.getByRole("button",{name:"Companies",exact:true}).click();await page.getByText("No companies are available for this account.",{exact:true}).waitFor();
		assert(preflights>=6);assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
		console.log(JSON.stringify({schema:"qorpera.member-web-files-sql/v1",browser:browser.version(),actualStaticPackage:true,actualAuthSdk:true,actualSqlAuthority:true,actualGateway:true,actualDiskStore:true,actualReplicationJournal:true,actualNativeCors:true,preflights,browserInputs:manifest.browserInputs.length,companyDiscovery:true,exactLostEditRecovered:true,oneRevision:true,protectedBinaryUpload:true,pendingBinaryDownload:true,exactHumanApproval:true,verifiedLiveDownload:true,viewerMutationDenied:true,removedMemberDuringReadDenied:true,noDownloadAfterRevocation:true,officeDiscovery:true,accountCleanupDiscovery:true,emptyExportDiscovery:true,authSession:"fixture",sqlHttpTransport:"fixture",initialSnapshotStorage:"catalog-fixture",hosted:false,nas:false,physicalOffice:false}));
	}catch(error){console.error(JSON.stringify({failures,page:await page?.locator("body").innerText().catch(()=>"closed")}));throw error;}
	finally{await browser?.close();for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(scratch,{recursive:true,force:true});}
}
