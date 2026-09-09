import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import { controlCompanyComputerConfiguration } from "../../src/cloud-company-computer-configuration-control.ts";
import {
	type CompanyComputerPreparationUnitState,
	controlCompanyComputerPreparation,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "../../src/cloud-company-computer-preparation-control.ts";
import {
	controlCompanyComputerServiceStart,
	inspectCompanyComputerServiceStart,
} from "../../src/cloud-company-computer-service-start-control.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode });
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const inactive: CompanyComputerPreparationUnitState = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
const completed = {
	...inactive,
	invocationId: "a".repeat(32),
	activeState: "active",
	subState: "exited",
	execMainCode: 1,
};
const ordinary = { ...inactive, controlGroup: "", restarts: 0 };
const running = {
	...ordinary,
	invocationId: "b".repeat(32),
	activeState: "active",
	subState: "running",
	mainPid: 42,
	controlGroup: "/system.slice/qorpera-company-computer.service",
};
const [mode, scenario] = process.argv.slice(2);
if (mode === "--prepare") {
	const command = await load(`${root}/fixture-preparation.json`);
	await controlCompanyComputerPreparation(
		command,
		{
			inspect: async () => load(`${root}/fixture-unit.json`),
			async start() {
				const request = parseCompanyComputerPreparationRequest(await load("/etc/qorpera-office/preparation.json"));
				await save(`${root}/result.json`, {
					schema: "qorpera.office-guest-preparation-result/v1",
					state: "prepared",
					scope: request.scope,
					computerGeneration: request.computerGeneration,
					allocationId: request.allocationId,
					instanceSha256: request.instanceSha256,
					imageSha256: request.imageSha256,
					bootstrapSha256: request.bootstrapSha256,
					bootId: request.bootId,
					copy: request.copy,
					workbenchMount: request.workbenchMount,
					contentSha256: hash(JSON.stringify(request.entries)),
					observationSha256: "e".repeat(64),
					entries: request.entries.length,
					totalBytes: 0,
					requestSha256: command.requestSha256,
					invocationId: completed.invocationId,
				});
				await save(`${root}/fixture-unit.json`, completed);
			},
		},
		AbortSignal.timeout(10000),
	);
} else if (mode === "--configure") {
	await controlCompanyComputerConfiguration(
		await load(`${root}/fixture-command.json`),
		{ inspect: async () => load(`${root}/fixture-unit.json`) },
		AbortSignal.timeout(10000),
	);
} else if (mode === "--inspect") {
	const command = await load(`${root}/fixture-start-command.json`);
	await inspectCompanyComputerServiceStart(
		command,
		scenario === "same-id"
			? command.commandId
			: scenario === "bad-id"
				? "../unsafe"
				: scenario === "second"
					? id(21)
					: id(20),
		{
			inspect: async () => ({
				preparation: await load(`${root}/fixture-unit.json`),
				service: await load(`${root}/fixture-office-unit.json`),
			}),
			start: async () => {
				await save(`${root}/fixture-start-count.json`, 99);
				throw new Error("inspection must never start");
			},
		},
		AbortSignal.timeout(15000),
	);
} else if (mode === "--start") {
	let inspections = 0;
	await controlCompanyComputerServiceStart(
		await load(`${root}/fixture-start-command.json`),
		{
			async inspect() {
				inspections++;
				if (scenario === "invocation-during-confirmation" && inspections === 4)
					await save(`${root}/fixture-office-unit.json`, { ...running, invocationId: "c".repeat(32) });
				return {
					preparation: await load(`${root}/fixture-unit.json`),
					service: await load(`${root}/fixture-office-unit.json`),
				};
			},
			async start() {
				if (scenario === "crash-before-start") process.kill(process.pid, "SIGKILL");
				await save(`${root}/fixture-start-count.json`, (await load(`${root}/fixture-start-count.json`)) + 1);
				if (scenario === "start-failed") throw new Error("must-not-leak");
				await save(`${root}/fixture-office-unit.json`, running);
				if (scenario === "configuration-during-start")
					await writeFile("/etc/qorpera-office/credentials/config.json", "changed");
				if (scenario === "crash-after-start") process.kill(process.pid, "SIGKILL");
				if (scenario === "lost-start-reply") throw new Error("must-not-leak");
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(15000),
	);
} else {
	assert(["--parent", "--seed"].includes(mode));
	assert.equal(process.platform, "linux");
	assert(["x64", "arm64"].includes(process.arch));
	assert.equal(process.getuid?.(), 0);
	const cert = await readFile("/fixture-cert", "utf8"),
		key = await readFile("/fixture-key", "utf8");
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const scenarios =
		mode === "--seed"
			? ["normal"]
			: [
					"normal",
					"crash-before-start",
					"crash-after-start",
					"lost-start-reply",
					"start-failed",
					"invocation-during-confirmation",
					"configuration-during-start",
					"no-lock",
					"cancelled",
					"wrong-boot",
					"same-command",
					"stage-hash",
					"stage-mode",
					"stage-owner",
					"stage-symlink",
					"stage-hardlink",
					"stage-large",
					"schema",
					"extra-key",
					"wrong-ports",
					"wrong-configuration",
					"wrong-receipt",
					"wrong-configuration-command",
					"configuration-completion-missing",
					"configuration-claim-missing",
					"preparation-revoked",
					"directory-mode",
					"credential-owner",
					"credential-mode",
					"credential-changed",
					"boot-credential-missing",
					"boot-credential-changed",
					"boot-credential-mode",
					"boot-directory-mode",
					"boot-directory-owner",
					"boot-credential-missing-after-completion",
					"receipt-changed",
					"running-without-claim",
					"completion-without-claim",
					"missing-claim-after-completion",
					"changed-invocation-after-completion",
					"changed-pid-after-completion",
					"stopped-after-completion",
					"restarted-after-completion",
					"missing-credential-after-completion",
					"changed-claim-after-completion",
				];
	for (const scenario of scenarios) {
		for (const parent of [root, "/etc/qorpera-office"])
			for (const name of await readdir(parent)) await rm(`${parent}/${name}`, { recursive: true, force: true });
		await mkdir("/etc/qorpera-office/credentials", { mode: 0o700 });
		await writeFile(`${root}/control.lock`, "", { mode: 0o600 });
		const request = parseCompanyComputerPreparationRequest({
			schema: "qorpera.office-guest-preparation/v1",
			scope: { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) },
			computerGeneration: 1,
			allocationId: id(5),
			instanceSha256: "a".repeat(64),
			imageSha256: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			bootId,
			uid: 1000,
			gid: 1000,
			copy: {
				adoptionId: id(6),
				observationSha256: "d".repeat(64),
				planSha256: "e".repeat(64),
				reviewSha256: "f".repeat(64),
				outputInventorySha256: "1".repeat(64),
			},
			workbenchMount: {
				filesystem: "virtiofs",
				source: "lxd_workbench",
				root: "/",
				mountPoint: "/var/lib/qorpera-office",
			},
			limits: { memoryBytes: 4 * 1024 ** 3, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
			entries: [".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
				path,
				kind: "directory",
				mode: 0o700,
				bytes: 0,
				sha256: null,
			})),
		});
		const preparation = { commandId: id(10), requestSha256: hash(encode(request)), bootId };
		await save(`${root}/incoming-${preparation.requestSha256}.json`, request, 0o400);
		await save(`${root}/fixture-preparation.json`, preparation);
		await save(`${root}/fixture-unit.json`, inactive);

		const lock = await open(`${root}/control.lock`, "r+");
		const run = (action: string, selected = scenario) =>
			spawnSync(
				scenario === "no-lock" && action === "--start" ? process.execPath : "/usr/bin/flock",
				[
					...(scenario === "no-lock" && action === "--start"
						? []
						: ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/probe.mjs",
					action,
					selected,
				],
				{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		try {
			const prep = run("--prepare");
			assert.equal(prep.status, 0, prep.stderr);
			const receipt = companyComputerPreparationAdoptionReceipt(request);
			const configuration = {
				schema: "qorpera.company-computer-service/v1",
				scope: { ...request.scope },
				computerGeneration: 1,
				registryUrl: "https://registry.invalid",
				captureObjectGatewayUrl: "https://objects.invalid",
				native: { host: "127.0.0.1", port: 9443 },
				viewer: { host: "127.0.0.1", port: 9444, origins: ["https://app.invalid"] },
				linux: {
					layout: { ...receipt.layout },
					limits: { ...request.limits },
					workbenchMount: request.workbenchMount,
					privateWorkbenchMount: {
						filesystem: "tmpfs",
						source: "tmpfs",
						root: "/",
						mountPoint: "/run/qorpera-office/private",
					},
					displayRuntimeRoot: "/run/qorpera-office/display",
					browserRuntimeRoot: "/run/qorpera-office/browser",
					captureRoot: "/run/qorpera-office/captures",
					attestation: {
						allocationId: request.allocationId,
						instanceSha256: request.instanceSha256,
						imageSha256: request.imageSha256,
						bootstrapSha256: request.bootstrapSha256,
						bootId,
						adoptionReceiptPath: "/etc/qorpera-office/adoption.json",
						adoptionReceiptSha256: hash(encode(receipt)),
					},
				},
			};
			const input = {
				schema: "qorpera.office-configuration-request/v1",
				preparation,
				configuration: JSON.stringify(configuration),
				registry: "r".repeat(64),
				native: "n".repeat(43),
				objects: "o".repeat(43),
				tlsCert: cert,
				tlsKey: key,
			};

			const encoded = encode(input);
			const command = { commandId: id(11), requestSha256: hash(encoded), bootId };
			await save(`${root}/fixture-command.json`, command);
			await writeFile(`${root}/configuration-incoming-${command.requestSha256}.json`, encoded, { mode: 0o400 });
			const config = run("--configure");
			assert.equal(config.status, 0, config.stderr);
			const configured = await load(`${root}/configuration-completion.json`);
			const payload = {
				schema: "qorpera.office-service-start-request/v1",
				configuration: configured,
				configurationCompletionSha256: hash(await readFile(`${root}/configuration-completion.json`)),
				attestation: {
					schema: "qorpera.office-activation-attestation/v1",
					activationId: id(12),
					bootId,
					preparationObservationSha256: "1".repeat(64),
					configurationObservationSha256: "2".repeat(64),
					configurationSha256: configured.files["config.json"].sha256,
					adoptionReceiptSha256: configured.adoptionReceiptSha256,
					nativePort: 9443,
					viewerPort: 9444,
				},
			};
			parseCompanyComputerServiceStartRequest(payload);
			if (scenario === "schema") payload.schema = "old";
			if (scenario === "extra-key") Object.assign(payload, { command: "must-not-leak" });
			if (scenario === "wrong-ports") payload.attestation.nativePort = 9445;
			if (scenario === "wrong-configuration") payload.attestation.configurationSha256 = "9".repeat(64);
			if (scenario === "wrong-receipt") payload.attestation.adoptionReceiptSha256 = "9".repeat(64);
			if (scenario === "wrong-configuration-command") payload.configuration.command.commandId = id(99);
			const startBytes = encode(payload),
				startCommand = {
					commandId: scenario === "same-command" ? command.commandId : id(13),
					requestSha256: hash(startBytes),
					bootId: scenario === "wrong-boot" ? id(99) : bootId,
				};
			const stage = `${root}/service-start-incoming-${startCommand.requestSha256}.json`;
			await writeFile(stage, startBytes, { mode: 0o400 });
			await save(`${root}/fixture-start-command.json`, startCommand);
			await save(`${root}/fixture-start-count.json`, 0);
			await save(`${root}/fixture-office-unit.json`, ordinary);
			if (scenario === "stage-hash") await writeFile(stage, "{}");
			if (scenario === "stage-large") await writeFile(stage, "x".repeat(16385));
			if (scenario === "stage-mode") await chmod(stage, 0o644);
			if (scenario === "stage-owner") await chown(stage, 1000, 1000);
			if (scenario === "stage-symlink") {
				await unlink(stage);
				await symlink(`${root}/fixture-start-command.json`, stage);
			}
			if (scenario === "stage-hardlink") await link(stage, `${root}/stage-link`);
			if (scenario === "configuration-completion-missing") await unlink(`${root}/configuration-completion.json`);
			if (scenario === "configuration-claim-missing") await unlink(`${root}/configuration-claim.json`);
			if (scenario === "preparation-revoked")
				await save(`${root}/fixture-unit.json`, { ...completed, invocationId: "c".repeat(32) });
			if (scenario === "directory-mode") await chmod("/etc/qorpera-office/credentials", 0o755);
			if (scenario === "credential-owner") await chown("/etc/qorpera-office/credentials/native", 1000, 1000);
			if (scenario === "credential-mode") await chmod("/etc/qorpera-office/credentials/native", 0o644);
			if (scenario === "credential-changed") await writeFile("/etc/qorpera-office/credentials/native", "changed");
			const bootRoot = companyComputerBootDirectory(bootId),
				bootCredential = `${bootRoot}/credentials/native`;
			if (scenario === "boot-credential-missing") await unlink(bootCredential);
			if (scenario === "boot-credential-changed") await writeFile(bootCredential, "changed");
			if (scenario === "boot-credential-mode") await chmod(bootCredential, 0o644);
			if (scenario === "boot-directory-mode") await chmod(bootRoot, 0o777);
			if (scenario === "boot-directory-owner") await chown(bootRoot, 1000, 1000);
			if (scenario === "receipt-changed") await writeFile("/etc/qorpera-office/adoption.json", "{}");
			if (scenario === "running-without-claim") await save(`${root}/fixture-office-unit.json`, running);
			if (scenario === "completion-without-claim") await save(`${root}/service-start-completion.json`, {});
			const after = scenario.endsWith("after-completion");
			if (scenario === "normal") {
				assert.equal(run("--inspect").status, 1, "inspection admitted an unstarted service");
				await assert.rejects(lstat(`${root}/service-start-claim.json`), { code: "ENOENT" });
			}
			const first = run("--start");
			if (mode === "--seed") {
				assert.equal(first.status, 0, first.stderr);
				console.log("OFFICE_START_SYNTHETIC_SEED_READY");
				continue;
			}
			assert.equal(
				first.status,
				scenario === "normal" || after ? 0 : scenario.startsWith("crash-") ? null : 1,
				`${scenario}: ${first.stderr}`,
			);
			if (scenario.startsWith("crash-")) assert.equal(first.signal, "SIGKILL");
			assert(!first.stderr.includes("must-not-leak"));
			const recovery =
				["normal", "crash-before-start", "crash-after-start", "lost-start-reply", "start-failed"].includes(
					scenario,
				) || after;
			if (recovery) {
				const expectedCount = scenario === "crash-before-start" ? 0 : 1;
				assert.equal(await load(`${root}/fixture-start-count.json`), expectedCount);
				if (scenario === "boot-credential-missing-after-completion") await unlink(bootCredential);
				if (scenario === "missing-claim-after-completion") await unlink(`${root}/service-start-claim.json`);
				if (scenario === "changed-claim-after-completion") await save(`${root}/service-start-claim.json`, {});
				if (scenario === "changed-invocation-after-completion")
					await save(`${root}/fixture-office-unit.json`, { ...running, invocationId: "c".repeat(32) });
				if (scenario === "changed-pid-after-completion")
					await save(`${root}/fixture-office-unit.json`, { ...running, mainPid: 43 });
				if (scenario === "stopped-after-completion") await save(`${root}/fixture-office-unit.json`, ordinary);
				if (scenario === "restarted-after-completion")
					await save(`${root}/fixture-office-unit.json`, { ...running, restarts: 1 });
				if (scenario === "missing-credential-after-completion")
					await unlink("/etc/qorpera-office/credentials/native");
				const replay = run("--start", "normal");
				assert.equal(
					replay.status,
					["normal", "crash-after-start", "lost-start-reply"].includes(scenario) ? 0 : 1,
					`${scenario}: ${replay.stderr}`,
				);
				assert.equal(await load(`${root}/fixture-start-count.json`), expectedCount, "replayed service start");
				if (replay.status === 0) {
					const completed = await load(`${root}/service-start-completion.json`);
					assert.equal(completed.serviceInvocationId, running.invocationId);
					assert.equal(completed.mainPid, 42);
					assert.equal(completed.configurationSha256, configured.files["config.json"].sha256);
					const info = await lstat(`${root}/service-start-completion.json`);
					assert.equal(info.uid, 0);
					assert.equal(info.gid, 0);
					assert.equal(info.mode & 0o7777, 0o600);
					const before = await readFile(`${root}/service-start-completion.json`),
						inode = info.ino;
					assert.equal(run("--start", "normal").status, 0);
					assert(before.equals(await readFile(`${root}/service-start-completion.json`)));
					assert.equal((await lstat(`${root}/service-start-completion.json`)).ino, inode);
					assert.equal(run("--inspect").status, 0);
					const observationPath = `${root}/service-inspection-${id(20)}.json`,
						observationBytes = await readFile(observationPath);
					assert.deepEqual(await load(observationPath), {
						schema: "qorpera.office-service-inspection/v1",
						inspectionId: id(20),
						start: completed,
					});
					assert.equal((await lstat(observationPath)).mode & 0o7777, 0o600);
					assert.equal(run("--inspect", "same-id").status, 1);
					assert.equal(run("--inspect", "bad-id").status, 1);
					await save(`${root}/fixture-office-unit.json`, { ...running, mainPid: 43 });
					assert.equal(run("--inspect").status, 1, "inspection reused stale running evidence");
					assert(observationBytes.equals(await readFile(observationPath)));
					await save(`${root}/fixture-office-unit.json`, running);
					await unlink(`${root}/service-start-completion.json`);
					assert.equal(run("--inspect", "second").status, 1, "inspection repaired missing acknowledgement");
					await assert.rejects(lstat(`${root}/service-start-completion.json`), { code: "ENOENT" });
					await writeFile(`${root}/service-start-completion.json`, before, { mode: 0o600 });
					assert.equal(run("--inspect", "second").status, 0);
					assert.equal(await load(`${root}/fixture-start-count.json`), 1, "inspection issued a start");
				}
			} else if (!["invocation-during-confirmation", "configuration-during-start"].includes(scenario))
				assert.equal(await load(`${root}/fixture-start-count.json`), 0, scenario);
			console.log(
				JSON.stringify({
					scenario,
					actualProtectedFiles: true,
					actualKernelFlock: true,
					syntheticSystemdManager: true,
					actualSigkill: scenario.startsWith("crash-"),
					serviceStartCommands: await load(`${root}/fixture-start-count.json`),
					sqlActivated: false,
				}),
			);
		} finally {
			await lock.close();
		}
	}
}
