import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { CloudContentAddressedStore } from "../../../cloud-client/src/node/cloud-object-store.ts";
import { ObjectGatewayJournal } from "../../../object-gateway/src/journal.ts";
import { serveNativeCompanyObject } from "../../../object-gateway/src/native-objects.ts";
import { FileSystemObjectStore } from "../../../object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../../object-gateway/src/replication.ts";
import { createHttpCompanyComputerFileImports } from "../../src/cloud-company-computer-file-imports.ts";
import { createHttpCompanyComputerFileExports } from "../../src/cloud-company-computer-file-transfers.ts";
import { CompanyComputerLinuxGuest } from "../../src/cloud-company-computer-linux-guest.ts";
import { CompanyComputerScreenActionGate } from "../../src/cloud-company-computer-leases.ts";
import { createHttpCompanyComputerSessionFactory } from "../../src/cloud-company-computer-native-client.ts";
import { CompanyComputerNativeGateway, startCompanyComputerNativeGateway } from "../../src/cloud-company-computer-native-gateway.ts";
import { HttpCloudCompanyComputerRegistry } from "../../src/cloud-company-computer-registry-http.ts";
import { HttpCloudCompanyPathControl } from "../../src/cloud-company-path-control.ts";
import { CloudCompanyPathGateway } from "../../src/cloud-company-path-gateway.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { HttpNativeCompanyObjectTransport } from "../../src/cloud-native-company-objects.ts";
import { SupabaseNativeProviderControlPlane } from "../../src/cloud-native-provider-service.ts";
import { CloudNativeToolRun } from "../../src/cloud-native-tool-authority.ts";
import { CloudNativeToolOperations } from "../../src/cloud-native-tool-operations.ts";

