import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Actual desktop handler + shared client + disposable SQL + Chromium DOM.
// Electron process/frame plumbing and preload are fixtures. No provider/VM starts.
export async function testMemberOfficeUi({root,query,seed}) {
	if(!process.env.QORPERA_OFFICE_TEST_BROWSER)return;
	query(seed);
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-member-office-ui-"));let server,browser,host;
	const methods=new Set(["qorpera_member_office_catalog","qorpera_runtime_office_start_status","qorpera_request_runtime_office_start","qorpera_cancel_runtime_office_start","qorpera_runtime_office_access_status","qorpera_configure_runtime_office_access"]);
	const sql=value=>value===null?"null":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'${typeof value==="object"?"::jsonb":""}`;
	let userId="30000000-0000-4000-8000-000000000001",loseStart=true,loseGrant=true;const calls=[];
	try {
		const modulePath=join(scratch,"host.mjs");
		await build({absWorkingDir:root,stdin:{resolveDir:root,contents:'export {openMemberCompanyComputerWindow} from "./packages/shell/src/member-company-computer-window.ts";export {CloudMemberCompanyComputerClient} from "./packages/cloud-client/src/cloud-member-company-computer.ts";'},bundle:true,platform:"node",format:"esm",target:"node22",outfile:modulePath,
			plugins:[{name:"fixture-electron",setup(build){build.onResolve({filter:/^electron$/},()=>({path:"electron",namespace:"fixture"}));build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`
export const session={fromPartition:()=>({setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){},on(){},webRequest:{onBeforeRequest(){}}})};
export class BrowserWindow {
 destroyed=false;closed=[];handlers=new Map();webContents={mainFrame:{url:""},ipc:{handle:(name,handler)=>this.handlers.set(name,handler)},setWebRTCIPHandlingPolicy(){},setWindowOpenHandler(){},on(){}};
 once(name,fn){this.closed.push(fn)}isDestroyed(){return this.destroyed}destroy(){this.destroyed=true;for(const fn of this.closed)fn()}show(){}async loadFile(path){this.webContents.mainFrame.url=new URL('file://'+path).href}
 request(input){return this.handlers.get('company-computer:member')({sender:this.webContents,senderFrame:this.webContents.mainFrame},input)}
}
` }));}}]});
		const code=await import(pathToFileURL(modulePath).href),files=new Map();
		for(const [name,mime] of [["company-computer.html","text/html"],["company-computer.js","text/javascript"],["company-computer.css","text/css"],["company-computer-view-channel.js","text/javascript"],["screen-viewer.js","text/javascript"],["screens.css","text/css"],["vendor/novnc-rfb.js","text/javascript"]])files.set(`/${name}`,{bytes:await readFile(join(root,"packages/shell/userland",name)),mime});
		server=createServer(async(request,response)=>{
			const file=files.get(request.url==="/"?"/company-computer.html":request.url);
			if(request.method==="GET"&&file){response.writeHead(200,{"content-type":file.mime});response.end(file.bytes);return;}
			const method=request.url?.slice("/rest/v1/rpc/".length);
			if(request.method!=="POST"||!request.url?.startsWith("/rest/v1/rpc/")||!methods.has(method)){response.writeHead(404);response.end();return;}
			try{
				assert.equal(request.headers.authorization,"Bearer fixture-member");assert.equal(request.headers.apikey,"public");
				let body="";for await(const chunk of request){body+=chunk;assert(body.length<=4096);}
				const args=JSON.parse(body);calls.push({method,args});
				const parameters=Object.entries(args).map(([key,value])=>{assert(/^p_[a-z][a-z0-9_]*$/.test(key));return `${key}=>${sql(value)}`;});
				const data=JSON.parse(query(`set request.jwt.claims='{"role":"authenticated","sub":"${userId}"}';set role authenticated;select to_jsonb(public.${method}(${parameters.join(",")}));`));
				if((loseStart&&method==="qorpera_request_runtime_office_start")||(loseGrant&&method==="qorpera_configure_runtime_office_access")){
					if(method==="qorpera_request_runtime_office_start")loseStart=false;else loseGrant=false;response.writeHead(503);response.end();return;}
				response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(data));
			}catch(error){console.error("Disposable member office RPC failed",method,error.message);response.writeHead(403);response.end();}
		});
		await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
		const origin=`http://127.0.0.1:${server.address().port}`;
		const client=new code.CloudMemberCompanyComputerClient({companyId:"30000000-0000-4000-8000-000000000010",environmentId:"30000000-0000-4000-8000-000000000020",supabaseUrl:origin,publishableKey:"public",accessToken:async()=>"fixture-member"});
		host=await code.openMemberCompanyComputerWindow({owner:{},directory:join(root,"packages/shell/userland"),title:"Company",client,current:()=>true});
		browser=await chromium.launch({executablePath:process.env.QORPERA_OFFICE_TEST_BROWSER,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
		const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
		await page.exposeFunction("fixtureOfficeRequest",input=>host.request(input));
		await page.addInitScript(()=>{window.companyComputer={request:input=>window.fixtureOfficeRequest(input)};});await page.goto(origin);
		await page.waitForFunction(()=>document.getElementById("status").textContent==="Company Computer status refreshed.");
		assert.equal(calls.some(call=>call.method==="qorpera_request_runtime_office_start"),false);
		await page.locator("#start").click();await page.waitForFunction(()=>document.getElementById("status").classList.contains("error"));
		assert.equal(await page.locator("#start").isDisabled(),true);
		await page.locator("#refresh").click();await page.waitForFunction(()=>document.getElementById("computerState").textContent.includes("Start requested"));
		assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_start").length,1);
		assert.equal(query("select count(*) from public.qorpera_runtime_office_start_intents where state='requested';"),"1");
		const beforeClose=calls.length;host.destroy();assert.equal(calls.length,beforeClose);
		host=await code.openMemberCompanyComputerWindow({owner:{},directory:join(root,"packages/shell/userland"),title:"Company",client,current:()=>true});
		await page.reload();await page.waitForFunction(()=>document.getElementById("status").textContent==="Company Computer status refreshed.");
		assert.equal(await page.locator("#start").isDisabled(),true);assert.equal(query("select count(*) from public.qorpera_runtime_office_start_intents where state='requested';"),"1");
		await page.locator("#desktop").check();await page.locator("#grant").click();await page.waitForFunction(()=>document.getElementById("status").classList.contains("error"));
		assert.equal(await page.locator("#grant").isDisabled(),true);
		await page.locator("#refresh").click();await page.waitForFunction(()=>document.getElementById("status").textContent==="Company Computer status refreshed.");
		assert.equal(await page.locator("#desktop").isChecked(),true);assert.equal(calls.filter(call=>call.method==="qorpera_configure_runtime_office_access").length,1);
		await page.locator("#revoke").click();await page.waitForFunction(()=>document.getElementById("status").textContent.startsWith("Access revoked"));
		assert.equal(query("select state from public.qorpera_runtime_office_access where staff_agent_id='30000000-0000-4000-8000-000000000030';"),"revoked");
		await page.locator("#cancelStart").click();await page.waitForFunction(()=>document.getElementById("computerState").textContent.includes("Start cancelled"));
		userId="30000000-0000-4000-8000-000000000003";await page.reload();await page.waitForFunction(()=>document.getElementById("status").textContent==="Company Computer status refreshed.");
		assert.equal(await page.locator("#accessPanel").isHidden(),true);assert.equal(await page.locator("#start").isDisabled(),true);assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.member-office-ui/v1",actualSql:true,actualSharedClient:true,actualDesktopHandler:true,actualDom:true,browser:browser.version(),lostStartRecovered:true,noImplicitStart:true,closePreservesStart:true,lostGrantRecovered:true,versionedRevocation:true,exactStartCancellation:true,ordinaryMemberReadOnly:true,preload:"fixture",electron:"fixture",providerStarted:false,hosted:false}));
	}finally{host?.destroy();await browser?.close();if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});await rm(scratch,{recursive:true,force:true});}
}
