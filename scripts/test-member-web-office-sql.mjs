import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

// Actual web package, Auth SDK, SQL authority, TLS gateway and noVNC. Auth
// sessions, SQL HTTP transport, RFB pixels and physical acknowledgements are
// disposable fixtures. There is no Electron bridge or browser request routing.
export async function testMemberWebOfficeSql({root,query,seed}) {
	const executablePath=process.env.QORPERA_WEB_OFFICE_TEST_BROWSER;assert(executablePath);query(seed);
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-web-office-sql-")),assets=new Map(),sockets=new Set(),timers=new Set(),calls=[],controlCalls=[],inputBytes=[],errors=[],transport=[],websockets=[];
	const scope=JSON.parse(query("select public.qorpera_runtime_office_scope(o) from public.qorpera_runtime_offices o;"));
	const user=n=>`30000000-0000-4000-8000-${String(n).padStart(12,"0")}`,owner=user(1),member=user(3),expiry=Math.floor(Date.now()/1000)+3600;
	const token=n=>`e30.${Buffer.from(JSON.stringify({sub:user(n),role:"authenticated",aud:"authenticated",exp:expiry})).toString("base64url")}.fixture`;
	const session=n=>({access_token:token(n),refresh_token:`fixture-refresh-${n}`,token_type:"bearer",expires_in:3600,expires_at:expiry,user:{id:user(n),email:`member-${n}@fixture.test`,aud:"authenticated",role:"authenticated",app_metadata:{},user_metadata:{},created_at:"2026-09-08T00:00:00Z"}});
	const memberId=value=>{const id=[1,3].find(n=>value===`Bearer ${token(n)}`);assert(id,"Unknown fixture member");return user(id);};
	const literal=value=>value===null?"null":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'${typeof value==="object"?"::jsonb":""}`;
	const execute=(method,args,sub)=>{
		assert(/^qorpera_[a-z_]+$/.test(method));const parameters=Object.entries(args).map(([key,value])=>{assert(/^p_[a-z][a-z0-9_]*$/.test(key));return `${key}=>${literal(value)}`;});
		return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({role:sub?"authenticated":"service_role",...(sub?{sub}:{})})}';set role ${sub?"authenticated":"service_role"};select to_jsonb(public.${method}(${parameters.join(",")}));`)||"null");
	};
	let browser,page,server,guest,gateway,shuttingDown=false,lostMint=false,lostPrivacy=false,lostProfile=false;
	const ack=()=>{
		if(shuttingDown)return;const timer=setTimeout(()=>{timers.delete(timer);try{
			const pending=JSON.parse(query("select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'generation',s.generation,'epoch',s.epoch,'drainId',s.drain_id,'computerGeneration',o.generation)),'[]') from public.qorpera_runtime_office_screens s join public.qorpera_runtime_offices o on o.id=s.office_id where s.drain_pending;"));
			for(const screen of pending)execute("qorpera_ack_runtime_office_drain",{p_scope:scope,p_screen_id:screen.id,p_computer_generation:screen.computerGeneration,p_screen_generation:screen.generation,p_epoch:screen.epoch,p_drain_id:screen.drainId});
			const privacy=execute("qorpera_runtime_office_privacy_status",{p_scope:scope});if(["entering","leaving"].includes(privacy.state))execute("qorpera_ack_runtime_office_privacy",{p_challenge:privacy.challenge});
		}catch(error){errors.push(`fixture acknowledgement: ${error.message}`);}},350);timers.add(timer);
	};
	try {
		const modulePath=join(scratch,"gateway.mjs");await build({absWorkingDir:root,stdin:{resolveDir:root,contents:[
			'export {startCompanyComputerViewerWebSocketGateway} from "./packages/runtime/src/cloud-company-computer-viewer-websocket.ts";',
			'export {CloudCompanyComputerViewerControl} from "./packages/runtime/src/cloud-company-computer-viewer-control.ts";',
			'export {CompanyComputerRfbClientParser} from "./packages/cloud-client/src/node/cloud-company-computer-rfb.ts";',
		].join("\n")},bundle:true,platform:"node",format:"esm",target:"node22",outfile:modulePath});
		const code=await import(pathToFileURL(modulePath).href);
		const certificate=spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(scratch,"key.pem"),"-out",join(scratch,"cert.pem"),"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{encoding:"utf8",timeout:15000});assert.equal(certificate.status,0,"Disposable TLS generation");
		const cert=await readFile(join(scratch,"cert.pem")),key=await readFile(join(scratch,"key.pem")),spki=createHash("sha256").update(new X509Certificate(cert).publicKey.export({type:"spki",format:"der"})).digest("base64");
		const allowed=new Set(["qorpera_list_hosted_profiles","qorpera_member_company_file_mode","qorpera_list_company_paths","qorpera_list_member_company_path_commands","qorpera_list_company_path_proposals","qorpera_member_office_catalog","qorpera_runtime_office_start_status","qorpera_runtime_office_access_status","qorpera_runtime_office_member_status","qorpera_request_runtime_office_drain","qorpera_create_runtime_office_viewer","qorpera_cancel_runtime_office_viewer","qorpera_member_browser_profiles","qorpera_create_member_browser_profile","qorpera_member_browser_grant_status","qorpera_set_runtime_browser_grant","qorpera_runtime_office_privacy_status","qorpera_request_runtime_office_privacy","qorpera_check_runtime_office_private_access","qorpera_member_browser_recovery","qorpera_company_presence_scope"]);
		let csp;server=createServer({cert,key,minVersion:"TLSv1.3"},(request,response)=>{void(async()=>{
			if(request.url==="/favicon.ico"){response.writeHead(204);response.end();return;}
			if(request.method==="GET"&&assets.has(request.url)){const file=assets.get(request.url);response.writeHead(200,{"content-type":file.mime,"content-security-policy":csp,"cache-control":"no-store","x-content-type-options":"nosniff"});response.end(file.bytes);return;}
			if(request.url?.startsWith("/realtime/")){response.writeHead(503);response.end();return;}
			const method=request.url?.split("/").at(-1);assert(request.method==="POST"&&request.url.startsWith("/rest/v1/rpc/")&&allowed.has(method),`${request.method} ${request.url}`);assert.equal(request.headers.apikey,"sb_publishable_fixture1");
			let body="";for await(const chunk of request){body+=chunk;assert(body.length<16384);}const args=JSON.parse(body),sub=memberId(request.headers.authorization);calls.push({method,args,sub});
			if(method==="qorpera_create_runtime_office_viewer"&&args.p_mode==="control")assert.equal(query("select bool_or(drain_pending) from public.qorpera_runtime_office_screens;"),"f","control must follow physical acknowledgement");
			const data=execute(method,args,sub);if(["qorpera_request_runtime_office_drain","qorpera_cancel_runtime_office_viewer","qorpera_request_runtime_office_privacy","qorpera_set_runtime_browser_grant"].includes(method))ack();
			if(method==="qorpera_create_runtime_office_viewer"&&lostMint){lostMint=false;response.writeHead(503);response.end();return;}
			if(method==="qorpera_request_runtime_office_privacy"&&lostPrivacy){lostPrivacy=false;response.writeHead(503);response.end();return;}
			if(method==="qorpera_create_member_browser_profile"&&lostProfile){lostProfile=false;response.writeHead(503);response.end();return;}
			response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify(data));
		})().catch(error=>{transport.push(error.message);response.writeHead(403);response.end();});});
		await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const origin=`https://127.0.0.1:${server.address().port}`;
		const hello=Buffer.alloc(24),name=Buffer.from("Fixture screen");hello.writeUInt16BE(1920,0);hello.writeUInt16BE(1200,2);hello[4]=32;hello[5]=24;hello[7]=1;for(const offset of [8,10,12])hello.writeUInt16BE(255,offset);hello[14]=16;hello[15]=8;hello.writeUInt32BE(name.length,20);
		const update=Buffer.alloc(16);update.writeUInt16BE(1,2);update.writeUInt16BE(80,8);update.writeUInt16BE(50,10);
		guest=createTcpServer(socket=>{
			sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>undefined);const parser=new code.CompanyComputerRfbClientParser(),pixels=Buffer.alloc(80*50*4);let painted=false,step=0;
			for(let i=0;i<pixels.length;i+=4){pixels[i]=32;pixels[i+1]=96;pixels[i+2]=192;}socket.write(Buffer.from("RFB 003.008\n"));
			socket.on("data",bytes=>{try{for(const message of parser.push(bytes)){
				if(step<3){if(step===0)socket.write(Buffer.from([1,1]));else if(step===1)socket.write(Buffer.alloc(4));else socket.write(Buffer.concat([hello,name]));step++;continue;}
				if(message.kind==="input")inputBytes.push(Buffer.from(message.bytes));
				if(message.kind==="protocol"&&message.bytes.length===20&&message.bytes[0]===0){const pixel=(192<<message.bytes[14])|(96<<message.bytes[15])|(32<<message.bytes[16]);for(let i=0;i<pixels.length;i+=4){if(message.bytes[6])pixels.writeUInt32BE(pixel,i);else pixels.writeUInt32LE(pixel,i);}}
				if(message.kind==="protocol"&&message.bytes.length===10&&message.bytes[0]===3&&!painted){painted=true;socket.write(Buffer.concat([update,pixels]));}
			}}catch{socket.destroy();}});
		});await new Promise((resolve,reject)=>{guest.once("error",reject);guest.listen(0,"127.0.0.1",resolve);});
		const authority=new code.CloudCompanyComputerViewerControl({scope,control:{call:async(method,args,signal)=>{signal.throwIfAborted();controlCalls.push(method);const data=execute(method,args);if(method==="qorpera_release_runtime_office_viewer")ack();return data;}}});
		gateway=await code.startCompanyComputerViewerWebSocketGateway({host:"127.0.0.1",port:0,path:`/office/${scope.companyComputerId}/view`,origins:[origin],tls:{cert,key},authority,guest:{connect:async()=>{
			const socket=connect(guest.address().port,"127.0.0.1");sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>undefined);await new Promise((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});socket.pause();return{socket,remainder:Buffer.alloc(0)};
		}}});const viewerOrigin=`wss://127.0.0.1:${gateway.port}`;
		const out=join(scratch,"package"),manifest=await packageMemberWeb({root,out,config:{schema:"qorpera.member-web-config/v1",supabaseUrl:origin,publishableKey:"sb_publishable_fixture1",objectGatewayUrl:origin,officeViewerOrigin:viewerOrigin}});
		for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])assets.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});csp=(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0];
		browser=await chromium.launch({executablePath,headless:true,args:[`--ignore-certificate-errors-spki-list=${spki}`,"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});const context=await browser.newContext({viewport:{width:1360,height:1000}});
		context.on("request",request=>{if(new URL(request.url()).origin!==origin)errors.push("Unexpected external HTTP request");});page=await context.newPage();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));page.on("dialog",dialog=>dialog.accept());
		page.on("websocket",socket=>{
			if(socket.url()===`${origin.replace("https:","wss:")}/realtime/v1/websocket?apikey=sb_publishable_fixture1&vsn=2.0.0`)return;
			websockets.push(socket.url());if(socket.url()!==`${viewerOrigin}/office/${scope.companyComputerId}/view`)errors.push("Unexpected viewer WebSocket destination");
		});
		const click=async name=>{await page.getByRole("button",{name,exact:typeof name==="string"}).click();await page.waitForFunction(()=>!document.querySelector("main")?.inert);};
		const switchAccount=async n=>{await page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session(n));};
		const companyName=(()=>{const rows=execute("qorpera_list_hosted_profiles",{},owner);assert.equal(rows.length,1);return `${rows[0].profile_name} · ${rows[0].environment_name}`;})();
		const openCompany=async()=>{await click(companyName);await click("Company Computer");await page.getByRole("heading",{name:"Your browser profiles",exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector("main").inert);};
		const refresh=async()=>{await page.waitForTimeout(450);await click("Refresh browser status");};
		const pixels=async()=>page.waitForFunction(()=>{const canvas=document.querySelector(".screen-viewer-stage canvas");return canvas?.getContext("2d").getImageData(1,1,1,1).data[0]===192;});
		const count=method=>calls.filter(call=>call.method===method).length;
		const watch=async()=>{await click(/^Watch screen /);await page.getByText("Watching only",{exact:true}).waitFor();await pixels();};
		await page.goto(origin);await page.getByRole("button",{name:"Continue with Google"}).waitFor();await switchAccount(1);await openCompany();assert.equal(count("qorpera_create_runtime_office_viewer"),0);
		await watch();await page.keyboard.press("a");assert.equal(inputBytes.length,0);
		await click("Take control");await page.getByText("You control this cloud screen",{exact:true}).waitFor();await pixels();await page.keyboard.press("a");await page.waitForTimeout(200);assert(inputBytes.some(bytes=>bytes[0]===4&&bytes[1]===1&&bytes.readUInt32BE(4)===97));assert.equal(count("qorpera_request_runtime_office_drain"),1);// Input is audited per window: key down and up land with the next renewal, within about a second.
		for(let i=0;i<40&&Number(query("select coalesce(sum(coalesce(packet_count,1)),0) from public.qorpera_runtime_office_viewer_inputs;"))<2;i++)await page.waitForTimeout(100);
		assert(Number(query("select coalesce(sum(coalesce(packet_count,1)),0) from public.qorpera_runtime_office_viewer_inputs;"))>=2);
		await click("Close screen viewer");await refresh();const beforeMint=count("qorpera_create_runtime_office_viewer");lostMint=true;await click(/^Watch screen /);await page.getByText("Cloud screen unavailable. Reconnect to check access again.",{exact:true}).waitFor();assert.equal(count("qorpera_create_runtime_office_viewer"),beforeMint+1);await click("Close screen viewer");await click("Refresh screens");await click(/^Cancel watch connection/);await refresh();await watch();
		const beforeAccountInput=inputBytes.length;await switchAccount(3);await page.waitForFunction(()=>!document.querySelector(".screen-viewer-overlay"));await page.keyboard.press("a");await page.waitForTimeout(200);assert.equal(inputBytes.length,beforeAccountInput);assert.equal(query("select state from public.qorpera_runtime_offices;"),"active");await openCompany();await watch();assert.equal(await page.getByRole("button",{name:"Take control",exact:true,includeHidden:true}).isHidden(),true);await click("Close screen viewer");await refresh();
		lostProfile=true;await page.getByLabel("New browser profile name").fill("Work browser");await click("Create browser profile");await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await refresh();assert.equal(count("qorpera_create_member_browser_profile"),1);assert.equal(await page.getByRole("button",{name:"Allow agent to use this browser"}).isDisabled(),true);
		lostPrivacy=true;await click(/^Sign in privately on screen /);await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();await refresh();assert.equal(count("qorpera_request_runtime_office_privacy"),1);assert.deepEqual(execute("qorpera_member_browser_profiles",{p_scope:scope},owner).profiles,[]);assert.equal(execute("qorpera_runtime_office_privacy_status",{p_scope:scope},owner).challenge,null);
		const privateInput=inputBytes.length,takeovers=count("qorpera_request_runtime_office_drain");await click("Open your private browser");await page.getByText("Private sign-in · Closing this view leaves the office private",{exact:true}).waitFor();await pixels();assert.equal(await page.getByRole("button",{name:"Take control",exact:true,includeHidden:true}).isHidden(),true);await page.keyboard.press("b");await page.waitForTimeout(200);assert(inputBytes.slice(privateInput).some(bytes=>bytes[0]===4&&bytes[1]===1&&bytes.readUInt32BE(4)===98));
		if(process.env.QORPERA_WEB_OFFICE_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_OFFICE_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_OFFICE_PROOF_OUTPUT,"member-web-private-viewer.png"),fullPage:true});}
		await click("Close screen viewer");assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"private");assert.equal(count("qorpera_request_runtime_office_privacy"),1);await click("Open your private browser");await page.getByText("Private sign-in · Closing this view leaves the office private",{exact:true}).waitFor();await pixels();assert.equal(count("qorpera_request_runtime_office_drain"),takeovers);await click("Close screen viewer");await click("Finish private sign-in");await refresh();assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"shared");
		await click("Allow agent to use this browser");await refresh();await page.getByText("Consent allows this agent to use this browser profile.",{exact:true}).waitFor();await click("Revoke browser consent");assert.equal(query("select state from public.qorpera_runtime_browser_grants;"),"revoked");await refresh();await click("Allow agent to use this browser");await refresh();
		// A second prepared profile targets another real staff agent. Both grants
		// must remain independently revocable from the account-only cleanup page.
		execute("qorpera_set_runtime_office_access",{p_office_id:scope.companyComputerId,p_staff_agent_id:user(31),p_expected_version:0,p_enabled:true},owner);
		await page.getByLabel("New browser profile name").fill("Second browser");await click("Create browser profile");await page.getByLabel("Your browser profile",{exact:true}).selectOption({label:"Second browser"});await page.waitForFunction(()=>!document.querySelector("main").inert);await click(/^Sign in privately on screen /);await refresh();await click("Finish private sign-in");await refresh();await page.getByLabel("Your browser profile",{exact:true}).selectOption({label:"Second browser"});await page.waitForFunction(()=>!document.querySelector("main").inert);await page.getByLabel("Agent browser consent").selectOption(user(31));await page.waitForFunction(()=>!document.querySelector("main").inert);await click("Allow agent to use this browser");await refresh();assert.equal(query("select count(*) from public.qorpera_runtime_browser_grants where state='active';"),"2");
		const membership=JSON.parse(query(`select to_jsonb(m) from public.qorpera_profile_members m where profile_id='${scope.companyId}' and user_id='${member}';`));
		const cleanup=async()=>{await click("Browser access cleanup");await click(`Computer ${scope.companyComputerId.slice(-12)}`);};
		await cleanup();const rows=page.locator("div").filter({has:page.locator(":scope > h3")});assert.equal(await rows.count(),2);const firstLabel=await rows.first().locator("h3").innerText();
		const first=execute("qorpera_member_browser_profiles",{p_scope:scope},member).profiles.find(profile=>profile.label===firstLabel);assert(first);let observed=execute("qorpera_member_browser_grant_status",{p_scope:scope,p_profile_id:first.profileId,p_staff_agent_id:first.activeStaffAgentId},member);
		// Another client changes this exact grant after it was displayed. A click
		// must not silently revoke the replacement consent after refreshing it.
		const configure=enabled=>execute("qorpera_set_runtime_browser_grant",{p_scope:scope,p_profile_id:first.profileId,p_staff_agent_id:first.activeStaffAgentId,p_profile_version:observed.profile.version,p_expected_version:observed.grant.version,p_enabled:enabled},member);
		configure(false);ack();await page.waitForTimeout(450);observed=execute("qorpera_member_browser_grant_status",{p_scope:scope,p_profile_id:first.profileId,p_staff_agent_id:first.activeStaffAgentId},member);configure(true);ack();await page.waitForTimeout(450);const beforeStale=count("qorpera_set_runtime_browser_grant");await rows.first().getByRole("button",{name:"Revoke browser consent"}).click();await page.getByRole("status").filter({hasText:"Could not confirm"}).waitFor();assert.equal(count("qorpera_set_runtime_browser_grant"),beforeStale);assert.equal(query("select count(*) from public.qorpera_runtime_browser_grants where state='active';"),"2");
		execute("qorpera_remove_profile_member",{p_profile_id:scope.companyId,p_member_user_id:member},owner);ack();await page.waitForTimeout(450);await cleanup();assert.equal(await rows.count(),2);await rows.first().getByRole("button",{name:"Revoke browser consent"}).click();await page.getByRole("status").filter({hasText:"Browser consent revoked"}).waitFor();assert.equal(query("select count(*) from public.qorpera_runtime_browser_grants where state='active';"),"1");await page.getByRole("button",{name:"Revoke browser consent",exact:true}).click();await page.waitForFunction(()=>!document.querySelector("main").inert);assert.equal(query("select count(*) from public.qorpera_runtime_browser_grants where state='active';"),"0");
		if(process.env.QORPERA_WEB_OFFICE_PROOF_OUTPUT)await page.screenshot({path:join(process.env.QORPERA_WEB_OFFICE_PROOF_OUTPUT,"member-web-browser-cleanup.png"),fullPage:true});
		query(`insert into public.qorpera_profile_members select * from jsonb_populate_record(null::public.qorpera_profile_members,${literal(membership)});`);await click("Companies");await openCompany();await click(/^Sign in privately on screen /);await refresh();execute("qorpera_remove_profile_member",{p_profile_id:scope.companyId,p_member_user_id:member},owner);ack();await cleanup();assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"private");await click("Finish your private sign-in");await page.waitForTimeout(450);await click("Refresh this computer");assert.equal(query("select privacy_state from public.qorpera_runtime_offices;"),"shared");assert.equal(await page.getByRole("button",{name:"Finish your private sign-in",exact:true}).count(),0);
		assert.deepEqual(errors,[]);assert.deepEqual(transport,[]);assert(websockets.length>=6);assert(controlCalls.includes("qorpera_release_runtime_office_viewer"));
		console.log(JSON.stringify({schema:"qorpera.member-web-office-sql/v1",browser:browser.version(),actualStaticPackage:true,actualAuthSdk:true,actualSql:true,actualTlsGateway:true,actualNoVnc:true,nativeBrowserOrigin:true,browserInputs:manifest.browserInputs.length,watchPixelsVerified:true,watchInputBlocked:true,controlAfterAcknowledgement:true,typedInputAdmitted:true,lostMintRecoveredWithoutReplay:true,accountChangeClosesViewer:true,closePreservesComputer:true,ordinaryMemberWatchOnly:true,uncertainProfileRecovered:true,uncertainPrivacyRecovered:true,ownerOnlyMetadata:true,privateInput:true,explicitPrivateReconnect:true,closePreservesPrivacy:true,explicitPrivateExit:true,consentAfterPreparation:true,consentRevocation:true,multipleProfileCleanup:true,staleConsentRejected:true,removedMemberDiscovery:true,removedMemberRevoke:true,removedMemberPrivateExit:true,companyFileRequired:false,electron:false,authSessions:"fixture",sqlHttpTransport:"fixture",guestPixels:"fixture RFB",physicalPrivacyBarrier:"fixture acknowledgement",hosted:false}));
	}catch(error){console.error(JSON.stringify({stage:"web-office-failure",calls,controlCalls,errors,transport,websockets,text:await page?.locator("body").innerText().catch(()=>"closed")}));throw error;}
	finally{shuttingDown=true;await browser?.close();for(const timer of timers)clearTimeout(timer);timers.clear();await gateway?.close();for(const socket of sockets)socket.destroy();if(guest)await new Promise(resolve=>guest.close(resolve));if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});await rm(scratch,{recursive:true,force:true});}
}
