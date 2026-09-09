import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	chown,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { companyComputerBootDirectory } from "@qorpera/contracts";
import { controlCompanyComputerBootConfiguration } from "../../src/cloud-company-computer-boot-configuration-control.ts";
import { CompanyComputerLinuxBoundary } from "../../src/cloud-company-computer-linux-boundary.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { laterBootConfigurationFixture } from "./company-computer-later-boot-configuration.ts";

const root = "/run/qorpera-office-preparation",
	mountPoint = "/var/lib/qorpera-office";
const inactive = {
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
const idle = {
	preparation: inactive,
	service: { ...inactive, controlGroup: "", restarts: 0 },
	cgroupState: "absent" as const,
};
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const [mode, scenario] = process.argv.slice(2);
if (mode === "--configure") {
	let inspections = 0;
	const command = await load(`${root}/fixture-command.json`),
		directory = companyComputerBootDirectory(command.bootId);
	await controlCompanyComputerBootConfiguration(
		command,
		{
			async inspect() {
				inspections++;
				if (scenario === "later-changed-during" && inspections === 2)
					await writeFile(`${companyComputerBootDirectory(id(19))}/configuration-claim.json`, "{}");
				if (scenario === "partial" && inspections === 3) throw new Error("synthetic interruption");
				if (scenario === "partial-crash" && inspections === 3) process.kill(process.pid, "SIGKILL");
				if (scenario === "directory-replaced" && inspections === 2) {
					const path = `${mountPoint}/.qorpera-adopted-${id(6)}/workbench`;
					await rename(path, `${path}-old`);
					await mkdir(path, { mode: 0o700 });
					await chown(path, 1000, 1000);
				}
				if (scenario === "permissions-changed" && inspections === 8) await chmod(`${directory}/credentials`, 0o755);
				if (scenario === "preparation-started")
					return { ...idle, preparation: { ...inactive, invocationId: "a".repeat(32) } };
				if (scenario === "service-started")
					return { ...idle, service: { ...idle.service, invocationId: "a".repeat(32) } };
				if (scenario === "service-running") return { ...idle, service: { ...idle.service, mainPid: 42 } };
				if (scenario === "service-restarted") return { ...idle, service: { ...idle.service, restarts: 1 } };
				if (scenario === "descendant") return { ...idle, cgroupState: "populated" as never };
				return idle;
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
	);
} else if (mode === "--boundary") {
	const configuration = await load("/etc/qorpera-office/fixture.json");
	const boundary = new CompanyComputerLinuxBoundary({
		scope: configuration.scope,
		computerGeneration: configuration.computerGeneration,
		...configuration.linux,
		registry: {
			async call() {
				throw new Error("SQL unavailable in physical-only fixture");
			},
		},
	});
	await boundary.assertPhysicalReady(AbortSignal.timeout(10000));
	await assert.rejects(boundary.assertOfficeReady(AbortSignal.timeout(10000)), /UNCONFIRMED/);
} else {
	assert.equal(mode, "--parent");
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid?.(), 0);
	const fd = await open(mountPoint, "r");
	let mount: ReturnType<typeof parseRecoveryDirectoryMount>;
	try {
		mount = parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
		);
	} finally {
		await fd.close();
	}
	assert.notEqual(mount.filesystem, "tmpfs");
	assert.equal(mount.mountPoint, mountPoint);
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const tlsCert = await readFile("/fixture-cert", "utf8"),
		tlsKey = await readFile("/fixture-key", "utf8");
	const scenarios = [
		"later-normal",
		"later-initial",
		"later-first-successor",
		"later-receipt-missing",
		"later-config-changed",
		"later-claim-changed",
		"later-public-mode",
		"later-archive-missing",
		"later-changed-during",
		"normal",
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
		"origin-changed",
		"origin-receipt-changed",
		"history-missing",
		"history-changed",
		"history-mode",
		"power-bytes",
		"observation",
		"config-receipt",
		"tls-invalid",
		"workbench-mode",
		"workbench-owner",
		"workbench-symlink",
		"wrong-mount",
		"directory-replaced",
		"permissions-changed",
		"preparation-started",
		"service-started",
		"service-running",
		"service-restarted",
		"descendant",
		"boot-directory-mode",
		"boot-credentials-mode",
		"boot-config-conflict",
		"boot-config-symlink",
		"boot-config-hardlink",
		"boot-config-fifo",
		"missing-after-completion",
		"changed-after-completion",
		"claim-missing-after-completion",
		"receipt-missing-after-completion",
		"directory-missing-after-completion",
		"permissions-after-completion",
	];
	for (const scenario of scenarios) {
		for (const parent of [root, "/etc/qorpera-office", mountPoint])
			for (const name of await readdir(parent)) await rm(`${parent}/${name}`, { recursive: true, force: true });
		await mkdir("/etc/qorpera-office/credentials", { mode: 0o700 });
		await writeFile(`${root}/control.lock`, "", { mode: 0o600 });
		const options: Parameters<typeof bootConfigurationFixture>[0] = {
			bootId,
			mount: { ...mount, mountPoint, ...(scenario === "wrong-mount" ? { source: "wrong" } : {}) },
			tlsCert,
			tlsKey,
		};
		const f = scenario.startsWith("later-")
			? laterBootConfigurationFixture({
					...options,
					restarts: scenario === "later-initial" ? 0 : scenario === "later-first-successor" ? 1 : 2,
				})
			: bootConfigurationFixture(options);
		for (const [path, file] of f.originFiles) {
			await mkdir(dirname(path), { recursive: true, mode: path.includes("/credentials/") ? 0o700 : 0o755 });
			await writeFile(path, file.bytes, { mode: file.mode });
		}
		await mkdir(f.historyDirectory, { recursive: true, mode: 0o700 });
		for (const [path, bytes] of f.archiveFiles) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, bytes, { mode: 0o600 });
		}
		const adoptionRoot = dirname(f.receipt.layout.workbenchRoot);
		await mkdir(adoptionRoot, { mode: 0o700 });
		await chown(adoptionRoot, 1000, 1000);
		for (const path of Object.values(f.receipt.layout)) {
			await mkdir(path, { mode: 0o700 });
			await chown(path, 1000, 1000);
		}
		const working = [`${f.receipt.layout.workbenchRoot}/note`, `${f.receipt.layout.workbenchRoot}/new-file`];
		for (const path of working) {
			await writeFile(path, path.endsWith("/note") ? "changed since adoption" : "created after adoption", {
				mode: 0o600,
			});
			await chown(path, 1000, 1000);
		}
		const snapshot = async (paths: string[]) =>
			Promise.all(
				paths.map(async (path) => {
					const stat = await lstat(path);
					return {
						path,
						ino: stat.ino,
						mode: stat.mode,
						uid: stat.uid,
						gid: stat.gid,
						sha256: hash(await readFile(path)),
					};
				}),
			);
		const preserved = [...f.originFiles.keys(), ...f.archiveFiles.keys(), ...working],
			before = await snapshot(preserved);
		const input = structuredClone(f.input);
		if (scenario === "power-bytes") Object.assign(input, { powerOffCompletion: input.powerOffCompletion.trim() });
		if (scenario === "observation") Object.assign(input.observation, { bootId: id(99) });
		if (scenario === "config-receipt") {
			const c = JSON.parse(input.material.configuration);
			c.linux.attestation.adoptionReceiptSha256 = "9".repeat(64);
			Object.assign(input.material, { configuration: JSON.stringify(c) });
		}
		if (scenario === "tls-invalid") Object.assign(input.material, { tlsKey: "must-not-leak" });
		const command = {
			...f.command,
			requestSha256: hash(encode(input)),
			...(scenario === "wrong-boot" ? { bootId: id(99) } : {}),
		};
		const staging = `${root}/boot-configuration-incoming-${command.requestSha256}.json`,
			directory = companyComputerBootDirectory(bootId),
			selected = `${directory}/credentials/config.json`,
			completion = `${directory}/configuration-completion.json`;
		await writeFile(staging, encode(input), { mode: 0o400 });
		await writeFile(`${root}/fixture-command.json`, encode(command), { mode: 0o600 });
		if (scenario === "stage-hash") await writeFile(staging, "{}");
		if (scenario === "stage-mode") await chmod(staging, 0o644);
		if (scenario === "stage-owner") await chown(staging, 1000, 1000);
		if (scenario === "stage-symlink") {
			await unlink(staging);
			await symlink(`${root}/fixture-command.json`, staging);
		}
		if (scenario === "stage-hardlink") await link(staging, `${root}/stage-link`);
		if (scenario === "stage-fifo") {
			await unlink(staging);
			assert.equal(spawnSync("mkfifo", [staging]).status, 0);
		}
		if (scenario === "origin-changed") await writeFile("/etc/qorpera-office/preparation.json", "{}");
		if (scenario === "origin-receipt-changed") await writeFile("/etc/qorpera-office/adoption.json", "{}");
		if (scenario === "history-missing") await unlink(`${f.historyDirectory}/claim.json`);
		if (scenario === "history-changed") await writeFile(`${f.historyDirectory}/manifest.json`, "{}");
		if (scenario === "history-mode") await chmod(f.historyDirectory, 0o755);
		const previousDirectory = companyComputerBootDirectory(id(19));
		if (scenario === "later-receipt-missing") await unlink(`${previousDirectory}/adoption.json`);
		if (scenario === "later-config-changed") await writeFile(`${previousDirectory}/credentials/config.json`, "{}");
		if (scenario === "later-claim-changed") await writeFile(`${previousDirectory}/configuration-claim.json`, "{}");
		if (scenario === "later-public-mode") await chmod(`${previousDirectory}/configuration-completion.json`, 0o644);
		if (scenario === "later-archive-missing") await unlink(`${f.historyDirectory}/claim.json`);
		if (scenario === "workbench-mode") await chmod(f.receipt.layout.workbenchRoot, 0o755);
		if (scenario === "workbench-owner") await chown(f.receipt.layout.workbenchRoot, 1001, 1000);
		if (scenario === "workbench-symlink") {
			await rename(f.receipt.layout.workbenchRoot, `${adoptionRoot}/renamed`);
			await symlink("renamed", f.receipt.layout.workbenchRoot);
		}
		if (scenario.startsWith("boot-")) {
			await mkdir(`${directory}/credentials`, { recursive: true, mode: 0o755 });
			await chmod(`${directory}/credentials`, 0o700);
			if (scenario === "boot-directory-mode") await chmod(directory, 0o777);
			if (scenario === "boot-credentials-mode") await chmod(`${directory}/credentials`, 0o755);
			if (scenario === "boot-config-conflict") await writeFile(selected, "conflict", { mode: 0o400 });
			if (scenario === "boot-config-symlink") await symlink("/etc/qorpera-office/credentials/config.json", selected);
			if (scenario === "boot-config-hardlink") {
				await writeFile(selected, input.material.configuration, { mode: 0o400 });
				await link(selected, `${directory}/other`);
			}
			if (scenario === "boot-config-fifo") assert.equal(spawnSync("mkfifo", [selected]).status, 0);
		}
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (selectedScenario = scenario) =>
			spawnSync(
				scenario === "no-lock" ? process.execPath : "/usr/bin/flock",
				[
					...(scenario === "no-lock"
						? []
						: ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/probe.mjs",
					"--configure",
					selectedScenario,
				],
				{ encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		try {
			const acknowledged = scenario.endsWith("after-completion"),
				successful = ["normal", "later-normal", "later-initial", "later-first-successor"].includes(scenario),
				retry = successful || ["partial", "partial-crash"].includes(scenario),
				result = run();
			assert.equal(
				result.status,
				successful || acknowledged ? 0 : scenario === "partial-crash" ? null : 1,
				`${scenario}: ${result.stderr}`,
			);
			assert(!result.stderr.includes("must-not-leak"));
			if (scenario === "partial-crash") assert.equal(result.signal, "SIGKILL");
			if (scenario === "partial" || scenario === "partial-crash") {
				await assert.rejects(lstat(completion), { code: "ENOENT" });
				assert.equal(await readFile(selected, "utf8"), input.material.configuration);
			}
			if (scenario === "missing-after-completion") await unlink(selected);
			if (scenario === "changed-after-completion") await writeFile(selected, "changed");
			if (scenario === "claim-missing-after-completion") await unlink(`${directory}/configuration-claim.json`);
			if (scenario === "receipt-missing-after-completion") await unlink(`${directory}/adoption.json`);
			if (scenario === "directory-missing-after-completion")
				await rm(`${directory}/credentials`, { recursive: true });
			if (scenario === "permissions-after-completion") await chmod(`${directory}/credentials`, 0o755);
			if (retry || acknowledged) {
				const installedBefore = retry
					? await snapshot([selected, `${directory}/adoption.json`, `${directory}/configuration-claim.json`])
					: undefined;
				const replay = run("normal");
				assert.equal(replay.status, acknowledged ? 1 : 0, `${scenario} replay: ${replay.stderr}`);
				if (installedBefore) assert.deepEqual(await snapshot(installedBefore.map((f) => f.path)), installedBefore);
				if (retry) {
					assert.deepEqual(await load(completion), f.completion);
					for (const [file, info] of Object.entries(f.completion.files)) {
						const path = `${directory}/credentials/${file}`,
							stat = await lstat(path),
							bytes = await readFile(path);
						assert.deepEqual({ bytes: bytes.length, sha256: hash(bytes) }, info);
						assert.equal(stat.mode & 0o7777, 0o400);
						assert.equal(stat.uid, 0);
						assert.equal(stat.gid, 0);
						assert.equal(stat.nlink, 1);
					}
				}
				if (["missing-after-completion", "directory-missing-after-completion"].includes(scenario))
					await assert.rejects(lstat(selected), { code: "ENOENT" });
				if (scenario === "changed-after-completion") assert.equal(await readFile(selected, "utf8"), "changed");
			} else await assert.rejects(lstat(completion), { code: "ENOENT" });
			if (
				!scenario.startsWith("origin-") &&
				!scenario.startsWith("history-") &&
				(!scenario.startsWith("later-") || successful) &&
				!["workbench-symlink", "directory-replaced"].includes(scenario)
			)
				assert.deepEqual(await snapshot(preserved), before);
			for (const path of [
				"completion.json",
				"result.json",
				"configuration-completion.json",
				"service-start-completion.json",
			])
				await assert.rejects(lstat(`${root}/${path}`), { code: "ENOENT" });
			if (successful) {
				await writeFile("/etc/qorpera-office/fixture.json", encode(f.configuration), { mode: 0o444 });
				const boundary = () =>
					spawnSync(
						"setpriv",
						[
							"--reuid=1000",
							"--regid=1000",
							"--clear-groups",
							"--bounding-set=-all",
							process.execPath,
							"/probe.mjs",
							"--boundary",
						],
						{ encoding: "utf8", timeout: 15000 },
					);
				const result = boundary();
				assert.equal(result.status, 0, result.stderr);
				await chmod(`${directory}/adoption.json`, 0o666);
				assert.equal(boundary().status, 1);
				await chmod(`${directory}/adoption.json`, 0o444);
				const substitute = { ...f.receipt, bootObservationSha256: "9".repeat(64) };
				await writeFile(`${directory}/adoption.json`, encode(substitute));
				assert.equal(boundary().status, 1);
				await writeFile(`${directory}/adoption.json`, encode(f.receipt));
			}
		} finally {
			await lock.close();
		}
		console.log(
			JSON.stringify({
				schema: "qorpera.office-boot-configuration-linux-proof/v1",
				scenario,
				actualKernelBootAndFlock: true,
				actualPersistentFilesystem: mount.filesystem,
				actualProtectedFiles: true,
				actualUnprivilegedPhysicalBoundary: [
					"normal",
					"later-normal",
					"later-initial",
					"later-first-successor",
				].includes(scenario),
				laterBootPredecessor: scenario.startsWith("later-"),
				syntheticPriorBootAndSqlAndVm: true,
				syntheticSystemdManager: true,
				mutableWorkbenchPreserved: true,
				ordinaryServiceStarted: false,
				activated: false,
			}),
		);
	}
}
