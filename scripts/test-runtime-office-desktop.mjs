import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export async function startDesktopSource(directory, container, image, sourceFile = "source.mjs") {
	await writeFile(join(directory,"start.sh"),`#!/bin/sh
set -eu
mkdir -p /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/.X11-unix /tmp/office-x
chmod 700 /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/office-x
chown 1000:1000 /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/office-x
chmod 1777 /tmp/.X11-unix
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all node /probe/${sourceFile}
`);
	const child=spawn("docker",["run","--rm","-i","--name",container,"--pull","never","--network","none","--read-only",
		"--memory","512m","--memory-swap","512m","--pids-limit","128","--cpus","1",
		"--cap-drop","ALL","--cap-add","CHOWN","--cap-add","SETUID","--cap-add","SETGID","--cap-add","SETPCAP",
		"--security-opt","no-new-privileges","--security-opt","seccomp=unconfined","--security-opt","systempaths=unconfined",
		"--tmpfs","/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777","--tmpfs","/srv:rw,nosuid,nodev,size=128m,mode=755",
		"--tmpfs","/run/office-captures:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700",
		"--mount",`type=bind,source=${directory},target=/probe,readonly`,image,"sh","/probe/start.sh"],{stdio:["pipe","pipe","pipe"]});
	let error="", serial=0, closePromise;
	child.stderr.on("data",chunk=>{error=(error+chunk.toString()).slice(-16384);});
	const pending=new Map();
	let resolveReady,rejectReady;
	const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
	const exited=new Promise(resolve=>{child.once("error",failure=>{rejectReady(failure);for(const waiter of pending.values())waiter.reject(failure);});
		child.once("close",code=>{const failure=new Error(`Desktop fixture exited ${code}: ${error}`);rejectReady(failure);for(const waiter of pending.values())waiter.reject(failure);resolve(code);});});
	createInterface({input:child.stdout}).on("line",line=>{try{const message=JSON.parse(line);if(message.ready){assert.equal(message.uid,1000);resolveReady();}
		else {const waiter=pending.get(message.id);assert(waiter);waiter.resolve(message.value);}}catch(failure){rejectReady(failure);for(const waiter of pending.values())waiter.reject(failure);}});
	const request=async(payload,signal=AbortSignal.timeout(15000))=>{
		signal.throwIfAborted();const id=++serial;
		let abort;
		try {return await new Promise((resolve,reject)=>{abort=()=>reject(new Error("DESKTOP_FIXTURE_REQUEST_CANCELLED"));signal.addEventListener("abort",abort,{once:true});
			pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,...payload})+"\n");});}
		finally {pending.delete(id);signal.removeEventListener("abort",abort);}
	};
	const timer=setTimeout(()=>rejectReady(new Error("DESKTOP_FIXTURE_START_TIMEOUT")),15000);
	try {await ready;} finally {clearTimeout(timer);}
	return {request,close:()=>closePromise??=(async()=>{await request({action:"close"});child.stdin.end();
		const timer=setTimeout(()=>child.kill("SIGKILL"),10000);try{assert.equal(await exited,0,error);}finally{clearTimeout(timer);}})()};
}

