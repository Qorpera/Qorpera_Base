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
} from "@qorpera/contracts";
import { controlCompanyComputerConfiguration } from "../../src/cloud-company-computer-configuration-control.ts";
import {
	type CompanyComputerPreparationUnitState,
	controlCompanyComputerPreparation,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "../../src/cloud-company-computer-preparation-control.ts";

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
	let inspections = 0;
	await controlCompanyComputerConfiguration(
		await load(`${root}/fixture-command.json`),
		{
			async inspect() {
				inspections++;
				if (scenario === "partial" && inspections === 3) throw new Error("synthetic interrupted installation");
				if (scenario === "partial-crash" && inspections === 3) process.kill(process.pid, "SIGKILL");
				if (scenario === "changed-evidence" && inspections === 2) await writeFile(`${root}/result.json`, "{}");
				return load(`${root}/fixture-unit.json`);
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
	);
} else {
	assert.equal(mode, "--parent");
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid?.(), 0);
	const cert = await readFile("/fixture-cert", "utf8"),
		key = await readFile("/fixture-key", "utf8");
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const scenarios = [
		"normal",
		"boot-directory-mode",
		"boot-directory-owner",
		"boot-directory-symlink",
		"boot-credentials-mode",
		"boot-existing-conflict",
		"boot-existing-symlink",
		"boot-existing-hardlink",
		"boot-existing-fifo",
		"boot-missing-after-completion",
		"boot-changed-after-completion",
		"boot-directory-missing-after-completion",
		"boot-mode-after-completion",
		"partial",
		"partial-crash",
		"no-lock",
		"cancelled",
		"wrong-boot",
		"stage-hash",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"stage-hardlink",
		"stage-fifo",
		"stage-large",
		"schema",
		"extra-key",
		"config-scope",
		"config-generation",
		"config-layout",
		"config-receipt",
		"config-limits",
		"config-private",
		"config-endpoint",
		"same-command",
		"credentials-reused",
		"credentials-invalid",
		"tls-invalid",
		"directory-mode",
		"directory-owner",
		"receipt-missing",
		"receipt-changed",
		"completion-missing",
		"completion-old",
		"invocation-changed",
		"unit-running",
		"changed-evidence",
		"existing-conflict",
		"existing-mode",
		"existing-owner",
		"existing-symlink",
		"existing-hardlink",
		"existing-fifo",
		"missing-after-completion",
		"changed-after-completion",
		"claim-missing-after-completion",
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
		const run = (mode: string, selected = scenario) =>
			spawnSync(
				scenario === "no-lock" && mode === "--configure" ? process.execPath : "/usr/bin/flock",
				[
					...(scenario === "no-lock" && mode === "--configure"
						? []
						: ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/probe.mjs",
					mode,
					selected,
				],
				{ encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
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
			if (scenario === "config-scope") configuration.scope.companyId = id(99);
			if (scenario === "config-generation") configuration.computerGeneration++;
			if (scenario === "config-layout") configuration.linux.layout.workbenchRoot = "/other";
			if (scenario === "config-receipt") configuration.linux.attestation.adoptionReceiptSha256 = "9".repeat(64);
			if (scenario === "config-limits") configuration.linux.limits.pids++;
			if (scenario === "config-private") configuration.linux.privateWorkbenchMount.mountPoint = "/other";
			if (scenario === "config-endpoint") configuration.registryUrl = "https://secret@registry.invalid";
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
			if (scenario === "schema") input.schema = "old";
			if (scenario === "extra-key") Object.assign(input, { command: "forbidden" });
			if (scenario === "credentials-reused") input.objects = input.native;
			if (scenario === "credentials-invalid") input.native = "must-not-leak";
			if (scenario === "tls-invalid") input.tlsKey = "must-not-leak";
			const encoded = encode(input),
				requestSha256 = hash(encoded);
			const staging = `${root}/configuration-incoming-${requestSha256}.json`;
			const command = {
				commandId: scenario === "same-command" ? preparation.commandId : id(11),
				requestSha256,
				bootId: scenario === "wrong-boot" ? id(99) : bootId,
			};
			await save(`${root}/fixture-command.json`, command);
			await writeFile(staging, encoded, { mode: 0o400 });
			if (scenario === "stage-hash") await writeFile(staging, "{}");
			if (scenario === "stage-large") await writeFile(staging, "x".repeat(196609));
			if (scenario === "stage-mode") await chmod(staging, 0o644);
			if (scenario === "stage-owner") await chown(staging, 1000, 1000);
			if (scenario === "stage-symlink") {
				await unlink(staging);
				await symlink(`${root}/fixture-command.json`, staging);
			}
			if (scenario === "stage-hardlink") await link(staging, `${root}/other-stage`);
			if (scenario === "stage-fifo") {
				await unlink(staging);
				assert.equal(spawnSync("mkfifo", [staging]).status, 0);
			}
			if (scenario === "directory-mode") await chmod("/etc/qorpera-office/credentials", 0o755);
			if (scenario === "directory-owner") await chown("/etc/qorpera-office/credentials", 1000, 1000);
			if (scenario === "receipt-missing") await unlink("/etc/qorpera-office/adoption.json");
			if (scenario === "receipt-changed") await writeFile("/etc/qorpera-office/adoption.json", "{}");
			if (scenario === "completion-missing") await unlink(`${root}/completion.json`);
			if (scenario === "completion-old") {
				const old = await load(`${root}/completion.json`);
				old.schema = "old";
				await save(`${root}/completion.json`, old);
			}
			if (scenario === "invocation-changed")
				await save(`${root}/fixture-unit.json`, { ...completed, invocationId: "b".repeat(32) });
			if (scenario === "unit-running") await save(`${root}/fixture-unit.json`, { ...completed, mainPid: 42 });
			const bootDirectory = companyComputerBootDirectory(bootId),
				bootConfig = `${bootDirectory}/credentials/config.json`;
			if (scenario.startsWith("boot-") && !scenario.endsWith("after-completion")) {
				await mkdir("/etc/qorpera-office/boots", { mode: 0o755 });
				await mkdir(bootDirectory, { mode: 0o755 });
				await mkdir(`${bootDirectory}/credentials`, { mode: 0o700 });
				if (scenario === "boot-directory-mode") await chmod(bootDirectory, 0o777);
				if (scenario === "boot-directory-owner") await chown(bootDirectory, 1000, 1000);
				if (scenario === "boot-directory-symlink") {
					await rm(bootDirectory, { recursive: true });
					await symlink("/etc/qorpera-office/credentials", bootDirectory);
				}
				if (scenario === "boot-credentials-mode") await chmod(`${bootDirectory}/credentials`, 0o755);
				if (scenario === "boot-existing-conflict") await writeFile(bootConfig, "conflict", { mode: 0o400 });
				if (scenario === "boot-existing-symlink") await symlink("/fixture-cert", bootConfig);
				if (scenario === "boot-existing-hardlink") {
					await writeFile(bootConfig, input.configuration, { mode: 0o400 });
					await link(bootConfig, `${bootDirectory}/other`);
				}
				if (scenario === "boot-existing-fifo") assert.equal(spawnSync("mkfifo", [bootConfig]).status, 0);
			}
			const installedConfig = "/etc/qorpera-office/credentials/config.json";
			if (scenario.startsWith("existing-")) {
				await writeFile(installedConfig, scenario === "existing-conflict" ? "other" : input.configuration, {
					mode: 0o400,
				});
				if (scenario === "existing-mode") await chmod(installedConfig, 0o644);
				if (scenario === "existing-owner") await chown(installedConfig, 1000, 1000);
				if (scenario === "existing-symlink") {
					await unlink(installedConfig);
					await symlink(staging, installedConfig);
				}
				if (scenario === "existing-hardlink") await link(installedConfig, "/etc/qorpera-office/other-config");
				if (scenario === "existing-fifo") {
					await unlink(installedConfig);
					assert.equal(spawnSync("mkfifo", [installedConfig]).status, 0);
				}
			}
			const afterCompletion = scenario.endsWith("after-completion");
			const first = run("--configure");
			assert.equal(
				first.status,
				scenario === "normal" || afterCompletion ? 0 : scenario === "partial-crash" ? null : 1,
				`${scenario}: ${first.stderr}`,
			);
			if (scenario === "partial-crash") assert.equal(first.signal, "SIGKILL");
			assert(!first.stderr.includes("must-not-leak"));
			if (scenario === "partial" || scenario === "partial-crash" || scenario === "normal" || afterCompletion) {
				const inode = (await lstat(installedConfig)).ino;
				if (scenario === "missing-after-completion") await unlink(installedConfig);
				if (scenario === "changed-after-completion") await writeFile(installedConfig, "changed");
				if (scenario === "claim-missing-after-completion") await unlink(`${root}/configuration-claim.json`);
				if (scenario === "boot-missing-after-completion") await unlink(bootConfig);
				if (scenario === "boot-changed-after-completion") await writeFile(bootConfig, "changed");
				if (scenario === "boot-directory-missing-after-completion") await rm(bootDirectory, { recursive: true });
				if (scenario === "boot-mode-after-completion") await chmod(bootConfig, 0o644);
				const replay = run("--configure", "normal");
				if (scenario === "boot-missing-after-completion")
					await assert.rejects(lstat(bootConfig), { code: "ENOENT" });
				if (scenario === "boot-directory-missing-after-completion")
					await assert.rejects(lstat(bootDirectory), { code: "ENOENT" });
				if (scenario === "boot-changed-after-completion")
					assert.equal(await readFile(bootConfig, "utf8"), "changed");
				assert.equal(replay.status, afterCompletion ? 1 : 0, `${scenario} replay: ${replay.stderr}`);
				if (scenario === "missing-after-completion") await assert.rejects(lstat(installedConfig));
				else assert.equal((await lstat(installedConfig)).ino, inode);
				if (scenario === "changed-after-completion")
					assert.equal(await readFile(installedConfig, "utf8"), "changed");
				if (!afterCompletion) {
					const result = await load(`${root}/configuration-completion.json`);
					assert.deepEqual(result.command, command);
					assert.deepEqual(result.preparation, preparation);
					assert.equal(result.adoptionReceiptSha256, hash(encode(receipt)));
					for (const [name, info] of Object.entries(result.files)) {
						const path = `/etc/qorpera-office/credentials/${name}`,
							bytes = await readFile(path),
							stat = await lstat(path);
						assert.deepEqual(info, { bytes: bytes.length, sha256: hash(bytes) });
						assert.equal(stat.mode & 0o7777, 0o400);
						assert.equal(stat.uid, 0);
						assert.equal(stat.gid, 0);
						assert.equal(stat.nlink, 1);
						const selected = `${bootDirectory}/credentials/${name}`,
							selectedStat = await lstat(selected);
						assert((await readFile(selected)).equals(bytes));
						assert.equal(selectedStat.mode & 0o7777, 0o400);
						assert.equal(selectedStat.uid, 0);
						assert.equal(selectedStat.gid, 0);
						assert.equal(selectedStat.nlink, 1);
						assert.notEqual(selectedStat.ino, stat.ino);
					}
					assert.equal(Object.keys(result.files).length, 6);
					assert(!JSON.stringify(result).includes(input.registry));
				}
			} else await assert.rejects(lstat(`${root}/configuration-completion.json`));
		} finally {
			await lock.close();
		}
		console.log(
			JSON.stringify({
				schema: "qorpera.office-configuration-linux-proof/v1",
				scenario,
				actualProtectedFiles: true,
				actualKernelFlock: true,
				actualTlsValidation: true,
				syntheticCredentials: true,
				syntheticSystemdManager: true,
				serviceStarted: false,
				activated: false,
			}),
		);
	}
}
