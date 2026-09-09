import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { packageMemberWeb } from "./package-member-web.mjs";

// Actual packaged web client, SQL File metadata/member presence authority,
// gateway and signed native Phoenix traffic. Auth sessions and loopback
// SQL/Realtime servers are fixtures; no Electron or UI bridge is installed.
export async function testMemberWebPresenceSql({root,query,actors,endpoint,control,frames,setHttpHandler}) {
	const executablePath=process.env.QORPERA_WEB_PRESENCE_TEST_BROWSER;if(!executablePath)return;
	const scratch=await mkdtemp(join(tmpdir(),"qorpera-web-presence-sql-")),assets=new Map(),errors=[],calls=[];
	const {companyId,environmentId}=actors[0].identity,memberId="30000000-0000-4000-8000-000000000003",ownerId="30000000-0000-4000-8000-000000000001",path="projects/report.md",expiry=Math.floor(Date.now()/1000)+3600;
	const token=`e30.${Buffer.from(JSON.stringify({sub:memberId,role:"authenticated",aud:"authenticated",exp:expiry})).toString("base64url")}.fixture`,session={access_token:token,refresh_token:"fixture-refresh",token_type:"bearer",expires_in:3600,expires_at:expiry,user:{id:memberId,email:"member@fixture.test",aud:"authenticated",role:"authenticated",app_metadata:{},user_metadata:{},created_at:"2026-09-08T00:00:00Z"}};
	const literal=value=>value===null?"null":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'${typeof value==="object"?"::jsonb":""}`;
	const memberSql=(sub,sql)=>query(`set request.jwt.claims='${JSON.stringify({role:"authenticated",sub})}';set role authenticated;${sql}`);
	const methods=new Set(["qorpera_list_hosted_profiles","qorpera_member_company_file_mode","qorpera_list_company_paths","qorpera_read_company_path","qorpera_list_member_company_path_commands","qorpera_list_company_path_proposals"]);
	const rpc=(method,args)=>{assert(methods.has(method),method);const parameters=Object.entries(args).map(([key,value])=>{assert(/^p_[a-z][a-z0-9_]*$/.test(key));return `${key}=>${literal(value)}`;});return JSON.parse(memberSql(memberId,`select to_jsonb(public.${method}(${parameters.join(",")}));`));};
	let browser,page,gateway,policy=false,preflights=0;
	try {
		const modulePath=join(scratch,"gateway.mjs");await build({absWorkingDir:root,stdin:{resolveDir:root,contents:'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";'},bundle:true,platform:"node",format:"esm",target:"node22",outfile:modulePath});const code=await import(pathToFileURL(modulePath).href);
		const handler=code.createObjectGatewayHandler({store:{},authority:{},controlToken:"fixture-control",verifierToken:"fixture-verifier",memberClientOrigins:[endpoint],memberPresence:{
			member:async(method,bearer,args,signal)=>{assert.equal(method,"qorpera_company_presence_scope");assert.equal(bearer,token);assert.equal(args.p_binding,null);assert.equal(args.p_environment_id,environmentId);signal.throwIfAborted();calls.push("member");return JSON.parse(memberSql(memberId,`select public.qorpera_company_presence_scope(${literal(environmentId)}::uuid,null,array[${args.p_paths.map(literal).join(",")}]::text[]);`));},
			publisher:async(method,args,signal)=>{assert.equal(method,"qorpera_native_presence_subject");calls.push("publisher");return control.call(method,args,signal);}
		}});
		gateway=createServer((request,response)=>{response.once("finish",()=>{if(request.method==="OPTIONS"&&response.statusCode===204)preflights++;});handler(request,response);});await new Promise((resolve,reject)=>{gateway.once("error",reject);gateway.listen(0,"127.0.0.1",resolve);});const objectOrigin=`http://127.0.0.1:${gateway.address().port}`;
		const out=join(scratch,"package"),manifest=await packageMemberWeb({root,out,config:{schema:"qorpera.member-web-config/v1",supabaseUrl:endpoint,publishableKey:"sb_publishable_fixture1",objectGatewayUrl:objectOrigin,officeViewerOrigin:null}});
		for(const [name,mime] of [["index.html","text/html"],["app.js","text/javascript"],["app.css","text/css"],["screens.css","text/css"],["config.json","application/json"]])assets.set(name==="index.html"?"/":`/${name}`,{bytes:await readFile(join(out,name)),mime});const csp=(await readFile(join(out,"_headers"),"utf8")).split("Content-Security-Policy: ")[1].split("\n")[0];
		setHttpHandler((request,response)=>{void(async()=>{
			if(request.url==="/favicon.ico"){response.writeHead(204);response.end();return;}
			if(request.method==="GET"&&assets.has(request.url)){const file=assets.get(request.url);response.writeHead(200,{"content-type":file.mime,"content-security-policy":csp,"cache-control":"no-store"});response.end(file.bytes);return;}
			assert(request.method==="POST"&&request.url.startsWith("/rest/v1/rpc/"));assert.equal(request.headers.authorization,`Bearer ${token}`);assert.equal(request.headers.apikey,"sb_publishable_fixture1");let body="";for await(const chunk of request){body+=chunk;assert(body.length<16384);}const value=rpc(request.url.split("/").at(-1),JSON.parse(body));response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(value));
		})().catch(error=>{errors.push(error.message);response.writeHead(403);response.end();});});
		browser=await chromium.launch({executablePath,headless:true,args:["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]});const context=await browser.newContext({viewport:{width:1360,height:1000}});context.on("request",request=>{if(![endpoint,objectOrigin].includes(new URL(request.url()).origin))errors.push("Unexpected external request");});page=await context.newPage();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));
		await page.goto(endpoint);await page.getByRole("button",{name:"Continue with Google"}).waitFor();await page.evaluate(session=>{localStorage.setItem("qorpera.member-web.auth",JSON.stringify(session));const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_IN",session});channel.close();},session);
		await page.getByRole("button",{name:"Path gateway fixture · Environment",exact:true}).click();const presence=page.locator("p.hint").filter({hasText:"Recent agent activity"});await presence.filter({hasText:"writing within this folder"}).waitFor();
		const open=async value=>{await page.getByLabel("Company path",{exact:true}).fill(value);await page.getByRole("button",{name:"Open",exact:true}).click();await page.waitForFunction(()=>!document.querySelector("main").inert);};
		await open(path);await presence.filter({hasText:"writing here"}).waitFor();assert.equal(await page.getByRole("button",{name:"Save to company",exact:true}).isDisabled(),true);await page.getByLabel("Company path",{exact:true}).fill("other.md");assert.equal(await presence.isHidden(),true);await page.getByRole("button",{name:"Open",exact:true}).click();await presence.filter({hasText:"No recent shared activity observed."}).waitFor();await open(path);await presence.filter({hasText:"writing here"}).waitFor();
		if(process.env.QORPERA_WEB_PRESENCE_PROOF_OUTPUT){await mkdir(process.env.QORPERA_WEB_PRESENCE_PROOF_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.QORPERA_WEB_PRESENCE_PROOF_OUTPUT,"member-web-native-presence.png"),fullPage:true});}
		memberSql(ownerId,`select public.qorpera_set_company_path_resource(${literal(environmentId)}::uuid,'projects','subtree','member_private','normal');`);policy=true;await presence.filter({hasText:"unavailable."}).waitFor();
		await page.evaluate(()=>{localStorage.removeItem("qorpera.member-web.auth");const channel=new BroadcastChannel("qorpera.member-web.auth");channel.postMessage({event:"SIGNED_OUT",session:null});channel.close();});await page.getByRole("button",{name:"Continue with Google"}).waitFor();assert.equal(await presence.count(),0);
		const nativeIds=JSON.parse(query("select jsonb_agg(client_id) from public.qorpera_native_presence_devices;"));assert.equal(nativeIds.length,2);assert(frames.filter(frame=>frame.event==="presence").every(frame=>nativeIds.includes(frame.payload.payload.clientId)));assert(!JSON.stringify(frames).includes(path));assert(preflights>0);assert(calls.includes("member")&&calls.includes("publisher"));assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.member-web-presence-sql/v1",browser:browser.version(),actualStaticPackage:true,browserInputs:manifest.browserInputs.length,actualAuthSdk:true,actualSqlAuthority:true,actualMemberGateway:true,actualNativeSignatures:true,protocol:"Phoenix v2",nativePreflights:preflights,directoryOverlap:true,exactPathOverlap:true,selectionClears:true,pathRevocationClears:true,accountChangeClears:true,readOnlyMember:true,memberPublishes:false,privateBindingsExposed:false,absentFileMetadata:"actual SQL",initialEmptySnapshotStorage:"catalog-fixture",authSessions:"fixture",sqlHttpTransport:"fixture",realtimeServer:"loopback protocol fixture",hosted:false,electron:false}));
	}catch(error){console.error(JSON.stringify({errors,calls,text:await page?.locator("body").innerText().catch(()=>"closed")}));throw error;}
	finally{await browser?.close();setHttpHandler(null);if(gateway)await new Promise(resolve=>{gateway.closeAllConnections();gateway.close(resolve);});if(policy)query(`delete from public.qorpera_company_path_resources where environment_id=${literal(environmentId)}::uuid and path='projects';`);await rm(scratch,{recursive:true,force:true});}
}