// Actual member grant + SQL/native ledger + TLS + guest automation + contained
// Linux xdotool/scrot + object HTTP storage. SQL transport, mount admission and
// Xvfb setup are fixtures. This is not LXD/NAS or ordinary application acceptance.
export async function testOfficeDesktop({ root, query, setup }) {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-office-desktop-acceptance-"));
	const container = `qorpera-desktop-source-${randomUUID()}`;
	const image = "sha256:c6b95862d90e417a75e5598bff2e3671e5584718e7589054bdfea890a2014c7f";
	const sql = value => `'${String(value).replaceAll("'", "''")}'`;
	const valueSql = value => value === null ? "null" : typeof value === "object" ? `${sql(JSON.stringify(value))}::jsonb` : sql(value);
	const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
	const allowed = new Set(["qorpera_describe_native_tool_authority", "qorpera_native_office_descriptor",
		"qorpera_native_office_screen", "qorpera_native_office_operation", "qorpera_native_office_capture",
		"qorpera_runtime_office_access_status", "qorpera_configure_runtime_office_access",
		"qorpera_begin_native_tool_operation", "qorpera_complete_native_tool_operation",
		"qorpera_authorize_native_company_object_upload", "qorpera_confirm_native_company_object_upload"]);
	const calls = [];
	const member = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`;
	const rpc = (method, args, claims = service) => {
		assert(allowed.has(method), method);
		const parameters = Object.entries(args).map(([name, value]) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(name)); return `${name}=>${valueSql(value)}`;
		});
		calls.push({ method, action: args.p_action });
		let result;
		try {result = query(`${claims} select to_jsonb(public.${method}(${parameters.join(",")}));`);}
		catch(error) {console.error(`Disposable desktop RPC failed: ${method} ${args.p_action ?? ""}`,error);throw error;}
		return result ? JSON.parse(result) : null;
	};
	const beforeHead = query("select head_snapshot_id from public.qorpera_company_files where environment_id=" + sql(setup.scope.environmentId) + "::uuid;");
	const ca = getCACertificates("default");
	let run, session, listener, objects, physical, access, originalGrant, failed = false;
	let captures = 0, physicalCloses = 0; const dispatched = [];
	try {
		const exports = {
			"packages/runtime/src/cloud-native-tool-authority.ts": ["CloudNativeToolRun"],
			"packages/runtime/src/cloud-native-provider-service.ts": ["SupabaseNativeProviderControlPlane"],
			"packages/runtime/src/cloud-native-tool-operations.ts": ["CloudNativeToolOperations"],
			"packages/runtime/src/cloud-company-computer-native-client.ts": ["createHttpCompanyComputerSessionFactory", "HttpCompanyComputerNativeEndpoint"],
			"packages/runtime/src/cloud-company-computer-native-gateway.ts": ["CompanyComputerNativeGateway", "startCompanyComputerNativeGateway"],
			"packages/runtime/src/cloud-company-computer-registry-http.ts": ["HttpCloudCompanyComputerRegistry"],
			"packages/runtime/src/cloud-company-computer-endpoint.ts": ["CompanyComputerGuestEndpoint"],
			"packages/runtime/src/cloud-company-computer-guest.ts": ["CompanyComputerGuestAutomation"],
			"packages/runtime/src/cloud-company-computer-leases.ts": ["CompanyComputerScreenActionGate"],
			"packages/runtime/src/cloud-company-computer-screenshots.ts": ["createHttpCompanyComputerScreenshots"],
			"packages/cloud-client/src/cloud-company-computer-access.ts": ["CloudCompanyComputerAccess"],
			"packages/object-gateway/src/native-objects.ts": ["serveNativeCompanyObject"],
			"packages/object-gateway/src/object-store.ts": ["FileSystemObjectStore"],
			"packages/object-gateway/src/journal.ts": ["ObjectGatewayJournal"],
			"packages/object-gateway/src/replication.ts": ["ObjectGatewayReplication"],
		};
		await build({stdin:{contents:Object.entries(exports).map(([file,names])=>`export {${names.join(",")}} from ${JSON.stringify(join(root,file))};`).join("\n"),resolveDir:root},
			outfile:join(directory,"runtime.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19",
			banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
		await build({entryPoints:[join(root,"packages/runtime/test/fixtures/company-computer-desktop-source.ts")],outfile:join(directory,"source.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19"});
		const code = await import(pathToFileURL(join(directory,"runtime.mjs")).href);
		physical = await startDesktopSource(directory, container, image);
		access = new code.CloudCompanyComputerAccess(setup.scope, setup.identity.staffAgentId, async (method,args)=>({data:rpc(method,args,member),error:null}));
		originalGrant = (await access.status(new AbortController().signal)).grant; assert(originalGrant);
		await access.configure({expectedVersion:originalGrant.version,enabled:true,capabilities:["desktop"]},new AbortController().signal);
		const authorize = code.HttpCompanyComputerNativeEndpoint.prototype.authorize;
		code.HttpCompanyComputerNativeEndpoint.prototype.authorize = async function(...args) {
			try {return await authorize.apply(this,args);}
			catch(error) {console.error("Disposable native endpoint authorization",error);throw error;}
		};
		const sqlFetch = async (url,init)=>Response.json(rpc(String(url).split("/").at(-1),JSON.parse(init.body)));
		const registry = new code.HttpCloudCompanyComputerRegistry({supabaseUrl:"https://disposable-sql.qorpera.test",serviceRoleKey:"fixture-service",fetch:sqlFetch});
		run = await code.CloudNativeToolRun.open(setup.binding,{describeToolAuthority:async binding=>rpc("qorpera_describe_native_tool_authority",{p_binding:binding})},new AbortController().signal);
		const control = new code.SupabaseNativeProviderControlPlane("https://disposable-sql.qorpera.test","fixture-service",sqlFetch);
		const store = new code.FileSystemObjectStore(join(directory,"objects"));
		const journal = new code.ObjectGatewayJournal(join(directory,"journal"));
		const replication = new code.ObjectGatewayReplication(journal,store,{});
		const objectToken = randomBytes(32).toString("base64url");
		const objectAuthority = {
			async authorizeNativeUpload(binding,companyId,sha256,bytes) {rpc("qorpera_authorize_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes});},
			async confirmNativeUpload(binding,companyId,sha256,bytes) {rpc("qorpera_confirm_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes});},
		};
		const errors = [];
		objects = createServer((req,res)=>void code.serveNativeCompanyObject(req,res,{token:objectToken,authority:objectAuthority},store,replication)
			.catch(error=>{errors.push(error);console.error("Disposable object gateway failed",error);res.writeHead(500);res.end();}));
		await new Promise((resolve,reject)=>{objects.once("error",reject);objects.listen(0,"127.0.0.1",resolve);});
		const objectGateway = {baseUrl:`http://127.0.0.1:${objects.address().port}`,token:objectToken};
		const certificate = spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(directory,"key.pem"),"-out",join(directory,"cert.pem"),"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{encoding:"utf8",timeout:15000});
		assert.equal(certificate.status,0,"Disposable TLS setup");
		const cert = await readFile(join(directory,"cert.pem")), key = await readFile(join(directory,"key.pem"));
		setDefaultCACertificates([...ca,cert]);
		const token = randomBytes(32).toString("base64url");
		const gateway = new code.CompanyComputerNativeGateway({scope:setup.scope,computerGeneration:1,token,registry,
			createSession:async ({run:bound,descriptor,lease,effects})=>{
                // The company browser (2026-09-17 amendment): every agent with access also holds a company-owned browser grant.
                assert.deepEqual(descriptor.capabilities,["desktop","browser"]);
                await physical.request({action:"open",binding:lease.binding});
				const automation = new code.CompanyComputerGuestAutomation({binding:lease.binding,
					layout:{workbenchRoot:"/srv/workbench",desktopHome:"/srv/desktop",screenStateRoot:"/srv/screens",browserProfilesRoot:"/srv/profiles"},
					boundary:{assertReady:async()=>{}},screenshots:code.createHttpCompanyComputerScreenshots({run:bound,scope:setup.scope,registry,objectGateway}),
					commands:{run:async(input)=>{const {signal,...wire}=input;signal.throwIfAborted();dispatched.push(structuredClone(wire));const result=await physical.request({action:"run",input:wire},signal);signal.throwIfAborted();return result;},
                        capturePng:async({signal,...wire})=>{captures++;return Buffer.from(await physical.request({action:"capture",...wire},signal),"base64");}}});
				return {endpoint:new code.CompanyComputerGuestEndpoint({binding:lease.binding,capabilities:descriptor.capabilities,resourceTarget:descriptor.resources,effects,
					gate:new code.CompanyComputerScreenActionGate(),automation,assertScreenAdmitted:async()=>{},prepareScreen:async()=>{}}),close:async()=>{await physical.close();physicalCloses++;}};
			}});
		listener = await code.startCompanyComputerNativeGateway({host:"127.0.0.1",port:0,tls:{cert,key},gateway});
		const factory = code.createHttpCompanyComputerSessionFactory({url:`https://127.0.0.1:${listener.port}/office/${setup.scope.companyComputerId}/native`,token,registry});
		session = await factory(run,new code.CloudNativeToolOperations(run,control)); assert(session);
        // A desktop-only office grant still implies no shell or transfer; the browser tool now comes from the company browser grant.
        assert(!session.tools.some(tool=>["computer_shell","computer_transfer"].includes(tool.name)));
        assert(session.tools.some(tool=>tool.name==="computer_browser"));
        const tool=session.tools.find(tool=>tool.name==="computer_desktop"), screenshot=session.tools.find(tool=>tool.name==="computer_screenshot");assert(tool&&screenshot);
        const context={companyId:run.identity.companyId,runId:run.identity.runId,signal:run.signal};
        const cases=[
          [{kind:"desktop",action:"move",x:37,y:41},["mousemove","--sync","37","41"]],
          [{kind:"desktop",action:"click",x:1919,y:1199,button:"right"},["mousemove","--sync","1919","1199","click","3"]],
          [{kind:"desktop",action:"scroll",direction:"down",amount:2},["click","--repeat","2","--delay","40","5"]],
          [{kind:"desktop",action:"press",key:"Control+Alt+Shift+Meta+F12"},["key","--clearmodifiers","ctrl+alt+shift+super+F12"]],
          [{kind:"desktop",action:"type",text:"$(literal) --text"},["type","--clearmodifiers","--file","-"]],
        ];
        for(const [ordinal,[action,args]] of cases.entries()) {
          const input={operationKey:"desktop-acceptance-"+ordinal,action};
          const result=await tool.execute(input,context);assert.equal(result.kind,"json");assert.equal(result.value.code,0,result.value.stderr);
          assert.deepEqual(dispatched.at(-1).args,args);assert.equal(dispatched.at(-1).program,"/usr/bin/xdotool");
          if(action.action==="type")assert.equal(dispatched.at(-1).stdin,action.text);
          assert.deepEqual(await tool.execute(input,context),result);assert.equal(dispatched.length,ordinal+1);
        }
        const pointer=await physical.request({action:"pointer"});assert.equal(pointer.code,0);assert.match(pointer.stdout,/^X=1919$/m);assert.match(pointer.stdout,/^Y=1199$/m);
        const captureInput={operationKey:"desktop-capture-acceptance",action:{kind:"screenshot",surface:"desktop"}};
        const result=await screenshot.execute(captureInput,context);assert.equal(result.kind,"json");const asset=result.value;
        assert.equal(asset.surface,"desktop");assert.equal(asset.width,1920);assert.equal(asset.height,1200);
        const bytes=await store.get(setup.scope.companyId,asset.sha256,asset.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"),asset.sha256);
        assert(bytes.includes(Buffer.from("IDAT")));assert(bytes.includes(Buffer.from("IEND")));
        assert.deepEqual(await screenshot.execute(captureInput,context),result);assert.equal(captures,1);
        assert.equal(calls.filter(call=>call.method==="qorpera_native_office_operation"&&call.action==="begin").length,6);
        assert.equal(calls.filter(call=>call.method==="qorpera_complete_native_tool_operation").length,6);
        assert.deepEqual(errors,[]);
        const receipt=JSON.parse(query("select jsonb_build_object('state',r.status,'result',r.result,'resource',o.state,'hold',h.released_at is null and h.expires_at is null) " +
          "from public.qorpera_runtime_office_captures c join public.qorpera_run_operation_receipts r on r.id=c.receipt_id " +
          "join public.qorpera_runtime_office_resources o on o.receipt_id=c.receipt_id join public.qorpera_artifact_retention_holds h on h.client_hold_id=c.receipt_id " +
          "where c.artifact_id="+sql(asset.assetId)+"::uuid;"));
        assert.equal(receipt.state,"completed");assert.equal(receipt.resource,"drained");assert.equal(receipt.hold,true);assert.deepEqual(receipt.result.content,result);
        assert.equal(query("select head_snapshot_id from public.qorpera_company_files where environment_id="+sql(setup.scope.environmentId)+"::uuid;"),beforeHead);
        await session.close();session=undefined;await listener.close();listener=undefined;run.close();run=undefined;
        assert.equal(physicalCloses,1);
        assert.equal(query("select count(*) from public.qorpera_runtime_office_resources where state='active';"),"0");
        assert.equal(query("select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"),"0");
        console.log(JSON.stringify({schema:"qorpera.office-desktop-acceptance/v1",memberGrantApi:true,actualSql:true,nativeLedger:true,officeTls:true,
          linuxCommandsUid:1000,actualPointer:[1919,1199],typedActions:5,actualXvfbCaptureBytes:bytes.length,objectHttp:true,retentionHold:true,
          duplicateEffects:0,canonicalHeadUnchanged:true,activeResources:0,screenLeases:0,mountAdmission:"fixture",hostedOrNas:false}));
	} catch(error) {
		failed = true; console.error("Disposable desktop acceptance failed",{dispatched,captures,calls},error); throw error;
	} finally {
		const closed = await Promise.allSettled([session?.close()]);
		closed.push(...await Promise.allSettled([listener?.close()])); run?.close();
		closed.push(...await Promise.allSettled([physical?.close(),(async()=>{
			if(originalGrant) {const current=(await access.status(new AbortController().signal)).grant;await access.configure({expectedVersion:current.version,enabled:originalGrant.state==="active",capabilities:originalGrant.capabilities},new AbortController().signal);
				setup.resources=rpc("qorpera_native_office_descriptor",{p_binding:setup.binding}).resources;}
		})()]));
		if(objects) await new Promise(resolve=>{objects.closeAllConnections();objects.close(resolve);});
		setDefaultCACertificates(ca);
		const cleanup = spawnSync("docker",["rm","--force",container],{encoding:"utf8",timeout:15000});
		await rm(directory,{recursive:true,force:true});
		if(cleanup.error) throw cleanup.error;
		if(cleanup.status!==0&&!cleanup.stderr.includes("No such container")) throw new Error("DESKTOP_SOURCE_CLEANUP_FAILED");
		for(const result of closed) if(result.status==="rejected") {if(!failed)throw result.reason;console.error("Disposable desktop cleanup failed",result.reason);}
	}
}
