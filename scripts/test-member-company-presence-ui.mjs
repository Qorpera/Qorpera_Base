import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Actual member/native SQL, signed native Phoenix traffic, member HTTP gateway,
// shared browser observer and desktop host/renderer. Electron/preload transport
// and the displayed file bytes are fixtures; this is not installed-app acceptance.
export async function testMemberCompanyPresenceUi({root,query,actors,endpoint,control,frames}) {
	if(!process.env.QORPERA_PRESENCE_TEST_BROWSER)return;
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-member-presence-ui-"));
	const companyId=actors[0].identity.companyId,environmentId=actors[0].identity.environmentId;
	const memberId="30000000-0000-4000-8000-000000000003",ownerId="30000000-0000-4000-8000-000000000001",path="projects/report.md";
	let server,browser,host,observer,accountCurrent=true,policy=false;
	const errors=[],calls=[],requests=[];
	const sql=value=>`'${String(value).replaceAll("'","''")}'`;
	const memberSql=(member,text)=>query(`set request.jwt.claims='${JSON.stringify({role:"authenticated",sub:member})}';set role authenticated;${text}`);
	try {
		await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
export {openGovernedCompanyWindow} from "./packages/shell/src/governed-company-window.ts";
export {CloudMemberCompanyFileClient} from "./packages/shell/src/cloud-member-company-editor.ts";
export {CloudMemberCompanyPresence} from "./packages/cloud-client/src/cloud-member-company-presence.ts";
export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";
`},bundle:true,platform:"node",format:"esm",target:"node22",outfile:join(scratch,"host.mjs"),plugins:[{name:"fixture-electron",setup(build){
			build.onResolve({filter:/^electron$/},()=>({path:"electron",namespace:"fixture"}));
			build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`
export const session={fromPartition:()=>({setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){},on(){},webRequest:{onBeforeRequest(){}}})};
export const dialog={};
export class BrowserWindow { destroyed=false;closed=[];handlers=new Map();sent=[];webContents={mainFrame:{url:""},ipc:{handle:(n,h)=>this.handlers.set(n,h)},send:(name,value)=>this.sent.push({name,value}),setWebRTCIPHandlingPolicy(){},setWindowOpenHandler(){},on(){}};
once(n,f){this.closed.push(f)}isDestroyed(){return this.destroyed}destroy(){if(this.destroyed)return;this.destroyed=true;for(const f of this.closed)f()}show(){}async loadFile(p){this.webContents.mainFrame.url=new URL('file://'+p).href}
request(channel,input){return this.handlers.get(channel)({sender:this.webContents,senderFrame:this.webContents.mainFrame},input)} }
`}));}}]});
		await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
import {CloudMemberCompanyPresence} from "./packages/cloud-client/src/cloud-member-company-presence.ts";
import {createClient} from "@supabase/supabase-js";
globalThis.startBrowserPresence=options=>{const stop=new AbortController();const observer=new CloudMemberCompanyPresence({...options,client:createClient(options.endpoint,"fixture-key",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),accessToken:async()=>"fixture-member",signal:stop.signal,onChange:view=>{globalThis.browserPresenceView=view;}});observer.select([options.path]);globalThis.closeBrowserPresence=()=>observer.close();};
`},bundle:true,platform:"browser",format:"iife",target:"chrome120",outfile:join(scratch,"browser.js")});
		const code=await import(pathToFileURL(join(scratch,"host.mjs")).href),files=new Map();
		for(const name of ["company-file.html","company-file.js","company-file.css"])files.set(`/${name}`,{bytes:await readFile(join(root,"packages/shell/userland",name)),mime:name.endsWith("html")?"text/html":name.endsWith("css")?"text/css":"text/javascript"});
		files.set("/browser.js",{bytes:await readFile(join(scratch,"browser.js")),mime:"text/javascript"});
		files.set("/browser.html",{bytes:"<!doctype html><title>Shared browser presence proof</title><script src='/browser.js'></script>",mime:"text/html"});
		let gateway;
		server=createServer((request,response)=>{requests.push(request.url);const file=files.get(request.url==="/"?"/company-file.html":request.url);if(file){response.writeHead(200,{"content-type":file.mime});response.end(file.bytes);}else gateway(request,response);});
		await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
		const origin=`http://127.0.0.1:${server.address().port}`;
		gateway=code.createObjectGatewayHandler({store:{},authority:{},controlToken:"control",verifierToken:"verifier",memberClientOrigins:[origin],memberPresence:{
			member:async(method,token,args,signal)=>{
				assert.equal(method,"qorpera_company_presence_scope");assert.equal(token,"fixture-member");assert.equal(args.p_binding,null);assert.equal(args.p_environment_id,environmentId);signal.throwIfAborted();calls.push("member");
				return JSON.parse(memberSql(memberId,`select public.qorpera_company_presence_scope(${sql(environmentId)}::uuid,null,array[${args.p_paths.map(sql).join(",")}]::text[]);`));
			},publisher:async(method,args,signal)=>{calls.push("publisher");assert.equal(method,"qorpera_native_presence_subject");return control.call(method,args,signal);}
		}});
		const client=new code.CloudMemberCompanyFileClient({companyId,environmentId,supabaseUrl:origin,objectGatewayUrl:origin,publishableKey:"fixture-key",accessToken:async()=>"fixture-member",fetch:async()=>{throw new Error("Unexpected file network request");}});
		client.list=async()=>({snapshotId:"30000000-0000-4000-8000-000000000090",items:[{path,kind:"file",version:"30000000-0000-4000-8000-000000000091",bytes:20}],hasMore:false,nextAfter:null});
		client.read=async path=>({path,kind:"file",version:"30000000-0000-4000-8000-000000000091",text:"Fixture document",executable:false});
		client.edits=client.proposals=async()=>({items:[],nextAfter:null});
		host=await code.openGovernedCompanyWindow({owner:{},directory:join(root,"packages/shell/userland"),title:"Presence proof",client,canWrite:false,staffName:id=>id.endsWith("31")?"Research agent":"Planning agent",current:()=>accountCurrent,presence:(signal,onChange)=>{
			observer=new code.CloudMemberCompanyPresence({companyId,environmentId,objectGatewayUrl:origin,client:createClient(endpoint,"fixture-key",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),accessToken:async()=>{assert(accountCurrent);return "fixture-member";},signal,onChange});return observer;
		}});
		browser=await chromium.launch({executablePath:process.env.QORPERA_PRESENCE_TEST_BROWSER,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
		const page=await browser.newPage();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));
		await page.exposeFunction("fixtureRequest",input=>host.request("company-file:governed",input));
		await page.exposeFunction("fixtureSelect",paths=>host.request("company-file:presence-select",paths));
		await page.exposeFunction("fixtureEvents",()=>host.sent.splice(0));
		await page.addInitScript(()=>{window.companyFile={request:input=>window.fixtureRequest(input),selectPresence:paths=>window.fixtureSelect(paths),onPresence:callback=>{const timer=setInterval(async()=>{for(const event of await window.fixtureEvents())if(event.name==="company-file:presence")callback(event.value);},100);return()=>clearInterval(timer);}};});
		await page.goto(origin);await page.waitForFunction(()=>document.getElementById("presence").textContent.includes("writing within this folder"));
		await page.locator("#path").fill(path);await page.locator("#open").click();await page.waitForFunction(()=>document.getElementById("presence").textContent.includes("writing here"));
		assert.equal(await page.locator("#save").isDisabled(),true);
		if(process.env.QORPERA_PRESENCE_PROOF_OUTPUT){await mkdir(process.env.QORPERA_PRESENCE_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_PRESENCE_PROOF_OUTPUT,"member-presence.png"),fullPage:true});}
		await page.locator("#path").fill("other.md");assert.equal(await page.locator("#presence").isHidden(),true);
		await page.locator("#open").click();await page.waitForFunction(()=>document.getElementById("presence").textContent.includes("No recent shared activity observed."));
		await page.locator("#path").fill(path);await page.locator("#open").click();await page.waitForFunction(()=>document.getElementById("presence").textContent.includes("writing here"));
		const web=await browser.newPage();web.on("pageerror",error=>errors.push(error.message));await web.goto(`${origin}/browser.html`);
		await web.evaluate(options=>window.startBrowserPresence(options),{companyId,environmentId,endpoint,objectGatewayUrl:origin,path});
		await web.waitForFunction(()=>window.browserPresenceView?.paths[0].participants.some(item=>item.activity==="writing"));
		memberSql(ownerId,`select public.qorpera_set_company_path_resource(${sql(environmentId)}::uuid,'projects','subtree','member_private','normal');`);policy=true;
		await page.waitForFunction(()=>document.getElementById("presence").textContent.endsWith("unavailable."));
		await web.waitForFunction(()=>window.browserPresenceView?.state==="unavailable");
		accountCurrent=false;await observer.close();await page.waitForFunction(()=>document.getElementById("presence").textContent.endsWith("unavailable."));
		host.destroy();await web.evaluate(()=>window.closeBrowserPresence());
		const nativeIds=JSON.parse(query("select jsonb_agg(client_id) from public.qorpera_native_presence_devices;"));assert.equal(nativeIds.length,2);
		assert(frames.filter(frame=>frame.event==="presence").every(frame=>nativeIds.includes(frame.payload.payload.clientId)),"member clients never publish native activity");
		assert(calls.includes("member")&&calls.includes("publisher"));assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.member-company-presence-ui-proof/v1",desktopHost:true,browserSharedClient:true,sqlAuthority:true,signatureProtocol:"native Phoenix v2",directoryOverlap:true,exactFileOverlap:true,selectionClears:true,pathRevocationClearsBoth:true,memberClientsPublish:false,privateBindingsExposed:false,fileBytes:"fixture",installedElectron:false,requests:requests.length}));
	}finally{
		host?.destroy();await observer?.close();await browser?.close();
		if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
		if(policy)query(`delete from public.qorpera_company_path_resources where environment_id=${sql(environmentId)}::uuid and path='projects';`);
		await rm(scratch,{recursive:true,force:true});
	}
}
