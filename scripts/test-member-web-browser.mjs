// Real static package, Auth SDK, HTTP and DOM.
// Auth and control authority endpoints below are disposable fixtures.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const expiresAt = Math.floor(Date.now()/1000)+3600;
const token = n => `e30.${Buffer.from(JSON.stringify({ sub:id(n), role:"authenticated", aud:"authenticated", exp:expiresAt })).toString("base64url")}.fixture`;
const session = n => ({ access_token:token(n), refresh_token:`fixture-refresh-${n}`, token_type:"bearer", expires_in:3600, expires_at:Math.floor(Date.now()/1000)+3600, user:{ id:id(n), email:`member-${n}@fixture.test`, aud:"authenticated", role:"authenticated", app_metadata:{}, user_metadata:{}, created_at:"2026-09-08T00:00:00Z" } });
const staticFiles = new Map();
const scope={companyId:id(10),environmentId:id(11),companyComputerId:id(12),logicalComputerId:id(13)};
let startIntent=null,accessGrant=null,loseStart=true,loseGrant=true,holdCatalog=false,releaseCatalog;
const calls=[], failures=[];
const profiles=[];
const scratch=await mkdtemp(join(tmpdir(),"qorpera-member-web-browser-"));let browser;
const server=createServer((req,res)=>{void(async()=>{
	const url=new URL(req.url,"http://127.0.0.1"), path=url.pathname;
	if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
	if(req.method==="GET"&&staticFiles.has(path)){const file=staticFiles.get(path);res.writeHead(200,{"content-type":file.mime,"content-security-policy":staticFiles.get("CSP"),"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(file.bytes);return;}
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
		if(method==="qorpera_member_office_catalog"){if(holdCatalog){holdCatalog=false;await new Promise(resolve=>{releaseCatalog=resolve;});}return json({companyId:id(10),environmentId:id(11),canManage:true,scope,staff:[{staffAgentId:id(14),name:"Research assistant"}],nextAfter:null});}
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
	throw new Error(`Unexpected endpoint ${path}`);
})().catch(error=>{failures.push(error.message);res.writeHead(500);res.end();});});
try {
	await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const origin=`http://127.0.0.1:${server.address().port}`;
	const config={schema:"qorpera.member-web-config/v1",supabaseUrl:origin,publishableKey:"sb_publishable_fixture1",officeViewerOrigin:null};
	const out=join(scratch,"package"),manifest=await packageMemberWeb({out,config});
	for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])staticFiles.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});
	staticFiles.set("CSP",(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0]);
	browser=await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
	const context=await browser.newContext({viewport:{width:1360,height:1000}}),page=await context.newPage(),errors=[];
	await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
	page.on("pageerror",error=>errors.push(error.message));
	await page.goto(origin);await page.getByRole("button",{name:"Email a sign-in link"}).waitFor();
	assert.equal(calls.filter(call=>call.method.startsWith("qorpera")).length,0);
	await page.getByLabel("Email address").fill("fixture@example.test");await page.getByRole("button",{name:"Email a sign-in link"}).click();await page.getByRole("status").filter({hasText:"Check your email"}).waitFor();
	assert.equal(calls.filter(call=>call.method==="/auth/v1/otp").length,1);
	const switchAccount=async n=>page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session(n));
	await switchAccount(1);await page.getByRole("button",{name:"Company Alpha · Main",exact:true}).click();await page.getByRole("button",{name:"Create browser profile"}).waitFor();assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_start").length,0);
	assert.equal(await page.evaluate(()=>typeof window.Buffer==="undefined"&&typeof window.process==="undefined"&&Boolean(crypto.subtle)),true);
	assert.equal(await page.getByRole("button",{name:"Files",exact:true}).count(),0);assert.equal(calls.filter(call=>call.method==="qorpera_member_company_file_mode").length,0);
	await page.getByRole("button",{name:"Start computer",exact:true}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await page.getByRole("button",{name:"Refresh computer status"}).click();await page.getByRole("button",{name:"Cancel pending start"}).waitFor();assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_start").length,1);
	await page.getByLabel("Desktop",{exact:true}).check();await page.getByRole("button",{name:"Update agent access"}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await page.getByRole("button",{name:"Refresh agent access"}).click();await page.getByRole("button",{name:"Revoke agent access"}).click();await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent!=="Working…");assert.equal(accessGrant.state,"revoked");
	await page.getByLabel("New browser profile name").fill("Work browser");await page.getByRole("button",{name:"Create browser profile"}).click();await page.getByText("This profile needs private preparation before agent use.",{exact:true}).waitFor();assert.equal(await page.getByRole("button",{name:"Allow agent to use this browser"}).isDisabled(),true);
	if(process.env.QORPERA_WEB_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_PROOF_OUTPUT,"member-web-computer.png"),fullPage:true});}
	await page.getByRole("button",{name:"Browser access cleanup",exact:true}).click();await page.getByText("No browser profiles or private sessions need cleanup.",{exact:true}).waitFor();assert.equal(startIntent.state,"requested");
	await page.getByRole("button",{name:"Companies",exact:true}).click();holdCatalog=true;await page.getByRole("button",{name:"Company Alpha · Main",exact:true}).click();for(let attempt=0;attempt<200&&!releaseCatalog;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert(releaseCatalog,"expected held catalog request");await switchAccount(2);await page.getByRole("button",{name:"Company Beta · Main",exact:true}).waitFor();releaseCatalog();await page.waitForTimeout(100);assert.equal(await page.getByRole("button",{name:"Create browser profile"}).count(),0);assert.equal(await page.getByRole("heading",{name:"Company Alpha · Main"}).count(),0);
	await page.evaluate(()=>localStorage.setItem("unrelated-application","preserve"));await page.getByRole("button",{name:"Sign out",exact:true}).click();await page.getByRole("button",{name:"Continue with Google"}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem("qorpera.member-web.auth")),null);assert.equal(await page.evaluate(()=>localStorage.getItem("unrelated-application")),"preserve");
	assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
	console.log(JSON.stringify({schema:"qorpera.member-web-browser-proof/v1",browser:browser.version(),packageInputs:manifest.browserInputs.length,actualStaticPackage:true,actualAuthSdk:true,actualHttp:true,actualBrowser:true,nodeGlobals:false,explicitEmailIntent:true,companyOpensComputer:true,noFilesPanel:true,noImplicitStart:true,lostStartRecovered:true,versionedAccessRevoked:true,unpreparedConsentDenied:true,closePreservesComputer:true,cleanupIndependentOfCompany:true,accountSwitchCancelsComputer:true,signOutClearsOnlyOwnStorage:true,authority:"fixture",auth:"fixture",hosted:false,physicalOffice:false}));
} catch(error) { console.error(JSON.stringify({ failures, pages: await Promise.all((browser?.contexts().flatMap(context=>context.pages())??[]).map(page=>page.locator("body").innerText().catch(()=>"closed"))) })); throw error; }
finally { releaseCatalog?.();await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true}); }
