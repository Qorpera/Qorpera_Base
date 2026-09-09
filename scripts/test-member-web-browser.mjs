// Real static package, Auth SDK, HTTP, DOM, chooser, Web Crypto and downloads.
// Auth, control authority and object endpoints below are disposable fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const expiresAt = Math.floor(Date.now()/1000)+3600;
const token = n => `e30.${Buffer.from(JSON.stringify({ sub:id(n), role:"authenticated", aud:"authenticated", exp:expiresAt })).toString("base64url")}.fixture`;
const session = n => ({ access_token:token(n), refresh_token:`fixture-refresh-${n}`, token_type:"bearer", expires_in:3600, expires_at:Math.floor(Date.now()/1000)+3600, user:{ id:id(n), email:`member-${n}@fixture.test`, aud:"authenticated", role:"authenticated", app_metadata:{}, user_metadata:{}, created_at:"2026-09-08T00:00:00Z" } });
const objects = new Map(), files = new Map(), commands = new Map(), proposals = new Map(), staticFiles = new Map();
let counter = 40;
function file(path, bytes) {
	const data=Buffer.from(bytes), digest=sha(data), manifest=Buffer.from(JSON.stringify({schema:"qorpera.cloud-file-manifest/v1",fileSha256:digest,bytes:data.length,mediaType:"application/octet-stream",chunks:data.length?[{sha256:digest,bytes:data.length}]:[]}));
	objects.set(digest,data);objects.set(sha(manifest),manifest);
	return {path,bytes:data,version:id(++counter),manifestBytes:manifest.length,entry:{path,kind:"file",executable:false,file:{manifestSha256:sha(manifest),fileSha256:digest,bytes:data.length,mediaType:"application/octet-stream"}}};
}
const original=file("notes.txt",Buffer.from("Original company notes\n"));files.set(original.path,original);
const proposed=file("proposal.bin",Buffer.from([0,255,128,13,10]));
const proposal={proposalId:id(31),plan:{schema:"qorpera.company-path-mutation/v1",operationKey:"native-proposal-fixture",path:proposed.path,expectedVersion:null,entry:proposed.entry},planSha256:"a".repeat(64),state:"open",snapshotId:null};proposals.set(proposal.proposalId,{value:proposal,file:proposed});
const scope={companyId:id(10),environmentId:id(11),companyComputerId:id(12),logicalComputerId:id(13)};
let startIntent=null,accessGrant=null,loseStart=true,loseGrant=true,loseUpload=true,loseEdit=true,mode="governed",corrupt=false,holdObjects=false,releaseObjects;
const calls=[], failures=[];
const profiles=[];
const scratch=await mkdtemp(join(tmpdir(),"qorpera-member-web-browser-"));let browser;
const server=createServer((req,res)=>{void(async()=>{
	const url=new URL(req.url,"http://127.0.0.1"), path=url.pathname;
	if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
	if(req.method==="GET"&&staticFiles.has(path)){const file=staticFiles.get(path);res.writeHead(200,{"content-type":file.mime,"content-security-policy":staticFiles.get("CSP"),"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(file.bytes);return;}
	if(path.startsWith("/realtime/")){res.writeHead(503);res.end();return;}
	if(path.startsWith("/auth/v1/")){
		calls.push({method:path});
		if(path==="/auth/v1/logout"){res.writeHead(204);res.end();return;}
		if(path==="/auth/v1/otp"){res.writeHead(200,{"content-type":"application/json"});res.end("{}");return;}
	}
	const member=[1,2].find(n=>req.headers.authorization===`Bearer ${token(n)}`); assert(member,"fixture member token required");
	const json=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value));};
	let raw=Buffer.alloc(0);for await(const chunk of req){raw=Buffer.concat([raw,chunk]);assert(raw.length<=8*1024*1024);}
	if(path.startsWith("/rest/v1/rpc/")){
		assert.equal(req.headers.apikey,"sb_publishable_fixture1");const method=path.split("/").at(-1),args=JSON.parse(raw.toString());calls.push({method,args,member});
		if(method==="qorpera_list_hosted_profiles")return json([{profile_id:id(member===1?10:20),environment_id:id(member===1?11:21),profile_name:`Company ${member===1?"Alpha":"Beta"}`,environment_name:"Main",role:"owner",contract_version:1,created_at:"2026-09-08T00:00:00Z",bootstrap_state:"completed"}]);
		if(method==="qorpera_member_browser_recovery")return json({memberId:id(member),offices:[],nextAfter:null});
		assert.equal(member,1); if("p_environment_id" in args)assert.equal(args.p_environment_id,id(11));
		if(method==="qorpera_member_company_file_mode")return json({companyId:id(10),environmentId:id(11),mode});
		if(method==="qorpera_list_company_paths")return json({snapshotId:id(30),items:[...files.values()].filter(file=>!file.path.includes("/")).sort((a,b)=>a.path.localeCompare(b.path)).map(file=>({path:file.path,version:file.version,kind:"file",bytes:file.bytes.length})),hasMore:false,nextAfter:null});
		if(method==="qorpera_read_company_path"){const selected=files.get(args.p_path);return json({companyId:id(10),path:args.p_path,version:selected?.version??null,entry:selected?.entry??null,manifestBytes:selected?.manifestBytes??null});}
		if(method==="qorpera_list_member_company_path_commands")return json({items:[...commands.values()].map(row=>row.value).filter(row=>row.state==="review_required"),nextAfter:null});
		if(method==="qorpera_list_company_path_proposals")return json({items:[...proposals.values()].map(row=>row.value).filter(row=>row.state==="open"),nextAfter:null});
		if(method==="qorpera_member_office_catalog")return json({companyId:id(10),environmentId:id(11),canManage:true,scope,staff:[{staffAgentId:id(14),name:"Research assistant"}],nextAfter:null});
		if(method==="qorpera_runtime_office_start_status")return json({scope,computerGeneration:1,officeState:"provisioning",intent:startIntent});
		if(method==="qorpera_request_runtime_office_start"){startIntent??={schema:"qorpera.office-start-intent/v1",intentId:args.p_request_id,companyComputerId:id(12),computerGeneration:1,state:"requested"};if(loseStart){loseStart=false;res.writeHead(503);res.end();return;}return json(startIntent);}
		if(method==="qorpera_cancel_runtime_office_start"){startIntent.state="cancelled";return json(startIntent);}
		if(method==="qorpera_runtime_office_access_status")return json({schema:"qorpera.office-access-status/v1",scope,staffAgentId:id(14),grant:accessGrant});
		if(method==="qorpera_configure_runtime_office_access"){
			assert.equal(args.p_expected_version,accessGrant?.version??0);accessGrant={grantId:id(15),version:(accessGrant?.version??0)+1,state:args.p_enabled?"active":"revoked",capabilities:args.p_capabilities};
			if(loseGrant){loseGrant=false;res.writeHead(503);res.end();return;}return json({schema:"qorpera.office-access-status/v1",scope,staffAgentId:id(14),grant:accessGrant});
		}
		if(method==="qorpera_runtime_office_privacy_status")return json({scope,computerGeneration:1,state:"shared",version:0,challenge:null});
		if(method==="qorpera_member_browser_profiles")return json({scope,memberId:id(1),canUse:true,profiles,nextAfter:null});
		if(method==="qorpera_create_member_browser_profile"){const profile={profileId:args.p_profile_id,label:args.p_label,version:1,prepared:false,activeStaffAgentId:null};profiles.push(profile);return json(profile);}
		if(method==="qorpera_member_browser_grant_status")return json({scope,memberId:id(1),staffAgentId:id(14),profile:profiles.find(profile=>profile.profileId===args.p_profile_id),grant:null});
		throw new Error(`Unexpected RPC ${method}`);
	}
	if(path.startsWith("/v1/member-company-objects/")){
		assert.equal(member,1);const requested=objects.get(path.split("/").at(-1));assert(requested);
		if(holdObjects){holdObjects=false;await new Promise(resolve=>{releaseObjects=resolve;});}
		res.writeHead(200,{"content-type":"application/octet-stream","x-qorpera-access-mode":"live-path-authority"});res.end(corrupt?Buffer.alloc(requested.length,1):requested);return;
	}
	const prefix=`/v1/member-company-file/${id(11)}/`;assert(path.startsWith(prefix));assert.equal(member,1);const target=path.slice(prefix.length);
	if(target==="uploads"||target==="edits"){
		const upload=target==="uploads",input=upload?JSON.parse(Buffer.from(req.headers["x-qorpera-company-upload"],"base64url")):JSON.parse(raw.toString());
		calls.push({method:target,input,bytes:Array.from(raw)});
		let command=[...commands.values()].find(row=>row.value.plan.operationKey===input.operationKey);
		if(!command){
			const selected=input.operation==="delete"?null:file(input.path,upload?raw:Buffer.from(input.text));
			const plan={schema:"qorpera.company-path-mutation/v1",operationKey:input.operationKey,path:input.path,expectedVersion:input.expectedVersion,entry:selected?.entry??null};
			const value={commandId:id(++counter),companyId:id(10),environmentId:id(11),plan,planSha256:sha(JSON.stringify(plan)),state:upload?"review_required":"applied",expiresAt:"2099-01-01T00:00:00Z",result:upload?null:{state:"applied",path:input.path,operationKey:input.operationKey,snapshotId:id(30),version:id(++counter)}};
			command={value,file:selected};commands.set(value.commandId,command);
			if(!upload){if(selected)files.set(input.path,selected);else files.delete(input.path);}
		}
		if(upload?loseUpload:loseEdit){if(upload)loseUpload=false;else loseEdit=false;res.writeHead(503);res.end();return;}return json(command.value);
	}
	const [kind,commandId,operation]=target.split("/"),command=(kind==="edits"?commands:proposals).get(commandId);assert(command);
	if(operation==="file"){res.writeHead(200,{"content-type":"application/octet-stream","x-qorpera-plan-sha256":command.value.planSha256});res.end(command.file.bytes);return;}
	if(operation==="review"){
		const review=JSON.parse(raw.toString());assert.equal(review.planSha256,command.value.planSha256);calls.push({method:"review",kind,commandId,...review});
		if(review.decision==="approve") {command.value.state="applied";files.set(command.value.plan.path,command.file);if(kind==="edits")command.value.result={state:"applied",path:command.value.plan.path,operationKey:command.value.plan.operationKey,snapshotId:id(30),version:command.file.version};else command.value.snapshotId=id(30);}
		else command.value.state="rejected";
		return json(command.value);
	}
	throw new Error(`Unexpected endpoint ${path}`);
})().catch(error=>{failures.push(error.message);res.writeHead(500);res.end();});});
try {
	await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const origin=`http://127.0.0.1:${server.address().port}`;
	const config={schema:"qorpera.member-web-config/v1",supabaseUrl:origin,publishableKey:"sb_publishable_fixture1",objectGatewayUrl:origin,officeViewerOrigin:null};
	const out=join(scratch,"package"),manifest=await packageMemberWeb({out,config});
	for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])staticFiles.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});
	staticFiles.set("CSP",(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0]);
	browser=await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
	const context=await browser.newContext({acceptDownloads:true,viewport:{width:1360,height:1000}}),page=await context.newPage(),errors=[],downloads=[];
	await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
	page.on("pageerror",error=>errors.push(error.message));page.on("download",download=>downloads.push(download));page.on("dialog",dialog=>dialog.accept());
	await page.goto(origin);await page.getByRole("button",{name:"Email a sign-in link"}).waitFor();
	assert.equal(calls.filter(call=>call.method.startsWith("qorpera")).length,0);
	await page.getByLabel("Email address").fill("fixture@example.test");await page.getByRole("button",{name:"Email a sign-in link"}).click();await page.getByRole("status").filter({hasText:"Check your email"}).waitFor();
	assert.equal(calls.filter(call=>call.method==="/auth/v1/otp").length,1);
	const switchAccount=async n=>page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session(n));
	await switchAccount(1);await page.getByRole("button",{name:"Company Alpha · Main",exact:true}).click();await page.getByRole("button",{name:"notes.txt",exact:true}).waitFor();
	assert.equal(await page.evaluate(()=>typeof window.Buffer==="undefined"&&typeof window.process==="undefined"&&Boolean(crypto.subtle)),true);
	await page.getByRole("button",{name:"notes.txt",exact:true}).click();await page.getByLabel("File content").fill("Edited from the independent web client\n");await page.getByRole("button",{name:"Save to company",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();
	await page.getByRole("button",{name:"Retry this exact save"}).click();await page.getByRole("status").filter({hasText:"Saved to the live company"}).waitFor();
	const editCalls=calls.filter(call=>call.method==="edits");assert.equal(editCalls.length,2);assert.deepEqual(editCalls[0].input,editCalls[1].input);
	await page.getByRole("button",{name:"Download…",exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes("Download handed"));assert.equal(downloads.length,1);assert.equal(String(await readFile(await downloads[0].path())),"Edited from the independent web client\n");
	await page.getByLabel("Select a file to upload").setInputFiles({name:"chosen.bin",mimeType:"application/octet-stream",buffer:Buffer.from([1,0,255,128])});await page.getByRole("button",{name:"Check destination",exact:true}).click();await page.getByRole("button",{name:"Upload to company",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();
	await page.getByRole("button",{name:"Retry this exact upload"}).click();await page.getByRole("heading",{name:"Review exact change"}).waitFor();
	const uploads=calls.filter(call=>call.method==="uploads");assert.equal(uploads.length,2);assert.deepEqual(uploads[0],uploads[1]);
	await page.getByRole("button",{name:"Apply exact change…"}).click();await page.getByRole("status").filter({hasText:"Applied the exact"}).waitFor();assert.deepEqual(files.get("chosen.bin").bytes,Buffer.from([1,0,255,128]));
	await page.getByRole("button",{name:"Agent proposal · proposal.bin"}).click();await page.getByRole("button",{name:"Download proposed file…"}).click();await page.getByRole("status").filter({hasText:"Proposed file handed"}).waitFor();assert.deepEqual(await readFile(await downloads.at(-1).path()),proposed.bytes);
	await page.getByRole("button",{name:"Apply exact change…"}).click();await page.getByRole("status").filter({hasText:"Applied the exact"}).waitFor();assert.equal(proposal.state,"applied");
	await page.getByRole("button",{name:"notes.txt",exact:true}).click();
	if(process.env.QORPERA_WEB_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_PROOF_OUTPUT,"member-web-files.png"),fullPage:true});}
	await page.getByRole("button",{name:"Company Computer",exact:true}).click();await page.getByRole("button",{name:"Create browser profile"}).waitFor();assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_start").length,0);
	await page.getByRole("button",{name:"Start computer",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await page.getByRole("button",{name:"Refresh computer status"}).click();await page.getByRole("button",{name:"Cancel pending start"}).waitFor();assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_start").length,1);
	await page.getByLabel("Desktop",{exact:true}).check();await page.getByRole("button",{name:"Update agent access"}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await page.getByRole("button",{name:"Refresh agent access"}).click();await page.getByRole("button",{name:"Revoke agent access"}).click();await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent!=="Working…");assert.equal(accessGrant.state,"revoked");
	await page.getByLabel("New browser profile name").fill("Work browser");await page.getByRole("button",{name:"Create browser profile"}).click();await page.getByText("This profile needs private preparation before agent use.",{exact:true}).waitFor();assert.equal(await page.getByRole("button",{name:"Allow agent to use this browser"}).isDisabled(),true);
	if(process.env.QORPERA_WEB_PROOF_OUTPUT)await page.screenshot({path:join(process.env.QORPERA_WEB_PROOF_OUTPUT,"member-web-computer.png"),fullPage:true});
	await page.getByRole("button",{name:"Browser access cleanup",exact:true}).click();await page.getByText("No browser profiles or private sessions need cleanup.",{exact:true}).waitFor();assert.equal(startIntent.state,"requested");
	mode="legacy";await page.getByRole("button",{name:"Companies",exact:true}).click();await page.getByRole("button",{name:"Company Alpha · Main",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await page.getByRole("button",{name:"Company Computer",exact:true}).click();await page.getByRole("button",{name:"Create browser profile"}).waitFor();
	mode="governed";await page.getByRole("button",{name:"Files",exact:true}).click();await page.getByRole("button",{name:"notes.txt",exact:true}).waitFor();
	const downloadCount=downloads.length;corrupt=true;await page.getByRole("button",{name:"Download…",exact:true}).first().click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();assert.equal(downloads.length,downloadCount);corrupt=false;
	holdObjects=true;await page.getByRole("button",{name:"Download…",exact:true}).first().click();for(let attempt=0;attempt<200&&!releaseObjects;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert(releaseObjects,"expected held object request");await switchAccount(2);await page.getByRole("button",{name:"Company Beta · Main",exact:true}).waitFor();releaseObjects();await page.waitForTimeout(100);assert.equal(downloads.length,downloadCount);assert.equal(await page.getByRole("button",{name:"notes.txt",exact:true}).count(),0);
	await page.evaluate(()=>localStorage.setItem("unrelated-application","preserve"));await page.getByRole("button",{name:"Sign out",exact:true}).click();await page.getByRole("button",{name:"Continue with Google"}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem("qorpera.member-web.auth")),null);assert.equal(await page.evaluate(()=>localStorage.getItem("unrelated-application")),"preserve");
	assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
	console.log(JSON.stringify({schema:"qorpera.member-web-browser-proof/v1",browser:browser.version(),packageInputs:manifest.browserInputs.length,actualStaticPackage:true,actualAuthSdk:true,actualHttp:true,actualBrowser:true,nodeGlobals:false,explicitEmailIntent:true,exactEditRetry:true,exactUploadRetry:true,verifiedDownload:true,exactBinaryProposalReview:true,officeIndependentOfFileMode:true,noImplicitStart:true,lostStartRecovered:true,versionedAccessRevoked:true,unpreparedConsentDenied:true,closePreservesComputer:true,cleanupIndependentOfCompany:true,corruptBytesRejected:true,accountSwitchCancelsDownload:true,signOutClearsOnlyOwnStorage:true,authority:"fixture",auth:"fixture",hosted:false,physicalOffice:false}));
} catch(error) { console.error(JSON.stringify({ failures, pages: await Promise.all((browser?.contexts().flatMap(context=>context.pages())??[]).map(page=>page.locator("body").innerText().catch(()=>"closed"))) })); throw error; }
finally { releaseObjects?.();await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true}); }
