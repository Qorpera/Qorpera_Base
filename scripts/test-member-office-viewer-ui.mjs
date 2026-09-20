import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Real SQL, member SDK, TLS gateway, desktop handler/relay, noVNC and Chromium.
// Electron/preload plumbing, guest RFB pixels and physical drain acknowledgement
// are fixtures. This does not claim installed Electron, Linux desktop or LXD acceptance.
export async function testMemberOfficeViewerUi({ root, query, seed }) {
	if (!process.env.QORPERA_OFFICE_VIEWER_TEST_BROWSER) return;
	query(seed);
	const scope = JSON.parse(query("select public.qorpera_runtime_office_scope(o) from public.qorpera_runtime_offices o;"));
	const memberId = "30000000-0000-4000-8000-000000000001", ordinaryId = "30000000-0000-4000-8000-000000000003";
	let userId = memberId, host, browser, server, guest, gateway, page, lostMint = false, lostPrivacy = false, lostProfile = false, shuttingDown = false;
	const sockets = new Set(), timers = new Set(), calls = [], inputBytes = [], errors = [], transport = [], controlCalls = [], viewCalls = [];
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-member-viewer-ui-")), originalCAs = getCACertificates("default");
	const literal = value => value === null ? "null" : `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;
	const execute = (method, args, member) => {
		assert(/^qorpera_[a-z_]+$/.test(method));
		const params = Object.entries(args).map(([key,value]) => { assert(/^p_[a-z][a-z0-9_]*$/.test(key)); return `${key}=>${literal(value)}`; });
		return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({role:member ? "authenticated" : "service_role",...(member ? {sub:member} : {})})}';set role ${member ? "authenticated" : "service_role"};select to_jsonb(public.${method}(${params.join(",")}));`));
	};
	const ack = () => {
		if (shuttingDown) return;
		const timer = setTimeout(() => {
			timers.delete(timer);
			try {
				const pending = JSON.parse(query("select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'generation',s.generation,'epoch',s.epoch,'drainId',s.drain_id,'computerGeneration',o.generation)),'[]') from public.qorpera_runtime_office_screens s join public.qorpera_runtime_offices o on o.id=s.office_id where s.drain_pending;"));
				for (const screen of pending) execute("qorpera_ack_runtime_office_drain", {p_scope:scope,p_screen_id:screen.id,p_computer_generation:screen.computerGeneration,p_screen_generation:screen.generation,p_epoch:screen.epoch,p_drain_id:screen.drainId});
				const privacy = execute("qorpera_runtime_office_privacy_status",{p_scope:scope});
				if (["entering","leaving"].includes(privacy.state)) execute("qorpera_ack_runtime_office_privacy",{p_challenge:privacy.challenge});
			} catch (error) { errors.push(`fixture drain: ${error.message}`); }
		}, 350); timers.add(timer);
	};
	try {
		const modulePath = join(scratch,"host.mjs");
		await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
export {openMemberCompanyComputerWindow} from "./packages/shell/src/member-company-computer-window.ts";
export {openMemberBrowserRecoveryWindow} from "./packages/shell/src/member-browser-recovery-window.ts";
export {CloudMemberBrowserRecovery} from "./packages/cloud-client/src/cloud-member-browser-recovery.ts";
export {CloudMemberCompanyComputerClient} from "./packages/cloud-client/src/cloud-member-company-computer.ts";
export {startCompanyComputerViewerWebSocketGateway} from "./packages/runtime/src/cloud-company-computer-viewer-websocket.ts";
export {CloudCompanyComputerViewerControl} from "./packages/runtime/src/cloud-company-computer-viewer-control.ts";
export {CompanyComputerRfbClientParser} from "./packages/cloud-client/src/node/cloud-company-computer-rfb.ts";
`},bundle:true,platform:"node",format:"esm",target:"node22",outfile:modulePath,plugins:[{name:"fixture-electron",setup(build){
			build.onResolve({filter:/^electron$/},()=>({path:"electron",namespace:"fixture"}));
			build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`
export const session={fromPartition:()=>({setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){},on(){},webRequest:{onBeforeRequest(){}}})};
export class BrowserWindow { destroyed=false;closed=[];handlers=new Map();webContents={mainFrame:{url:""},ipc:{handle:(n,h)=>this.handlers.set(n,h)},setWebRTCIPHandlingPolicy(){},setWindowOpenHandler(){},on(){}};
once(n,f){this.closed.push(f)}isDestroyed(){return this.destroyed}destroy(){if(this.destroyed)return;this.destroyed=true;for(const f of this.closed)f()}show(){}async loadFile(p){this.webContents.mainFrame.url=new URL('file://'+p).href}
request(channel,input){return this.handlers.get(channel)({sender:this.webContents,senderFrame:this.webContents.mainFrame},input)} }
`})); }}]});
		const code = await import(pathToFileURL(modulePath).href);
		const result = spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(scratch,"key.pem"),"-out",join(scratch,"cert.pem"),"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{encoding:"utf8",timeout:15000}); assert.equal(result.status,0,"Disposable TLS generation");
		const cert = await readFile(join(scratch,"cert.pem")), key = await readFile(join(scratch,"key.pem"));
		setDefaultCACertificates([...originalCAs,cert]);
		const files = new Map();
		for (const name of ["company-computer.html","company-computer.js","company-computer.css","screens.css","screen-viewer.js","company-computer-view-channel.js","vendor/novnc-rfb.js","browser-recovery.html","browser-recovery.js"])
			files.set(`/${name}`, {bytes:await readFile(join(root,"packages/shell/userland",name)),mime:name.endsWith(".html")?"text/html":name.endsWith(".css")?"text/css":"text/javascript"});
		const allowed = new Set(["qorpera_member_office_catalog","qorpera_runtime_office_start_status","qorpera_runtime_office_access_status","qorpera_runtime_office_member_status","qorpera_request_runtime_office_drain","qorpera_create_runtime_office_viewer","qorpera_cancel_runtime_office_viewer","qorpera_member_browser_profiles","qorpera_create_member_browser_profile","qorpera_member_browser_grant_status","qorpera_set_runtime_browser_grant","qorpera_runtime_office_privacy_status","qorpera_request_runtime_office_privacy","qorpera_check_runtime_office_private_access","qorpera_member_browser_recovery"]);
		server = createServer(async (request,response) => {
			const file = files.get(request.url === "/" ? "/company-computer.html" : request.url);
			if (request.method === "GET" && file) { response.writeHead(200,{"content-type":file.mime});response.end(file.bytes);return; }
			const method = request.url?.split("/").at(-1);
			if (request.method !== "POST" || !request.url.startsWith("/rest/v1/rpc/") || !allowed.has(method)) {response.writeHead(404);response.end();return;}
			try {
				assert.equal(request.headers.authorization,"Bearer fixture-member"); assert.equal(request.headers.apikey,"public");
				let body="";for await(const chunk of request){body+=chunk;assert(body.length<=4096);}
				const args=JSON.parse(body); calls.push({method,mode:args.p_mode});
				if (method === "qorpera_create_runtime_office_viewer" && args.p_mode === "control") assert.equal(query("select drain_pending from public.qorpera_runtime_office_screens;"),"f","control cannot precede drain acknowledgement");
				const data = execute(method,args,userId);
				if (["qorpera_request_runtime_office_drain","qorpera_cancel_runtime_office_viewer","qorpera_request_runtime_office_privacy","qorpera_set_runtime_browser_grant"].includes(method)) ack();
				if (method === "qorpera_create_runtime_office_viewer" && lostMint) {lostMint=false;response.writeHead(503);response.end();return;}
				if (method === "qorpera_request_runtime_office_privacy" && lostPrivacy) {lostPrivacy=false;response.writeHead(503);response.end();return;}
				if (method === "qorpera_create_member_browser_profile" && lostProfile) {lostProfile=false;response.writeHead(503);response.end();return;}
				response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(data));
			} catch(error) { console.error("Fixture member RPC",method,error.message); response.writeHead(403);response.end(); }
		});
		await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
		const origin=`http://127.0.0.1:${server.address().port}`, clientOrigin="https://desktop.fixture.test";
		const hello=Buffer.alloc(24),name=Buffer.from("Fixture screen");hello.writeUInt16BE(1920,0);hello.writeUInt16BE(1200,2);hello[4]=32;hello[5]=24;hello[7]=1;
		for(const offset of [8,10,12])hello.writeUInt16BE(255,offset);hello[14]=16;hello[15]=8;hello.writeUInt32BE(name.length,20);
		const pixels=Buffer.alloc(80*50*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=32;pixels[i+1]=96;pixels[i+2]=192;}
		const update=Buffer.alloc(16);update.writeUInt16BE(1,2);update.writeUInt16BE(80,8);update.writeUInt16BE(50,10);
		guest=createTcpServer(socket=>{
			sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>undefined);
			const parser=new code.CompanyComputerRfbClientParser();let painted=false,step=0;
			socket.write(Buffer.from("RFB 003.008\n"));
			socket.on("data",bytes=>{try{for(const message of parser.push(bytes)){
				if(step<3){if(step===0)socket.write(Buffer.from([1,1]));else if(step===1)socket.write(Buffer.alloc(4));else socket.write(Buffer.concat([hello,name]));step++;continue;}
				if(message.kind==="input")inputBytes.push(Buffer.from(message.bytes));
				if(message.kind==="protocol"&&message.bytes.length===20&&message.bytes[0]===0){
					const pixel=(192<<message.bytes[14])|(96<<message.bytes[15])|(32<<message.bytes[16]);
					for(let i=0;i<pixels.length;i+=4){if(message.bytes[6])pixels.writeUInt32BE(pixel,i);else pixels.writeUInt32LE(pixel,i);}
				}
				if(message.kind==="protocol"&&message.bytes.length===10&&message.bytes[0]===3&&!painted){painted=true;socket.write(Buffer.concat([update,pixels]));}
			}}catch{socket.destroy();}});
		});
		await new Promise((resolve,reject)=>{guest.once("error",reject);guest.listen(0,"127.0.0.1",resolve);});
		const authority=new code.CloudCompanyComputerViewerControl({scope,control:{call:async(method,args,signal)=>{signal.throwIfAborted();controlCalls.push(method);try{const result=execute(method,args);if(method==="qorpera_release_runtime_office_viewer")ack();return result;}catch(error){transport.push(`${method}: ${error.message}`);throw error;}}}});
		gateway=await code.startCompanyComputerViewerWebSocketGateway({host:"127.0.0.1",port:0,path:`/office/${scope.companyComputerId}/view`,origins:[clientOrigin],tls:{cert,key},authority,guest:{connect:async()=>{
			const socket=connect(guest.address().port,"127.0.0.1");sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>undefined);
			await new Promise((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});socket.pause();return{socket,remainder:Buffer.alloc(0)};
		}}});
		const client=new code.CloudMemberCompanyComputerClient({companyId:scope.companyId,environmentId:scope.environmentId,supabaseUrl:origin,publishableKey:"public",accessToken:async()=>"fixture-member"});
		const open=async()=>{const account=userId;host=await code.openMemberCompanyComputerWindow({owner:{},directory:join(root,"packages/shell/userland"),title:"Company",client,memberId:account,current:()=>account===userId,
			views:scope=>client.views(scope,account,`wss://127.0.0.1:${gateway.port}/office/${scope.companyComputerId}/view`,url=>new WebSocket(url,{headers:{Origin:clientOrigin}}))});};
		await open();
		browser=await chromium.launch({executablePath:process.env.QORPERA_OFFICE_VIEWER_TEST_BROWSER,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});
		page=await browser.newPage();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(["error","warning"].includes(message.type()))transport.push(message.text().slice(0,500));});
		await page.exposeFunction("fixtureMember",input=>host.request("company-computer:member",input));
		await page.exposeFunction("fixtureBrowser",input=>host.request("company-computer:browser",input));
		await page.exposeFunction("fixtureRecovery",input=>host.request("browser-recovery:member",input));
		await page.exposeFunction("fixtureView",async input=>{
			if(input.method==="send")input.data=new Uint8Array(input.data);
			const response=await host.request("company-computer:view",input);
			viewCalls.push({method:input.method,ok:response.ok,state:response.result?.state,bytes:response.result?.data?.byteLength});
			if(response.result?.data instanceof ArrayBuffer)response.result.data=[...new Uint8Array(response.result.data)];return response;
		});
		await page.addInitScript(()=>{window.browserRecovery={request:input=>window.fixtureRecovery(input)};window.companyComputer={request:input=>window.fixtureMember(input),browserRequest:input=>window.fixtureBrowser(input),viewRequest:async input=>{
			if(input.data)input={...input,data:[...input.data]};const response=await window.fixtureView(input);
			if(Array.isArray(response.result?.data))response.result.data=new Uint8Array(response.result.data).buffer;return response;
		}};});
		await page.goto(origin);await page.waitForFunction(()=>document.getElementById("watchScreen").disabled===false);
		assert.equal(calls.some(call=>call.method==="qorpera_create_runtime_office_viewer"),false);
		await page.locator("#watchScreen").click();await page.getByText("Watching only",{exact:true}).waitFor();
		await page.waitForFunction(()=>{const canvas=document.querySelector(".screen-viewer-stage canvas");return canvas?.getContext("2d").getImageData(1,1,1,1).data[0]===192;});
		await page.keyboard.press("a");assert.equal(inputBytes.length,0);
		await page.getByRole("button",{name:"Take control",exact:true}).click();await page.getByText("You control this cloud screen",{exact:true}).waitFor();
		await page.keyboard.press("a");await page.waitForTimeout(200);assert(inputBytes.some(bytes=>bytes[0]===4&&bytes[1]===1&&bytes.readUInt32BE(4)===97));
		assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_drain").length,1);
		// Input is audited per window: key down and up land with the next renewal, within about a second.
		for(let i=0;i<40&&Number(query("select coalesce(sum(coalesce(packet_count,1)),0) from public.qorpera_runtime_office_viewer_inputs;"))<2;i++)await page.waitForTimeout(100);
		assert(Number(query("select coalesce(sum(coalesce(packet_count,1)),0) from public.qorpera_runtime_office_viewer_inputs;"))>=2);
		await page.getByRole("button",{name:"Close screen viewer",exact:true}).click();await page.waitForFunction(()=>!document.querySelector(".screen-viewer-overlay"));
		await page.waitForFunction(()=>document.getElementById("watchScreen").disabled===false);
		lostMint=true;const beforeMint=calls.filter(call=>call.method==="qorpera_create_runtime_office_viewer").length;
		await page.locator("#watchScreen").click();await page.getByText("Cloud screen unavailable. Reconnect to check access again.",{exact:true}).waitFor();
		assert.equal(calls.filter(call=>call.method==="qorpera_create_runtime_office_viewer").length,beforeMint+1);
		await page.getByRole("button",{name:"Close screen viewer",exact:true}).click();await page.waitForFunction(()=>document.getElementById("cancelViewer").disabled===false);
		await page.locator("#cancelViewer").click();await page.waitForFunction(()=>document.getElementById("viewerConnection").options.length===0);
		await page.locator("#watchScreen").click();await page.getByText("Watching only",{exact:true}).waitFor();
		host.destroy();await page.getByText("Disconnected",{exact:true}).waitFor();
		assert.equal(query("select state from public.qorpera_runtime_offices;"),"active");
		userId=ordinaryId;await open();await page.reload();await page.waitForFunction(()=>document.getElementById("watchScreen").disabled===false);
		await page.locator("#watchScreen").click();await page.getByText("Watching only",{exact:true}).waitFor();
		assert.equal(await page.getByRole("button",{name:"Take control",exact:true,includeHidden:true}).isHidden(),true);
		await page.getByRole("button",{name:"Close screen viewer",exact:true}).click();
		await page.waitForFunction(()=>document.getElementById("refreshBrowser").disabled===false);
		lostProfile=true;await page.locator("#profileLabel").fill("Work browser");await page.locator("#registerProfile").click();
		await page.getByText("The browser action could not be confirmed. Refresh browser status before continuing.",{exact:true}).waitFor();
		await page.locator("#refreshBrowser").click();await page.waitForFunction(()=>document.getElementById("beginPrivate").disabled===false);
		assert.equal(calls.filter(call=>call.method==="qorpera_create_member_browser_profile").length,1);
		assert.equal(await page.locator("#allowBrowser").isDisabled(),true);
		lostPrivacy=true;await page.locator("#beginPrivate").click();
		await page.getByText("The browser action could not be confirmed. Refresh browser status before continuing.",{exact:true}).waitFor();
		await page.waitForTimeout(450);await page.locator("#refreshBrowser").click();await page.waitForFunction(()=>document.getElementById("openPrivate").disabled===false);
		assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_privacy").length,1);
		assert.deepEqual(execute("qorpera_member_browser_profiles",{p_scope:scope},memberId).profiles,[]);
		assert.equal(execute("qorpera_runtime_office_privacy_status",{p_scope:scope},memberId).challenge,null);
		const previousInput=inputBytes.length, takeovers=calls.filter(call=>call.method==="qorpera_request_runtime_office_drain").length;
		await page.locator("#openPrivate").click();await page.getByText("Private sign-in · Closing this view leaves the office private",{exact:true}).waitFor();
		assert.equal(await page.getByRole("button",{name:"Take control",exact:true,includeHidden:true}).isHidden(),true);
		await page.keyboard.press("b");await page.waitForTimeout(200);assert(inputBytes.slice(previousInput).some(bytes=>bytes[0]===4&&bytes[1]===1&&bytes.readUInt32BE(4)===98));
		await page.getByRole("button",{name:"Close screen viewer",exact:true}).click();await page.waitForFunction(()=>document.getElementById("openPrivate").disabled===false);
		assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"private");
		assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_privacy").length,1);
		await page.locator("#openPrivate").click();await page.getByText("Private sign-in · Closing this view leaves the office private",{exact:true}).waitFor();
		assert.equal(calls.filter(call=>call.method==="qorpera_request_runtime_office_drain").length,takeovers);
		await page.getByRole("button",{name:"Close screen viewer",exact:true}).click();await page.waitForFunction(()=>document.getElementById("finishPrivate").disabled===false);
		await page.locator("#finishPrivate").click();await page.waitForTimeout(450);await page.locator("#refreshBrowser").click();
		await page.waitForFunction(()=>document.getElementById("allowBrowser").disabled===false);
		assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"shared");
		await page.locator("#allowBrowser").click();await page.waitForFunction(()=>document.getElementById("revokeBrowser").disabled===false);
		await page.waitForTimeout(450);await page.locator("#refreshBrowser").click();await page.getByText("Your consent allows this agent to use the profile.",{exact:true}).waitFor();
		await page.locator("#revokeBrowser").click();await page.waitForFunction(()=>document.getElementById("allowBrowser").disabled===false);
		assert.equal(query("select state from public.qorpera_runtime_browser_grants;"),"revoked");
		await page.waitForTimeout(450);
		// Account cleanup remains usable after the Company File membership and
		// its office window disappear. The test owner is an ordinary member.
		await page.locator("#allowBrowser").click();await page.waitForFunction(()=>document.getElementById("revokeBrowser").disabled===false);await page.waitForTimeout(450);
		const membership=JSON.parse(query(`select to_jsonb(m) from public.qorpera_profile_members m where profile_id='${scope.companyId}' and user_id='${ordinaryId}';`));
		const removeMember=()=>{query(`delete from public.qorpera_profile_members where profile_id='${scope.companyId}' and user_id='${ordinaryId}';`);ack();};
		const cleanup=async()=>{
			host.destroy();const account=userId;
			const recovery=new code.CloudMemberBrowserRecovery({memberId:account,rpc:async(method,args,signal)=>{signal.throwIfAborted();assert.equal(userId,account);const data=execute(method,args,account);if(["qorpera_request_runtime_office_privacy","qorpera_set_runtime_browser_grant"].includes(method))ack();return{data,error:null};}});
			host=await code.openMemberBrowserRecoveryWindow({owner:{isDestroyed:()=>false,once:()=>{}},directory:join(root,"packages/shell/userland"),client:recovery,current:()=>userId===account});
			await page.goto(`${origin}/browser-recovery.html`);
		};
		removeMember();await cleanup();await page.waitForFunction(()=>document.getElementById("revoke").disabled===false);
		assert.equal(await page.locator("#finish").isDisabled(),true);
		await page.locator("#revoke").click();await page.getByText("This profile has no active agent consent.",{exact:true}).waitFor();
		assert.equal(query("select state from public.qorpera_runtime_browser_grants;"),"revoked");
		query(`insert into public.qorpera_profile_members select * from jsonb_populate_record(null::public.qorpera_profile_members,${literal(membership)});`);
		host.destroy();await open();await page.goto(origin);await page.waitForFunction(()=>document.getElementById("beginPrivate").disabled===false);
		await page.locator("#beginPrivate").click();await page.waitForTimeout(450);await page.locator("#refreshBrowser").click();await page.waitForFunction(()=>document.getElementById("openPrivate").disabled===false);
		removeMember();await cleanup();await page.waitForFunction(()=>document.getElementById("finish").disabled===false);
		assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"private");
		await page.locator("#finish").click();await page.waitForTimeout(450);await page.locator("#refresh").click();await page.getByText("You have no active private sign-in here.",{exact:true}).waitFor();
		assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"shared");
		assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.member-office-viewer-ui/v1",actualSql:true,actualSharedClient:true,actualDesktopHandlerAndRelay:true,actualTlsGateway:true,actualNoVnc:true,browser:browser.version(),watchPixelsVerified:true,watchInputBlocked:true,controlAfterAcknowledgement:true,typedInputAdmitted:true,unknownMintRecoveredWithoutReplay:true,closePreservesComputer:true,ordinaryMemberWatchOnly:true,guestPixels:"fixture",physicalDrain:"fixture acknowledgement",electron:"fixture",preload:"fixture",hosted:false}));
		console.log(JSON.stringify({schema:"qorpera.member-private-browser-ui/v1",actualSql:true,actualSharedClient:true,actualDesktopHandlerAndRelay:true,actualTlsGateway:true,actualNoVnc:true,ordinaryMemberPrivateInput:true,ownerOnlyMetadata:true,uncertainCreationRecovered:true,uncertainPrivacyRecoveredWithoutReplay:true,closePreservesPrivacy:true,explicitPrivateReconnect:true,explicitExitAndConsent:true,consentRevocation:true,physicalBrowser:"fixture RFB surface",physicalPrivacyBarrier:"fixture acknowledgement",electron:"fixture",hosted:false}));
		console.log(JSON.stringify({schema:"qorpera.member-browser-cleanup-ui/v1",actualSql:true,actualSharedClient:true,actualDesktopCleanupHost:true,actualChromium:true,removedMemberDiscovery:true,removedMemberRevoke:true,removedMemberPrivateExit:true,companyFileWindowRequired:false,newConsentOrPrivateInput:false,electron:"fixture",physicalPrivacyBarrier:"fixture acknowledgement",hosted:false}));
	} catch(error) {
		console.error(JSON.stringify({stage:"viewer-ui-failure",calls,errors,transport,controlCalls,viewCalls,text:await page?.locator("body").innerText().catch(()=>"closed")})); throw error;
	} finally {
		shuttingDown=true;
		host?.destroy();await browser?.close();for(const timer of timers)clearTimeout(timer);timers.clear();
		await gateway?.close();for(const timer of timers)clearTimeout(timer);
		for(const socket of sockets)socket.destroy();
		if(guest)await new Promise(resolve=>guest.close(resolve));
		if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
		setDefaultCACertificates(originalCAs);await rm(scratch,{recursive:true,force:true});
	}
}