// The host owns a disposable PostgreSQL database. Only a closed RPC allowlist
// crosses stdio; the container and each real inner sandbox have no network.
// TLS/object HTTP are loopback inside the broker namespace, absent from shells.
const setup = JSON.parse(await readFile("/opt/probe/combined-setup.json", "utf8"));
const signal = AbortSignal.timeout(120000);
const pending = new Map();
const input = createInterface({input:process.stdin});
let nextId = 0;
input.on("line", line => {
	const response = JSON.parse(line), request = pending.get(response.id);
	assert(request, "Unexpected SQL response"); pending.delete(response.id);
	clearTimeout(request.timer);
	if (response.error) request.reject(new Error(response.error)); else request.resolve(response.value);
});
function rpc(method, args) {
	return new Promise((resolve,reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`SQL timeout: ${method}`)); },15000);
		pending.set(id,{resolve,reject,timer});
		process.stdout.write(`${JSON.stringify({rpc:method,id,args})}\n`);
	});
}
const sqlFetch = async (url, init) => Response.json(await rpc(String(url).split("/").at(-1),JSON.parse(init.body)));
const registry = new HttpCloudCompanyComputerRegistry({supabaseUrl:"https://disposable-sql.qorpera.test",serviceRoleKey:"fixture-service",fetch:sqlFetch});
const control = new SupabaseNativeProviderControlPlane("https://disposable-sql.qorpera.test","fixture-service",sqlFetch);
const runs = await Promise.all(setup.bindings.map(binding => CloudNativeToolRun.open(binding,{
	describeToolAuthority: binding => rpc("qorpera_describe_native_tool_authority",{p_binding:binding}),
},signal)));
assert.notEqual(runs[0].identity.staffAgentId,runs[1].identity.staffAgentId);
const adopted = "/srv/.qorpera-adopted-00000000-0000-4000-8000-000000000072";
const layout = {workbenchRoot:`${adopted}/workbench`,desktopHome:`${adopted}/desktop`,screenStateRoot:`${adopted}/screens`,browserProfilesRoot:`${adopted}/profiles`};
async function mount(path) {
	const fd = await open(path,constants.O_RDONLY | constants.O_DIRECTORY);
	try { return parseRecoveryDirectoryMount(await readFile("/proc/self/mountinfo","utf8"),await readFile(`/proc/self/fdinfo/${fd.fd}`,"utf8")); }
	finally { await fd.close(); }
}
const canonicalRoot = "/var/lib/qorpera-proof-canonical";
const store = new FileSystemObjectStore(`${canonicalRoot}/objects`);
const original = Buffer.from(setup.companyFile.bytesBase64,"base64");
if (!setup.rebuild) {
	await store.put(setup.scope.companyId,setup.companyFile.file.fileSha256,original);
	await store.put(setup.scope.companyId,setup.companyFile.file.manifestSha256,Buffer.from(setup.companyFile.manifest));
}
async function observeObjects() {
	const entries = await readdir(`${canonicalRoot}/objects/${setup.scope.companyId}`,{withFileTypes:true});
	const result = [];
	for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
		assert(entry.isFile()); assert.match(entry.name,/^[a-f0-9]{64}$/);
		const bytes = await readFile(`${canonicalRoot}/objects/${setup.scope.companyId}/${entry.name}`);
		assert.deepEqual(await store.get(setup.scope.companyId,entry.name,bytes.length),bytes);
		assert.equal(createHash("sha256").update(bytes).digest("hex"),entry.name);
		result.push({sha256:entry.name,bytes:bytes.length});
	}
	return result;
}
const journal = new ObjectGatewayJournal(`${canonicalRoot}/journal`);
const replication = new ObjectGatewayReplication(journal,store,{});
const objectToken = randomBytes(32).toString("base64url");
const errors = [];
const objects = createServer((req,res) => void serveNativeCompanyObject(req,res,{token:objectToken,authority:{
	async authorizeNativeUpload(binding,companyId,sha256,bytes) { await rpc("qorpera_authorize_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes}); },
	async confirmNativeUpload(binding,companyId,sha256,bytes) { await rpc("qorpera_confirm_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes}); },
	authorizeNativeDownload(binding,companyId,sha256) { return rpc("qorpera_authorize_native_company_object_download",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256}); },
}},store,replication).catch(error => { errors.push(error.message); res.writeHead(500); res.end(); }));
await new Promise(resolve => objects.listen(0,"127.0.0.1",resolve));
const objectGateway = {baseUrl:`http://127.0.0.1:${objects.address().port}`,token:objectToken};
const guestOptions = {
	scope:setup.scope,computerGeneration:1,layout,
	limits:{memoryBytes:2147483648,pids:512,cpuQuota:200000,cpuPeriod:100000},
	workbenchMount:await mount(layout.workbenchRoot),privateWorkbenchMount:await mount("/run/office-private-workbench"),
	displayRuntimeRoot:"/run/office-screens",browserRuntimeRoot:"/run/office-browser",captureRoot:"/run/office-captures",registry,
	boundary:{assertReady:async()=>{}}, // Physical VM/image adoption remains a fixture.
	screenshots:()=>({publish:async()=>{throw new Error("Unexpected screenshot");}}),
	fileImports:run=>createHttpCompanyComputerFileImports({run,scope:setup.scope,registry,objectGateway}),
	fileExports:run=>createHttpCompanyComputerFileExports({run,scope:setup.scope,registry,objectGateway}),
	onFailure:error=>errors.push(error.message),
};
let guest = new CompanyComputerLinuxGuest(guestOptions);
let gate = new CompanyComputerScreenActionGate();
const token = randomBytes(32).toString("base64url");
const cert = await readFile("/opt/probe/cert.pem"), key = await readFile("/opt/probe/key.pem");
setDefaultCACertificates([...getCACertificates("default"),cert]);
const gateway = new CompanyComputerNativeGateway({scope:setup.scope,computerGeneration:1,token,registry,createSession:async args=>{
	try {
		const session = await guest.createSession({...args,gate});
		const perform = session.endpoint.perform.bind(session.endpoint);
		session.endpoint.perform = async (...args) => {
			try { return await perform(...args); }
			catch (error) { console.error("Combined guest effect failed",error); throw error; }
		};
		return session;
	} catch (error) { console.error("Combined guest session failed",error); throw error; }
}});
const listener = await startCompanyComputerNativeGateway({host:"127.0.0.1",port:0,tls:{cert,key},gateway});
const factory = createHttpCompanyComputerSessionFactory({url:`https://127.0.0.1:${listener.port}/office/${setup.scope.companyComputerId}/native`,token,registry});
let sessions = [];
async function openSessions() {
	sessions = await Promise.all(runs.map(run => factory(run,new CloudNativeToolOperations(run,control))));
	assert(sessions.every(Boolean));
}
async function act(index,action,operationKey) {
	console.error(`Combined workload: staff ${index+1}, ${operationKey}`);
	const tool = sessions[index].tools.find(tool => tool.name === `computer_${action.kind}`);
	assert(tool,action.kind);
	const run = runs[index];
	return tool.execute({operationKey,action},{companyId:run.identity.companyId,runId:run.identity.runId,signal:run.signal});
}
async function shell(index,command,key) {
	const result = await act(index,{kind:"shell",command,timeoutMs:3000},key);
	assert.equal(result.kind,"json"); assert.equal(result.value.code,0,JSON.stringify(result));
	return result.value.stdout;
}
async function closeSessions() {
	await Promise.all(sessions.map(session=>session.close())); sessions=[];
}
try {
	if (setup.rebuild) {
		const retained = JSON.parse(await readFile(`${canonicalRoot}/proof.json`,"utf8"));
		assert.deepEqual(await readdir(layout.workbenchRoot),[],"Rebuilt guest has no surviving workbench files");
		assert.deepEqual(await readdir("/run/office-screens"),[],"No old desktop process survives");
		assert.deepEqual(await readdir(layout.browserProfilesRoot),[],"Browser profile is disposable in this loss proof");
		assert.deepEqual(await observeObjects(),retained.objects,"Every retained physical object has its original bytes");
		const snapshot = setup.retainedCanonical.snapshot;
		assert.equal(snapshot.id,setup.retainedCanonical.company.head_snapshot_id);
		const tree = JSON.parse(await store.get(setup.scope.companyId,snapshot.tree_manifest_sha256,snapshot.tree_manifest_bytes));
		assert.equal(tree.schema,"qorpera.company-tree/v1"); assert.equal(tree.contractVersion,3);
		assert.deepEqual(tree.entries,setup.retainedCanonical.entries.map(entry=>entry.entry),"Physical head tree exactly matches the authoritative live paths");
		const canonicalStore = new CloudContentAddressedStore(new HttpNativeCompanyObjectTransport({...objectGateway,companyId:setup.scope.companyId,binding:runs[1].binding,signal:runs[1].signal}));
		let files = 0, bytes = 0;
		for (const entry of tree.entries) {
			assert.equal(entry.kind,"file");
			const restored = await canonicalStore.restoreFile(setup.scope.companyId,entry.file);
			files++; bytes += restored.bytes.length;
		}
		assert.equal(files,2); assert.equal(files,snapshot.file_count); assert.equal(bytes,snapshot.total_bytes);
		await openSessions();
		await act(1,{kind:"transfer",action:"import",source:retained.source,destination:{realm:"company_computer",path:"recovered-report.bin"}},"rebuild-import-report");
		await act(1,{kind:"transfer",action:"import",source:setup.companyFile.source,destination:{realm:"company_computer",path:"recovered-original.bin"}},"rebuild-import-original");
		assert.deepEqual(await readFile(`${layout.workbenchRoot}/recovered-report.bin`),Buffer.from(retained.bytes,"base64"));
		assert.deepEqual(await readFile(`${layout.workbenchRoot}/recovered-original.bin`),original);
		assert.equal(await shell(1,"test ! -e /var/lib/qorpera-proof-canonical && test ! -e /opt/probe && printf isolated","rebuild-canonical-isolation"),"isolated");
		await closeSessions(); await guest.close();
		assert.deepEqual(await observeObjects(),retained.objects,"Recovery did not restage canonical objects");
		assert.deepEqual(errors,[]);
		console.log(JSON.stringify({schema:"qorpera.office-linux-rebuild-proof/v1",newContainer:true,oldWorkbenchAbsent:true,oldDesktopsAbsent:true,oldProfilesAbsent:true,
			canonicalObjects:retained.objects.length,allObjectHashesUnchanged:true,canonicalHeadClosureFiles:files,canonicalHeadClosureBytes:bytes,canonicalObjectsRestaged:0,exactVersionImports:2,memberClients:0,vmReset:false,hostedOrNas:false}));
	} else {
	await openSessions();
	await act(0,{kind:"screen",action:"open"},"first-open");
	await act(1,{kind:"screen",action:"open"},"second-open");
	const desktops = (await readdir("/run/office-screens")).sort(); assert.equal(desktops.length,2);
	await closeSessions();
	assert.deepEqual((await readdir("/run/office-screens")).sort(),desktops,"Native session closure leaves both desktop lifetimes intact");
	// Zero member clients/viewers exist during the entire workload. A service
	// reconnect starts fresh native sessions on the existing physical desktops.
	await openSessions();
	const totals = await Promise.all([
		shell(0,"printf '12\\n8\\n' > first.csv; sum=0; while read -r n; do sum=$((sum+n)); done < first.csv; printf '%s\\n' \"$sum\"","first-total"),
		shell(1,"printf '13\\n7\\n' > second.csv; sum=0; while read -r n; do sum=$((sum+n)); done < second.csv; printf '%s\\n' \"$sum\"","second-total"),
	]);
	assert.deepEqual(totals,["20\n","20\n"]);
	assert.equal(await shell(1,"sum=0; for file in first.csv second.csv; do while read -r n; do sum=$((sum+n)); done < \"$file\"; done; printf '%s\\n' \"$sum\"","shared-total"),"40\n");
	await act(0,{kind:"browser",action:"navigate",url:"https://office.example/"},"open-reconciliation");
	await act(0,{kind:"browser",action:"fill",role:"textbox",name:"First total",text:totals[0].trim()},"enter-first");
	await act(0,{kind:"browser",action:"fill",role:"textbox",name:"Second total",text:totals[1].trim()},"enter-second");
	await act(0,{kind:"browser",action:"click",role:"button",name:"Reconcile"},"reconcile");
	const browserResult = await act(0,{kind:"browser",action:"snapshot"},"read-reconciliation");
	assert.match(JSON.stringify(browserResult),/40/); assert.doesNotMatch(JSON.stringify(browserResult),/Pending/);
	await shell(0,"printf '40\\000\\377\\200\\r\\n' > offline-report.bin; test ! -e /var/lib/qorpera-proof-canonical; test ! -e /opt/probe; test ! -e /var/lib/qorpera-office-events","write-report");
	const exported = await act(1,{kind:"transfer",action:"export",source:{realm:"company_computer",path:"offline-report.bin"},destination:{realm:"object_storage"},mediaType:"application/octet-stream"},"export-report");
	assert.equal(exported.kind,"json"); const asset = exported.value;
	const expected = Buffer.from([52,48,0,255,128,13,10]);
	assert.equal(asset.sha256,createHash("sha256").update(expected).digest("hex"));
	const run = runs[1];
	const fileStore = new CloudContentAddressedStore(new HttpNativeCompanyObjectTransport({...objectGateway,companyId:setup.scope.companyId,binding:run.binding,signal:run.signal}));
	const paths = new CloudCompanyPathGateway({binding:run.binding,identity:run.identity,store:fileStore,control:new HttpCloudCompanyPathControl({supabaseUrl:"https://disposable-sql.qorpera.test",serviceRoleKey:"fixture-service",fetch:sqlFetch})});
	const write = paths.tools().find(tool=>tool.name === "company_write"); assert(write);
	const writeInput = {path:"offline-report.bin",expectedVersion:null,operationKey:"publish-offline-report",source:{realm:"object_storage",assetId:asset.assetId,sha256:asset.sha256}};
	const context = {companyId:run.identity.companyId,runId:run.identity.runId,identity:run.identity,signal:run.signal};
	const written = await write.execute(writeInput,context); assert.equal(written.kind,"json"); assert.equal(written.value.state,"applied");
	assert.deepEqual(await write.execute(writeInput,context),written,"Canonical publication replay is inert");
	await act(0,{kind:"transfer",action:"import",source:{realm:"company_file",path:"offline-report.bin",version:written.value.version},destination:{realm:"company_computer",path:"restored-report.bin"}},"read-live-company-file");
	assert.equal(await shell(0,"cmp offline-report.bin restored-report.bin && printf exact","check-live-company-file"),"exact");
	await closeSessions();
	assert.deepEqual((await readdir("/run/office-screens")).sort(),desktops);
	await guest.close();
	assert.deepEqual(await readdir("/run/office-screens"),[]);
	assert.deepEqual(await readdir("/run/office-browser"),[]);
	// Reconstruct the actual guest adapters. This is not a VM/container reset.
	guest = new CompanyComputerLinuxGuest(guestOptions);
	gate = new CompanyComputerScreenActionGate();
	await openSessions();
	assert.equal(await shell(1,"cmp offline-report.bin restored-report.bin && printf retained","reopened-workbench"),"retained");
	await act(1,{kind:"transfer",action:"import",source:setup.companyFile.source,destination:{realm:"company_computer",path:"original-source.bin"}},"read-original-after-reopen");
	assert.deepEqual(await readFile(`${layout.workbenchRoot}/original-source.bin`),original);
	assert.deepEqual(await store.get(setup.scope.companyId,asset.sha256,expected.length),expected);
	await closeSessions(); await guest.close();
	assert.deepEqual(errors,[]);
	await writeFile(`${canonicalRoot}/proof.json`,JSON.stringify({source:{realm:"company_file",path:"offline-report.bin",version:written.value.version},bytes:expected.toString("base64"),objects:await observeObjects()}),{flag:"wx",mode:0o600});
	console.log(JSON.stringify({schema:"qorpera.office-linux-combined-proof/v1",actualSql:true,nativeRuns:2,persistentDesktops:2,memberClients:0,viewerConnections:0,
		browserReconciledTotal:40,officeTls:true,canonicalPublication:"applied",publicationReplay:"same-result",liveCompanyFileImport:true,binaryBytes:expected.length,
		guestAdapterReconstruction:true,originalCanonicalBinaryRetained:true,vmReset:false,fixtures:["SQL transport","physical adoption/readiness","prior browser sign-in","browser page content"],hostedOrNas:false}));
	}
} finally {
	await closeSessions(); await listener.close(); await guest.close();
	await new Promise(resolve=>objects.close(resolve));
	for (const run of runs) run.close();
	input.close(); process.stdin.unref();
}
