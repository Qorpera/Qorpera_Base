import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("packages a standalone office provider without runtime, desktop or browser dependencies", async () => {
	const root = await mkdtemp(join(tmpdir(), "office-provider-package-"));
	try {
		const packaged = spawnSync(process.execPath, ["scripts/package-lxd-office-provider.mjs", "--out", root], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
		assert.equal(packaged.status, 0, packaged.stderr);
		const file = join(root, "qorpera-office-provider.cjs"), bytes = await readFile(file);
		const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
		const artifacts = [];
		for (const file of ["qorpera-office-provider.cjs", "qorpera-office-host-namespace.cjs", "qorpera-office-provider-install.cjs", "qorpera-office-software-update.cjs", "qorpera-office-provider.service.in", "qorpera-office-host-namespace.service"]) {
			const bytes = await readFile(join(root, file));
			artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
		}
		assert.deepEqual(manifest, { schema: "qorpera.lxd-office-provider-package/v1", runtime: { node: ">=22.19.0", platform: "linux" }, artifacts });
		const installerArguments = spawnSync(process.execPath, [join(root, "qorpera-office-provider-install.cjs"), "--unexpected"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(installerArguments.status, 2); assert.equal(installerArguments.stderr, "OFFICE_INSTALL_ARGUMENTS_INVALID\n");
		const helperArguments = spawnSync(process.execPath, [join(root, "qorpera-office-host-namespace.cjs"), "--unexpected"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(helperArguments.status, 2); assert.equal(helperArguments.stderr, "OFFICE_HOST_NAMESPACE_ARGUMENTS_INVALID\n");
		for (const source of ["packages/runtime/", "packages/shell/", "packages/cloud-client/"]) assert(!bytes.includes(source));
		const update = join(root, "qorpera-office-software-update.cjs");
		const updateArguments = spawnSync(process.execPath, ["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", update, "--config", "relative", "begin"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(updateArguments.status, 2); assert.equal(updateArguments.stderr, "OFFICE_SOFTWARE_UPDATE_ARGUMENTS_INVALID\n");
		const updateHelp = spawnSync(process.execPath, ["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", update, "--help"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(updateHelp.status, 0, updateHelp.stderr); assert.match(updateHelp.stdout, /journal flock/);
		const updateMissing = spawnSync(process.execPath, [update, "--config", join(root, "missing.json"), "status"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(updateMissing.status, 1); assert.equal(updateMissing.stderr, "OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID\n");
		const help = spawnSync(process.execPath, ["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", file, "--help"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /process-owned journal flock/);
		const invalid = spawnSync(process.execPath, [file, "--config", "relative"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(invalid.status, 2); assert.equal(invalid.stderr, "OFFICE_PROVIDER_ARGUMENTS_INVALID\n");
		const missing = spawnSync(process.execPath, [file, "--config", join(root, "missing")], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
		assert.equal(missing.status, 1); assert.equal(missing.stderr, "OFFICE_PROVIDER_SERVICE_UNCONFIRMED\n");
		const journalModule=join(root,'journal-fixture.cjs');
		await build({entryPoints:['packages/runner-orchestrator/src/lxd-office-operations.ts'],outfile:journalModule,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});
		const {LxdOfficeOperationJournal}=createRequire(import.meta.url)(journalModule);
		const stateRoot=await realpath(await mkdtemp(join(root,'private-state-'))),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
		const binding={schema:'qorpera.lxd-office-guest/v2',providerId:id(7),providerPolicySha256:'f'.repeat(64),companyId:id(1),environmentId:id(2),companyComputerId:id(3),
		 logicalComputerId:id(4),computerGeneration:1,allocationId:id(5),project:'offices',imageFingerprint:'a'.repeat(64),bootstrapSha256:'b'.repeat(64),storagePool:'office-vms',
		 rootDiskBytes:64*1024**3,workbenchSource:'/private-not-for-diagnostics/workbench',network:'office-net',cpus:2,memoryBytes:4*1024**3};
		// The actual journal writes all records; only daemon outcomes are fixtures.
		const journal=await LxdOfficeOperationJournal.open(stateRoot,id(6),binding,{
		 submitInstanceOperation:async(project,action)=>({project,instanceName:action.request.name,operationId:id(100)}),inspectInstanceOperation:async()=>'succeeded'
		},false,()=>new Date('2026-09-09T02:00:00.000Z'));
		await journal.reconcile(id(10),'create',new AbortController().signal);
		const snapshot=async()=>Promise.all((await readdir(join(stateRoot,id(5)))).sort().map(async name=>[name,(await readFile(join(stateRoot,id(5),name))).toString('base64')]));
		const before=await snapshot();
		const history=spawnSync(process.execPath,['--jitless','--disable-proto=throw','--disallow-code-generation-from-strings',file,'--journal-history',stateRoot,id(5)],{cwd:tmpdir(),encoding:'utf8',timeout:10000});
		assert.equal(history.status,0,history.stderr);assert.deepEqual(JSON.parse(history.stdout),await journal.history());
		assert.equal(JSON.parse(history.stdout).events[2].recordedAt,'2026-09-09T02:00:00.000Z');assert(!history.stdout.includes('private-not-for-diagnostics'));
		assert.deepEqual(await snapshot(),before);
		const absentHistory=spawnSync(process.execPath,[file,'--journal-history',stateRoot,id(99)],{cwd:tmpdir(),encoding:'utf8',timeout:10000});
		assert.equal(absentHistory.status,1);assert.equal(absentHistory.stderr,'OFFICE_PROVIDER_HISTORY_UNCONFIRMED\n');assert.deepEqual(await readdir(stateRoot),[id(5)]);
	} finally { await rm(root, { recursive: true, force: true }); }
});
