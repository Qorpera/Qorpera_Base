import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DESKTOP_SOURCE_IMAGE, startDesktopSource } from "./test-runtime-office-desktop.mjs";
import { testMemberFileExportHttp } from "./test-member-file-export-http.mjs";
import { testMemberWebExportsSql } from "./test-member-web-exports-sql.mjs";
import { createNativeBinaryReviewProposal, testMemberWebNativeReviewSql } from "./test-member-web-native-review-sql.mjs";

// Actual SQL + native ledger + office TLS + guest automation + Linux file read
// and import + HTTP object gateway + disk/journal. SQL transport, Xvfb setup and
// office mount admission are fixtures. No hosted API, NAS, provider or model.
export async function testOfficeFileExport({ root, query, setup }) {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-office-export-acceptance-"));
	const container = `qorpera-export-source-${randomUUID()}`;
	const image = "node:22.22.1-trixie-slim@sha256:1c9db0fdddfed0421e2f692fd12761bcc24f860f18206c2a8df17d06270d92a2";
	const sql = value => `'${String(value).replaceAll("'", "''")}'`;
	const valueSql = value => value === null ? "null" : typeof value === "object" ? `${sql(JSON.stringify(value))}::jsonb` : sql(value);
	const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
	const allowed = new Set(["qorpera_describe_native_tool_authority", "qorpera_native_office_descriptor",
		"qorpera_native_office_screen", "qorpera_native_office_operation", "qorpera_native_office_file_export", "qorpera_native_office_file_import",
		"qorpera_begin_native_tool_operation", "qorpera_complete_native_tool_operation",
		"qorpera_native_company_file_write_source", "qorpera_native_company_file_write",
		"qorpera_verify_company_path_file", "qorpera_verify_company_path_tree",
		"qorpera_authorize_native_company_object_upload", "qorpera_confirm_native_company_object_upload", "qorpera_authorize_native_company_object_download"]);
	const calls = [];
	const rpc = (method, args) => {
		assert(allowed.has(method), method);
		const parameters = Object.entries(args).map(([name, value]) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(name)); return `${name}=>${valueSql(value)}`;
		});
		const timing={method,action:args.p_action,started:Date.now()};calls.push(timing);
		let result;
		try {result = query(`${service} select to_jsonb(public.${method}(${parameters.join(",")}));`);}
		catch(error) {console.error(`Disposable export RPC failed: ${method} ${args.p_action ?? ""}`,error);throw error;}
		const parsed=result ? JSON.parse(result) : null;
		timing.elapsedMs=Date.now()-timing.started;timing.validForMs=parsed?.validForMs??parsed?.lease?.validForMs;
		return parsed;
	};
	const beforeHead = query("select head_snapshot_id from public.qorpera_company_files where environment_id=" + sql(setup.scope.environmentId) + "::uuid;");
	const ca = getCACertificates("default");
	let run, session, listener, objects, importedSource;
	let reads = 0, writes = 0, physicalCloses = 0;
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
			"packages/runtime/src/cloud-company-computer-file-transfers.ts": ["createHttpCompanyComputerFileExports"],
			"packages/runtime/src/cloud-company-computer-file-imports.ts": ["createHttpCompanyComputerFileImports"],
			"packages/runtime/src/cloud-company-path-gateway.ts": ["CloudCompanyPathGateway"],
			"packages/runtime/src/cloud-company-path-control.ts": ["HttpCloudCompanyPathControl"],
			"packages/runtime/src/cloud-native-company-objects.ts": ["HttpNativeCompanyObjectTransport"],
			"packages/cloud-client/src/node/cloud-object-store.ts": ["CloudContentAddressedStore"],
			"packages/object-gateway/src/native-objects.ts": ["serveNativeCompanyObject"],
			"packages/object-gateway/src/object-store.ts": ["FileSystemObjectStore"],
			"packages/object-gateway/src/journal.ts": ["ObjectGatewayJournal"],
			"packages/object-gateway/src/replication.ts": ["ObjectGatewayReplication"],
		};
		await build({stdin:{contents:Object.entries(exports).map(([file,names])=>`export {${names.join(",")}} from ${JSON.stringify(join(root,file))};`).join("\n"),resolveDir:root},
			outfile:join(directory,"runtime.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19",
			banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
		await build({entryPoints:[join(root,"packages/runtime/test/fixtures/company-computer-file-export-source.ts")],outfile:join(directory,"source.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19"});
		const code = await import(pathToFileURL(join(directory,"runtime.mjs")).href);
		await build({entryPoints:[join(root,"packages/runtime/test/fixtures/company-computer-desktop-source.ts")],outfile:join(directory,"import-source.mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19"});
		importedSource = await startDesktopSource(directory, `${container}-import`, DESKTOP_SOURCE_IMAGE, "import-source.mjs");
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
		assert(setup.companyFile,"Canonical transfer source fixture required");
		const canonicalBytes=Buffer.from(setup.companyFile.bytesBase64,"base64"),canonicalManifest=Buffer.from(setup.companyFile.manifest,"utf8");
		assert.equal(createHash("sha256").update(canonicalBytes).digest("hex"),setup.companyFile.file.fileSha256);
		assert.equal(createHash("sha256").update(canonicalManifest).digest("hex"),setup.companyFile.file.manifestSha256);
		await store.put(setup.scope.companyId,setup.companyFile.file.fileSha256,canonicalBytes);
		await store.put(setup.scope.companyId,setup.companyFile.file.manifestSha256,canonicalManifest);
		const journal = new code.ObjectGatewayJournal(join(directory,"journal"));
		const replication = new code.ObjectGatewayReplication(journal,store,{});
		const objectToken = randomBytes(32).toString("base64url");
		const objectAuthority = {
			async authorizeNativeUpload(binding,companyId,sha256,bytes) {rpc("qorpera_authorize_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes});},
			async confirmNativeUpload(binding,companyId,sha256,bytes) {rpc("qorpera_confirm_native_company_object_upload",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256,p_bytes:bytes});},
			async authorizeNativeDownload(binding,companyId,sha256) {return rpc("qorpera_authorize_native_company_object_download",{p_binding:binding,p_profile_id:companyId,p_sha256:sha256});},
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
				await importedSource.request({action:"open",binding:lease.binding});
				assert.equal((await importedSource.request({action:"staging-check"})).code,0,"Import staging is absent from shell and host-proc views");
				const automation = new code.CompanyComputerGuestAutomation({binding:lease.binding,
					layout:{workbenchRoot:"/fixture/workbench",desktopHome:"/fixture/desktop",screenStateRoot:"/fixture/screens",browserProfilesRoot:"/fixture/profiles"},
					boundary:{assertReady:async()=>{}},screenshots:{publish:async()=>{throw new Error("UNEXPECTED_CAPTURE");}},
					fileExports:code.createHttpCompanyComputerFileExports({run:bound,scope:setup.scope,registry,objectGateway}),
					fileImports:code.createHttpCompanyComputerFileImports({run:bound,scope:setup.scope,registry,objectGateway}),
					commands:{run:async()=>{throw new Error("UNEXPECTED_SHELL");},capturePng:async()=>{throw new Error("UNEXPECTED_CAPTURE");},
						writeFile:async ({signal,bytes,...file})=>{writes++;await importedSource.request({action:"write",...file,bytes:Buffer.from(bytes).toString("base64")},signal);},
						readFile:async ({path,signal})=>{
							signal.throwIfAborted(); reads++;
							const source = spawnSync("docker",["run","--name",container,"--rm","--pull","never","--platform","linux/amd64","--network","none","--read-only","--user","1000:1000","--cap-drop","ALL","--security-opt","no-new-privileges","--cpus","1","--memory","256m","--pids-limit","64","--tmpfs","/tmp:rw,nosuid,nodev,size=64m,mode=1777","--mount",`type=bind,src=${directory},dst=/probe,readonly`,image,"node","/probe/source.mjs",path],{encoding:"utf8",timeout:15000,maxBuffer:65536});
							assert.equal(source.status,0,source.stderr); signal.throwIfAborted();
							const measured = JSON.parse(source.stdout); assert.equal(measured.path,path);assert.equal(measured.uid,1000);
							return Buffer.from(measured.bytes,"base64");
						}}});
				return {endpoint:new code.CompanyComputerGuestEndpoint({binding:lease.binding,capabilities:descriptor.capabilities,resourceTarget:descriptor.resources,effects,
					gate:new code.CompanyComputerScreenActionGate(),automation,assertScreenAdmitted:async()=>{},prepareScreen:async()=>{}}),close:async()=>{await importedSource.close();physicalCloses++;}};
			}});
		listener = await code.startCompanyComputerNativeGateway({host:"127.0.0.1",port:0,tls:{cert,key},gateway});
		const factory = code.createHttpCompanyComputerSessionFactory({url:`https://127.0.0.1:${listener.port}/office/${setup.scope.companyComputerId}/native`,token,registry});
		session = await factory(run,new code.CloudNativeToolOperations(run,control)); assert(session);
		const tool = session.tools.find(tool=>tool.name==="computer_transfer"); assert(tool);
		const args = {operationKey:"export-acceptance",action:{kind:"transfer",action:"export",source:{realm:"company_computer",path:"exports/$(literal); report.bin"},destination:{realm:"object_storage"},mediaType:"application/octet-stream"}};
		const context = {companyId:run.identity.companyId,runId:run.identity.runId,signal:run.signal};
		let result;
		try {result = await tool.execute(args,context);}
		catch(error) {console.error("Disposable export progress",{reads,physicalCloses,calls});throw error;}
		assert.equal(result.kind,"json"); const asset = result.value;
		const bytes = new Uint8Array([0,255,13,10,1,128]);
		assert.equal(asset.sha256,createHash("sha256").update(bytes).digest("hex"));assert.equal(asset.bytes,bytes.length);
		assert.equal(asset.source.path,args.action.source.path);assert.equal(asset.source.companyComputerId,setup.scope.companyComputerId);
		assert.deepEqual(new Uint8Array(await store.get(setup.scope.companyId,asset.sha256,asset.bytes)),bytes);
		assert.deepEqual(await tool.execute(args,context),result);assert.equal(reads,1);
		assert.equal(calls.filter(call=>call.method==="qorpera_native_office_operation"&&call.action==="begin").length,1);
		assert.equal(calls.filter(call=>call.method==="qorpera_complete_native_tool_operation").length,1);
		assert.deepEqual(errors,[]);
		const receipt = JSON.parse(query(`select jsonb_build_object('state',r.status,'result',r.result,'resource',o.state,'hold',h.released_at is null and h.expires_at is null)
			from public.qorpera_runtime_office_file_exports e join public.qorpera_run_operation_receipts r on r.id=e.receipt_id
			join public.qorpera_runtime_office_resources o on o.receipt_id=e.receipt_id join public.qorpera_artifact_retention_holds h on h.client_hold_id=e.receipt_id
			where e.artifact_id=${sql(asset.assetId)}::uuid;`));
		assert.equal(receipt.state,"completed");assert.equal(receipt.resource,"drained");assert.equal(receipt.hold,true);
		assert.deepEqual(receipt.result.content,result);
		const importInput={operationKey:"import-acceptance",action:{kind:"transfer",action:"import",source:{realm:"object_storage",assetId:asset.assetId,sha256:asset.sha256},destination:{realm:"company_computer",path:"imported $(literal).bin"}}};
		const imported=await tool.execute(importInput,context);assert.equal(imported.kind,"json");assert.equal(imported.value.schema,"qorpera.file-import-result/v1");
		assert.deepEqual(Buffer.from(await importedSource.request({action:"read",path:importInput.action.destination.path}),"base64"),Buffer.from(bytes));
		assert.deepEqual(await tool.execute(importInput,context),imported);assert.equal(writes,1);
		const importReceipt=JSON.parse(query(`select jsonb_build_object('state',r.status,'result',r.result,'resource',o.state,'hold',h.released_at is null and h.expires_at is null)
		 from public.qorpera_runtime_office_file_imports i join public.qorpera_run_operation_receipts r on r.id=i.receipt_id
		 join public.qorpera_runtime_office_resources o on o.receipt_id=i.receipt_id join public.qorpera_artifact_retention_holds h on h.client_hold_id=i.receipt_id
		 where i.receipt_id=${sql(imported.value.transferId)}::uuid;`));
		assert.equal(importReceipt.state,"completed");assert.equal(importReceipt.resource,"drained");assert.equal(importReceipt.hold,true);assert.deepEqual(importReceipt.result.content,imported);
		const canonicalInput={operationKey:"company-file-import-acceptance",action:{kind:"transfer",action:"import",source:setup.companyFile.source,destination:{realm:"company_computer",path:"company-file-import.bin"}}};
		const canonicalImported=await tool.execute(canonicalInput,context);assert.equal(canonicalImported.kind,"json");
		assert.deepEqual(Buffer.from(await importedSource.request({action:"read",path:canonicalInput.action.destination.path}),"base64"),canonicalBytes);
		assert.deepEqual(await tool.execute(canonicalInput,context),canonicalImported);assert.equal(writes,2);
		assert.equal(canonicalImported.value.source.version,setup.companyFile.source.version);assert.equal(canonicalImported.value.source.sha256,setup.companyFile.file.fileSha256);
		const canonicalReceipt=JSON.parse(query(`select jsonb_build_object('state',r.status,'resource',o.state,'hold',h.released_at is null and h.expires_at is null,'graph',g.status,'closure',g.closure_verified,'objects',g.object_count)
		 from public.qorpera_runtime_office_company_file_imports i join public.qorpera_run_operation_receipts r on r.id=i.receipt_id
		 join public.qorpera_runtime_office_resources o on o.receipt_id=i.receipt_id join public.qorpera_artifact_retention_holds h on h.client_hold_id=i.receipt_id
		 join public.qorpera_object_reachability_graphs g on g.root_id=i.artifact_id where i.receipt_id=${sql(canonicalImported.value.transferId)}::uuid;`));
		assert.deepEqual(canonicalReceipt,{state:"completed",resource:"drained",hold:true,graph:"complete",closure:true,objects:2});
		const screenRenewals=calls.filter(call=>call.method==="qorpera_native_office_screen"&&call.action==="renew").length;
		assert(screenRenewals>0,"Continued tool activity renews the actual SQL screen lease");
		assert.equal(query("select head_snapshot_id from public.qorpera_company_files where environment_id="+sql(setup.scope.environmentId)+"::uuid;"),beforeHead);
		await session.close();session=undefined;await listener.close();listener=undefined;
		assert.equal(physicalCloses,1);
		assert.equal(query("select count(*) from public.qorpera_runtime_office_resources where state='active';"),"0");
		assert.equal(query("select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"),"0");
		console.log(JSON.stringify({schema:"qorpera.office-file-export-acceptance/v1",actualSql:true,nativeLedger:true,officeTls:true,linuxReaderUid:1000,
			objectHttp:true,physicalObjectBytes:bytes.length,oneEffect:true,replayReads:0,retentionHold:true,canonicalHeadUnchanged:true,
			activeResources:0,screenLeases:0,mountAdmission:"fixture",hostedOrNas:false}));
		console.log(JSON.stringify({schema:"qorpera.office-file-import-acceptance/v1",actualSql:true,nativeLedger:true,officeTls:true,linuxWriterUid:1000,
		 objectHttp:true,importBytes:bytes.length,writes:1,replayWrites:0,sourceRetention:true,privateStagingAbsentInShell:true,canonicalHeadUnchanged:true,activeResources:0,screenLeases:0,mountAdmission:"fixture",hostedOrNas:false}));
		console.log(JSON.stringify({schema:"qorpera.office-company-file-import-acceptance/v1",actualSql:true,nativeLedger:true,canonicalMutationGateway:true,officeTls:true,linuxWriterUid:1000,
		 objectHttp:true,importBytes:canonicalBytes.length,writes:1,replayWrites:0,screenRenewals,exactPathVersion:true,retainedClosureObjects:canonicalReceipt.objects,canonicalHeadUnchanged:true,activeResources:0,screenLeases:0,mountAdmission:"fixture",hostedOrNas:false}));
		// The completed export is company data. Writing it through the headless
		// Company File gateway no longer needs the producing office connection.
		const fileStore=new code.CloudContentAddressedStore(new code.HttpNativeCompanyObjectTransport({
		 ...objectGateway,companyId:setup.scope.companyId,binding:run.binding,signal:run.signal}));
		const paths=new code.CloudCompanyPathGateway({binding:run.binding,identity:run.identity,store:fileStore,
		 control:new code.HttpCloudCompanyPathControl({supabaseUrl:"https://disposable-sql.qorpera.test",serviceRoleKey:"fixture-service",fetch:sqlFetch})});
		const writeInput={path:"published-export.bin",expectedVersion:null,operationKey:"binary-write-acceptance",
		 source:{realm:"object_storage",assetId:asset.assetId,sha256:asset.sha256}};
		const writeTool=paths.tools().find(candidate=>candidate.name==="company_write");assert(writeTool);
		const written=await writeTool.execute(writeTool.parseArguments(writeInput),{...context,identity:run.identity});
		assert.equal(written.kind,"json");assert.equal(written.value.state,"applied");
		const afterHead=query("select head_snapshot_id from public.qorpera_company_files where environment_id="+sql(setup.scope.environmentId)+"::uuid;");
		assert.notEqual(afterHead,beforeHead);assert.equal(written.value.snapshotId,afterHead);
		const writtenEntry=JSON.parse(query(`select jsonb_build_object('version',version,'entry',entry) from public.qorpera_company_path_entries
		 where environment_id=${sql(setup.scope.environmentId)}::uuid and path=${sql(writeInput.path)};`));
		assert.equal(writtenEntry.version,written.value.version);
		assert(Buffer.from((await fileStore.restoreFile(setup.scope.companyId,writtenEntry.entry.file)).bytes).equals(Buffer.from(bytes)));
		assert.deepEqual(await writeTool.execute(writeInput,{...context,identity:run.identity}),written);
		assert.equal(calls.filter(call=>call.method==="qorpera_native_company_file_write"&&call.action==="commit").length,1);
		assert.equal(query("select head_snapshot_id from public.qorpera_company_files where environment_id="+sql(setup.scope.environmentId)+"::uuid;"),afterHead);
		const writtenReceipt=JSON.parse(query(`select jsonb_build_object('source',w.source,'result',r.result,'status',r.status,
		 'hold',h.released_at is null and h.expires_at is null) from public.qorpera_company_file_asset_writes w
		 join public.qorpera_run_operation_receipts r on r.id=w.receipt_id join public.qorpera_artifact_retention_holds h on h.client_hold_id=w.receipt_id
		 where w.receipt_id=${sql(written.value.receiptId)}::uuid;`));
		assert.deepEqual(writtenReceipt,{source:asset,result:written.value,status:"completed",hold:true});assert.deepEqual(errors,[]);
		assert.equal(query("select count(*) from public.qorpera_runtime_office_resources where state='active';"),"0");
		assert.equal(query("select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"),"0");
		console.log(JSON.stringify({schema:"qorpera.company-file-asset-write-acceptance/v1",actualSql:true,nativeLedger:true,canonicalMutationGateway:true,
		 objectHttp:true,binaryBytes:bytes.length,mutations:1,replayMutations:0,canonicalHeadAdvanced:true,replayHeadUnchanged:true,
		 exactDestinationVersion:true,sourceProvenance:true,sourceRetention:true,officeConnectionClosed:true,activeResources:0,screenLeases:0,hostedOrNas:false}));
		const pendingReview=process.env.QORPERA_WEB_NATIVE_REVIEW_TEST_BROWSER ? await createNativeBinaryReviewProposal({
			query,companyId:setup.scope.companyId,environmentId:setup.scope.environmentId,asset,bytes,binding:run.binding,
			write:input=>writeTool.execute(writeTool.parseArguments(input),{...context,identity:run.identity}),
		}) : null;
		const nativeSignal=run.signal;run.close();run=undefined;assert(nativeSignal.aborted);
		await testMemberFileExportHttp({root,query,store,replication,companyId:setup.scope.companyId,environmentId:setup.scope.environmentId,asset,bytes});
		await testMemberWebExportsSql({root,query,store,replication,companyId:setup.scope.companyId,environmentId:setup.scope.environmentId,asset,bytes});
		if(pendingReview)await testMemberWebNativeReviewSql({root,query,store,replication,companyId:setup.scope.companyId,environmentId:setup.scope.environmentId,asset,bytes,pendingReview});
	} catch(error) {
		console.error("Disposable transfer acceptance failed",{reads,writes,calls:calls.slice(-16)});
		try {console.error("Disposable lease clocks",query(`select jsonb_build_object('now',clock_timestamp(),'native',
		 (select jsonb_build_object('status',status,'expiresAt',expires_at) from public.qorpera_native_provider_connection_leases where id=${sql(setup.binding.leaseId)}::uuid),
		 'screens',(select jsonb_agg(jsonb_build_object('leaseId',lease_id,'expiresAt',lease_expires_at)) from public.qorpera_runtime_office_screens));`));}
		catch(diagnosticError){console.error("Disposable lease diagnostic failed",diagnosticError);}
		throw error;
	} finally {
		const closed = await Promise.allSettled([session?.close()]);
		closed.push(...await Promise.allSettled([listener?.close(),importedSource?.close()])); run?.close();
		if(objects) await new Promise(resolve=>{objects.closeAllConnections();objects.close(resolve);});
		setDefaultCACertificates(ca);
		const cleanup = spawnSync("docker",["rm","--force",container],{encoding:"utf8",timeout:15000});
		const importCleanup = spawnSync("docker",["rm","--force",`${container}-import`],{encoding:"utf8",timeout:15000});
		await rm(directory,{recursive:true,force:true});
		if(cleanup.error) throw cleanup.error;
		if(importCleanup.error || (importCleanup.status!==0&&!importCleanup.stderr.includes("No such container"))) throw new Error("IMPORT_SOURCE_CLEANUP_FAILED");
		if(cleanup.status!==0&&!cleanup.stderr.includes("No such container")) throw new Error("EXPORT_SOURCE_CLEANUP_FAILED");
		for(const result of closed) if(result.status==="rejected") throw result.reason;
	}
}
