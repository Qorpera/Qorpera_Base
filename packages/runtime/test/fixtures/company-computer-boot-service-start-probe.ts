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
import { controlCompanyComputerBootServiceStart } from "../../src/cloud-company-computer-boot-service-start-control.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { bootServiceStartFixture } from "./company-computer-boot-service-start.ts";

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
	},
	ordinary = { ...inactive, controlGroup: "", restarts: 0 },
	idle = { preparation: inactive, service: ordinary, cgroupState: "absent" as const },
	running = {
		preparation: inactive,
		service: {
			...ordinary,
			activeState: "active",
			subState: "running",
			invocationId: "b".repeat(32),
			mainPid: 42,
			controlGroup: "/system.slice/qorpera-company-computer.service",
		},
		cgroupState: "populated" as const,
	};
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode });
const [mode, scenario] = process.argv.slice(2);
if (mode === "--configure") {
	await controlCompanyComputerBootConfiguration(
		await load(`${root}/fixture-configuration-command.json`),
		{ inspect: async () => idle },
		AbortSignal.timeout(10000),
	);
} else if (mode === "--start" || mode === "--inspect") {
	let reads = 0;
	const command = await load(`${root}/fixture-start-command.json`);
	await controlCompanyComputerBootServiceStart(
		command,
		{
			async inspect() {
				reads++;
				if (scenario === "directory-replaced" && reads === 1) {
					const path = `${mountPoint}/.qorpera-adopted-${id(6)}/workbench`;
					await rename(path, `${path}-old`);
					await mkdir(path, { mode: 0o700 });
					await chown(path, 1000, 1000);
				}
				if (scenario === "preparation-started")
					return { ...idle, preparation: { ...inactive, invocationId: "a".repeat(32) } };
				if (scenario === "descendant") return { ...idle, cgroupState: "populated" };
				if (scenario === "claim-changed" && reads === 1) await save(`${root}/boot-service-start-claim.json`, {});
				return load(`${root}/fixture-unit.json`);
			},
			async start() {
				const count = await load(`${root}/fixture-starts.json`);
				await save(`${root}/fixture-starts.json`, count + 1);
				assert.equal(count, 0, "duplicate start");
				if (scenario === "unknown") throw new Error("unknown before physical start");
				if (scenario === "crash") process.kill(process.pid, "SIGKILL");
				await save(`${root}/fixture-unit.json`, running);
				if (scenario === "lost-reply") throw new Error("lost reply after physical start");
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
		mode === "--inspect" ? id(202) : undefined,
	);
} else if (mode === "--parent") {
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
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
		tlsCert = await readFile("/fixture-cert", "utf8"),
		tlsKey = await readFile("/fixture-key", "utf8");
	const scenarios = [
		"normal",
		"lost-reply",
		"unknown",
		"crash",
		"no-lock",
		"cancelled",
		"wrong-boot",
		"stage-hash",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"stage-hardlink",
		"stage-fifo",
		"configuration-missing",
		"configuration-claim-missing",
		"receipt-changed",
		"origin-changed",
		"history-missing",
		"credential-missing",
		"credential-changed",
		"credential-mode",
		"credential-owner",
		"credential-symlink",
		"credential-hardlink",
		"credential-fifo",
		"workbench-mode",
		"directory-replaced",
		"preparation-started",
		"descendant",
		"already-running",
		"claim-changed",
		"old-start-claim",
		"old-stop-claim",
		"active-stop-claim",
		"successor-claim",
		"inspection-before-start",
		"changed-invocation-after-completion",
		"restart-after-completion",
		"claim-missing-after-completion",
		"credential-missing-after-completion",
		"stop-after-completion",
		"completion-changed-after-completion",
	];
	for (const scenario of scenarios) {
		for (const parent of [root, "/etc/qorpera-office", mountPoint])
			for (const name of await readdir(parent)) await rm(`${parent}/${name}`, { recursive: true, force: true });
		await mkdir("/etc/qorpera-office/credentials", { mode: 0o700 });
		await writeFile(`${root}/control.lock`, "", { mode: 0o600 });
		const f = bootServiceStartFixture({ bootId, mount: { ...mount, mountPoint }, tlsCert, tlsKey });
		for (const [path, file] of f.originFiles) await writeFile(path, file.bytes, { mode: file.mode });
		await mkdir(f.historyDirectory, { recursive: true, mode: 0o700 });
		for (const [path, bytes] of f.archiveFiles) await writeFile(path, bytes, { mode: 0o600 });
		for (const path of [dirname(f.receipt.layout.workbenchRoot), ...Object.values(f.receipt.layout)]) {
			await mkdir(path, { mode: 0o700 });
			await chown(path, 1000, 1000);
		}
		const note = `${f.receipt.layout.workbenchRoot}/note`;
		await writeFile(note, "edited after original preparation", { mode: 0o600 });
		await chown(note, 1000, 1000);
		await save(`${root}/boot-configuration-incoming-${f.command.requestSha256}.json`, f.input, 0o400);
		await save(`${root}/fixture-configuration-command.json`, f.command);
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (mode: string, selectedScenario = "normal", locked = true) =>
			spawnSync(
				locked ? "/usr/bin/flock" : process.execPath,
				[
					...(locked ? ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath] : []),
					"/probe.mjs",
					mode,
					selectedScenario,
				],
				{ encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		try {
			const configured = run("--configure");
			assert.equal(configured.status, 0, configured.stderr);
			await unlink(`${root}/boot-configuration-incoming-${f.command.requestSha256}.json`);
			const directory = companyComputerBootDirectory(bootId),
				credential = `${directory}/credentials/native`,
				claim = `${root}/boot-service-start-claim.json`,
				completion = `${root}/boot-service-start-completion.json`;
			const originals = [...f.originFiles.keys(), ...f.archiveFiles.keys(), note],
				snapshot = async () =>
					Promise.all(
						originals.map(async (path) => {
							const s = await lstat(path);
							return {
								path,
								ino: s.ino,
								mode: s.mode,
								uid: s.uid,
								gid: s.gid,
								sha256: hash(await readFile(path)),
							};
						}),
					),
				before = await snapshot();
			const command = { ...f.startCommand, ...(scenario === "wrong-boot" ? { bootId: id(299) } : {}) },
				staging = `${root}/boot-service-start-incoming-${command.requestSha256}.json`;
			await save(staging, f.request, 0o400);
			await save(`${root}/fixture-start-command.json`, command);
			await save(`${root}/fixture-unit.json`, scenario === "already-running" ? running : idle);
			await save(`${root}/fixture-starts.json`, 0);
			if (scenario === "stage-hash") await writeFile(staging, "{}");
			if (scenario === "stage-mode") await chmod(staging, 0o644);
			if (scenario === "stage-owner") await chown(staging, 1000, 1000);
			if (scenario === "stage-symlink") {
				await unlink(staging);
				await symlink(`${root}/fixture-start-command.json`, staging);
			}
			if (scenario === "stage-hardlink") await link(staging, `${root}/stage-link`);
			if (scenario === "stage-fifo") {
				await unlink(staging);
				assert.equal(spawnSync("mkfifo", [staging]).status, 0);
			}
			if (scenario === "configuration-missing") await unlink(`${directory}/configuration-completion.json`);
			if (scenario === "configuration-claim-missing") await unlink(`${directory}/configuration-claim.json`);
			if (scenario === "receipt-changed") await writeFile(`${directory}/adoption.json`, "{}");
			if (scenario === "origin-changed") await writeFile("/etc/qorpera-office/preparation.json", "{}");
			if (scenario === "history-missing") await unlink(`${f.historyDirectory}/manifest.json`);
			if (scenario === "credential-missing") await unlink(credential);
			if (scenario === "credential-changed") await writeFile(credential, "must-not-leak");
			if (scenario === "credential-mode") await chmod(credential, 0o444);
			if (scenario === "credential-owner") await chown(credential, 1000, 1000);
			if (scenario === "credential-symlink") {
				await unlink(credential);
				await symlink(`${directory}/credentials/registry`, credential);
			}
			if (scenario === "credential-hardlink") await link(credential, `${directory}/other`);
			if (scenario === "credential-fifo") {
				await unlink(credential);
				assert.equal(spawnSync("mkfifo", [credential]).status, 0);
			}
			if (scenario === "workbench-mode") await chmod(f.receipt.layout.workbenchRoot, 0o755);
			if (scenario === "old-start-claim") await save(`${root}/service-start-claim.json`, {});
			if (scenario === "old-stop-claim") await save(`${root}/service-stop-claim.json`, {});
			if (scenario === "active-stop-claim")
				await save(`${root}/service-stop-claim-${f.startCompletion.activationId}.json`, {});
			if (scenario === "successor-claim")
				await save(`${root}/service-successor-${f.startCompletion.activationId}.json`, {});
			const acknowledged = scenario.endsWith("after-completion"),
				first = run(
					scenario === "inspection-before-start" ? "--inspect" : "--start",
					scenario,
					scenario !== "no-lock",
				);
			assert.equal(
				first.status,
				scenario === "normal" || acknowledged ? 0 : scenario === "crash" ? null : 1,
				`${scenario}: ${first.stderr}`,
			);
			assert(!first.stderr.includes("must-not-leak"));
			if (scenario === "crash") assert.equal(first.signal, "SIGKILL");
			if (scenario === "normal" || scenario === "lost-reply") {
				const replay = run("--start");
				assert.equal(replay.status, 0, replay.stderr);
				assert.deepEqual(await load(completion), f.startCompletion);
				const beforeInspection = await readFile(completion),
					inspected = run("--inspect");
				assert.equal(inspected.status, 0, inspected.stderr);
				assert.deepEqual(await readFile(completion), beforeInspection);
				assert.deepEqual((await load(`${root}/boot-service-inspection-${id(202)}.json`)).start, f.startCompletion);
			}
			if (["unknown", "crash"].includes(scenario)) {
				const replay = run("--start");
				assert.equal(replay.status, 1, replay.stderr);
				await assert.rejects(lstat(completion), { code: "ENOENT" });
			}
			if (acknowledged) {
				if (scenario === "changed-invocation-after-completion")
					await save(`${root}/fixture-unit.json`, {
						...running,
						service: { ...running.service, invocationId: "c".repeat(32) },
					});
				if (scenario === "restart-after-completion")
					await save(`${root}/fixture-unit.json`, { ...running, service: { ...running.service, restarts: 1 } });
				if (scenario === "claim-missing-after-completion") await unlink(claim);
				if (scenario === "credential-missing-after-completion") await unlink(credential);
				if (scenario === "stop-after-completion") await save(`${root}/service-stop-claim.json`, {});
				if (scenario === "completion-changed-after-completion") await save(completion, {});
				const replay = run("--start"),
					inspected = run("--inspect");
				assert.equal(replay.status, 1, replay.stderr);
				assert.equal(inspected.status, 1, inspected.stderr);
			}
			assert.equal(
				await load(`${root}/fixture-starts.json`),
				["normal", "lost-reply", "unknown", "crash"].includes(scenario) || acknowledged ? 1 : 0,
				scenario,
			);
			if (!["origin-changed", "history-missing", "directory-replaced"].includes(scenario))
				assert.deepEqual(await snapshot(), before);
			for (const path of [
				"result.json",
				"completion.json",
				"configuration-completion.json",
				"service-start-completion.json",
			])
				await assert.rejects(lstat(`${root}/${path}`), { code: "ENOENT" });
			console.log(
				JSON.stringify({
					scenario,
					actualRootControl: true,
					actualKernelFlock: true,
					filesystem: mount.filesystem,
					originalFilesPreserved: !["origin-changed", "history-missing", "directory-replaced"].includes(scenario),
					syntheticSystemdAndSql: true,
					starts: await load(`${root}/fixture-starts.json`),
					deployed: false,
				}),
			);
		} finally {
			await lock.close();
		}
	}
} else throw new Error("probe mode");
