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
import { controlCompanyComputerBootConfiguration } from "../../src/cloud-company-computer-boot-configuration-control.ts";
import { controlCompanyComputerBootServiceRestart } from "../../src/cloud-company-computer-boot-service-restart-control.ts";
import { controlCompanyComputerServiceStop } from "../../src/cloud-company-computer-service-stop-control.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { appendBootServiceRestartFixture, bootServiceRestartFixture } from "./company-computer-boot-service-restart.ts";

const root = "/run/qorpera-office-preparation",
	mountPoint = "/var/lib/qorpera-office";
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode });
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
const idle = { preparation: inactive, service: { ...inactive, controlGroup: "", restarts: 0 }, cgroupState: "absent" };
const running = (invocationId: string, mainPid: number) => ({
	preparation: inactive,
	service: {
		...idle.service,
		invocationId,
		mainPid,
		activeState: "active",
		subState: "running",
		controlGroup: "/system.slice/qorpera-company-computer.service",
	},
	cgroupState: "populated",
});
const [mode, scenario = "normal"] = process.argv.slice(2);
if (mode === "--configure") {
	await controlCompanyComputerBootConfiguration(
		await load(`${root}/fixture-configuration.json`),
		{ inspect: async () => ({ ...idle, cgroupState: "absent" }) },
		AbortSignal.timeout(10000),
	);
} else if (mode === "--stop" || mode === "--stop-inspect") {
	await controlCompanyComputerServiceStop(
		await load(`${root}/fixture-stop-command.json`),
		{
			inspect: () => load(`${root}/fixture-unit.json`),
			async stop() {
				const before = await load(`${root}/fixture-unit.json`);
				await save(`${root}/fixture-unit.json`, {
					...idle,
					service: { ...idle.service, invocationId: before.service.invocationId },
				});
			},
		},
		AbortSignal.timeout(10000),
		mode === "--stop-inspect" ? await load(`${root}/fixture-stop-nonce.json`) : undefined,
	);
} else if (mode === "--restart" || mode === "--inspect") {
	const command = await load(`${root}/fixture-command.json`),
		target = await load(`${root}/fixture-target.json`);
	let reads = 0;
	await controlCompanyComputerBootServiceRestart(
		command,
		{
			async inspect() {
				reads++;
				if (scenario === "changed-during-inspection" && reads === 1)
					await save(`${root}/boot-service-start-claim.json`, {});
				if (scenario === "old-record-appeared" && reads === 1)
					await save(`${root}/service-start-completion.json`, {});
				if (scenario === "directory-replaced" && reads === 1) {
					const path = await load(`${root}/fixture-workbench.json`);
					await rename(path, `${path}-old`);
					await mkdir(path, { mode: 0o700 });
					await chown(path, 1000, 1000);
				}
				return load(`${root}/fixture-unit.json`);
			},
			async start() {
				const count = await load(`${root}/fixture-starts.json`);
				await save(`${root}/fixture-starts.json`, count + 1);
				if (scenario === "unknown") throw new Error("must-not-leak");
				if (scenario === "crash") process.kill(process.pid, "SIGKILL");
				await save(`${root}/fixture-unit.json`, running(target.serviceInvocationId, target.mainPid));
				if (scenario === "lost-reply") throw new Error("must-not-leak");
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
		mode === "--inspect" ? await load(`${root}/fixture-restart-nonce.json`) : undefined,
	);
} else {
	assert.equal(mode, "--parent");
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
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"stage-hardlink",
		"stage-fifo",
		"missing-credential",
		"changed-credential",
		"missing-stop",
		"missing-inspection",
		"missing-archive",
		"missing-origin",
		"preparation-started",
		"descendant",
		"already-running",
		"changed-during-inspection",
		"old-record-appeared",
		"directory-replaced",
		"child-already-claimed",
		"changed-invocation-after-completion",
		"restarted-after-completion",
		"missing-claim-after-completion",
		"credential-missing-after-completion",
	];
	for (const scenario of scenarios) {
		for (const parent of [root, "/etc/qorpera-office", mountPoint])
			for (const name of await readdir(parent)) await rm(`${parent}/${name}`, { recursive: true, force: true });
		await mkdir("/etc/qorpera-office/credentials", { mode: 0o700 });
		const f = bootServiceRestartFixture({ bootId, mount: { ...mount, mountPoint }, tlsCert, tlsKey }),
			r = f.restart;
		for (const [path, file] of f.originFiles) await writeFile(path, file.bytes, { mode: file.mode });
		await mkdir(f.historyDirectory, { recursive: true, mode: 0o700 });
		for (const [path, bytes] of f.archiveFiles) await writeFile(path, bytes, { mode: 0o600 });
		for (const path of [dirname(f.receipt.layout.workbenchRoot), ...Object.values(f.receipt.layout)]) {
			await mkdir(path, { mode: 0o700 });
			await chown(path, 1000, 1000);
		}
		const note = `${f.receipt.layout.workbenchRoot}/note`;
		await writeFile(note, "edited after adoption", { mode: 0o600 });
		await chown(note, 1000, 1000);
		await save(`${root}/boot-configuration-incoming-${f.command.requestSha256}.json`, f.input, 0o400);
		await save(`${root}/fixture-configuration.json`, f.command);
		await writeFile(`${root}/control.lock`, "", { mode: 0o600 });
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (mode: string, selected = "normal", locked = true) =>
			spawnSync(
				locked ? "/usr/bin/flock" : process.execPath,
				[
					...(locked ? ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath] : []),
					"/probe.mjs",
					mode,
					selected,
				],
				{ encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		const ok = (mode: string) => {
			const result = run(mode);
			assert.equal(result.status, 0, result.stderr);
		};
		try {
			ok("--configure");
			await unlink(`${root}/boot-configuration-incoming-${f.command.requestSha256}.json`);
			for (const [path, file] of f.files)
				if (!path.includes("/service-stop-") && ![r.claimPath, r.completionPath].includes(path))
					await writeFile(path, file.bytes, { mode: file.mode });
			const stop = async (selected: typeof r) => {
				await save(
					`${root}/service-stop-incoming-${selected.stopCommand.requestSha256}.json`,
					selected.stop,
					0o400,
				);
				await save(`${root}/fixture-stop-command.json`, selected.stopCommand);
				await save(`${root}/fixture-stop-nonce.json`, selected.inspection.inspectionId);
				ok("--stop");
				ok("--stop-inspect");
				assert.deepEqual(await load(selected.stopCompletionPath), selected.stopped);
			};
			await save(
				`${root}/fixture-unit.json`,
				running(f.startCompletion.serviceInvocationId, f.startCompletion.mainPid),
			);
			await stop(r);
			await save(`${root}/fixture-command.json`, {
				...r.command,
				bootId: scenario === "wrong-boot" ? id(999) : bootId,
			});
			await save(`${root}/fixture-target.json`, r.completion);
			await save(`${root}/fixture-restart-nonce.json`, id(415));
			await save(`${root}/fixture-starts.json`, 0);
			await save(`${root}/fixture-workbench.json`, f.receipt.layout.workbenchRoot);
			const preserved = [
				...f.originFiles.keys(),
				...f.archiveFiles.keys(),
				`${root}/boot-service-start-completion.json`,
				`${f.directory}/adoption.json`,
				`${f.directory}/configuration-completion.json`,
				note,
			];
			const snapshot = () =>
				Promise.all(
					preserved.map(async (path) => ({
						path,
						ino: (await lstat(path)).ino,
						sha256: hash(await readFile(path)),
					})),
				);
			const before = await snapshot(),
				credential = `${f.directory}/credentials/native`;
			if (scenario === "stage-mode") await chmod(r.stagePath, 0o644);
			if (scenario === "stage-owner") await chown(r.stagePath, 1000, 1000);
			if (scenario === "stage-symlink") {
				await unlink(r.stagePath);
				await symlink(`${root}/fixture-command.json`, r.stagePath);
			}
			if (scenario === "stage-hardlink") await link(r.stagePath, `${root}/linked.json`);
			if (scenario === "stage-fifo") {
				await unlink(r.stagePath);
				assert.equal(spawnSync("mkfifo", [r.stagePath]).status, 0);
			}
			if (scenario === "missing-credential") await unlink(credential);
			if (scenario === "changed-credential") await writeFile(credential, "changed");
			if (scenario === "missing-stop") await unlink(r.stopCompletionPath);
			if (scenario === "missing-inspection")
				await unlink(`${root}/service-stop-inspection-${r.inspection.inspectionId}.json`);
			if (scenario === "missing-archive")
				await unlink(`/etc/qorpera-office/history/${bootId}/${f.startCompletion.activationId}/manifest.json`);
			if (scenario === "missing-origin") await unlink(`${root}/boot-service-start-completion.json`);
			if (scenario === "preparation-started")
				await save(`${root}/fixture-unit.json`, {
					...idle,
					preparation: { ...inactive, invocationId: "e".repeat(32) },
				});
			if (scenario === "descendant") await save(`${root}/fixture-unit.json`, { ...idle, cgroupState: "populated" });
			if (scenario === "already-running") await save(`${root}/fixture-unit.json`, running("e".repeat(32), 999));
			if (scenario === "child-already-claimed") await save(r.claimPath, {});
			assert.equal(run("--inspect").status, 1);
			const completedFault = scenario.endsWith("after-completion"),
				first = run("--restart", scenario, scenario !== "no-lock");
			assert.equal(
				first.status,
				scenario === "normal" || completedFault ? 0 : scenario === "crash" ? null : 1,
				`${scenario}: ${first.stderr}`,
			);
			assert(!first.stderr.includes("must-not-leak"));
			if (["normal", "lost-reply"].includes(scenario)) {
				ok("--restart");
				ok("--inspect");
				assert.deepEqual(await load(r.completionPath), r.completion);
			}
			if (["unknown", "crash"].includes(scenario)) {
				assert.equal(run("--restart").status, 1);
				await assert.rejects(lstat(r.completionPath), { code: "ENOENT" });
			}
			if (completedFault) {
				if (scenario === "changed-invocation-after-completion")
					await save(`${root}/fixture-unit.json`, running("e".repeat(32), 99));
				if (scenario === "restarted-after-completion")
					await save(`${root}/fixture-unit.json`, {
						...running(r.completion.serviceInvocationId, r.completion.mainPid),
						service: { ...running(r.completion.serviceInvocationId, r.completion.mainPid).service, restarts: 1 },
					});
				if (scenario === "missing-claim-after-completion") await unlink(r.claimPath);
				if (scenario === "credential-missing-after-completion") await unlink(credential);
				assert.equal(run("--restart").status, 1);
				assert.equal(run("--inspect").status, 1);
			}
			assert.equal(
				await load(`${root}/fixture-starts.json`),
				["normal", "lost-reply", "unknown", "crash"].includes(scenario) || completedFault ? 1 : 0,
				scenario,
			);
			if (scenario === "normal") {
				const second = appendBootServiceRestartFixture(f, r.completion, 2);
				await stop(second);
				assert.equal(run("--restart").status, 1, "stopped predecessor cannot restart");
				await save(second.stagePath, second.request, 0o400);
				await save(`${root}/fixture-command.json`, second.command);
				await save(`${root}/fixture-target.json`, second.completion);
				await save(`${root}/fixture-restart-nonce.json`, id(425));
				ok("--restart");
				ok("--restart");
				ok("--inspect");
				assert.deepEqual(await load(second.completionPath), second.completion);
				assert.equal(await load(`${root}/fixture-starts.json`), 2);
			}
			if (!["missing-origin", "directory-replaced"].includes(scenario)) assert.deepEqual(await snapshot(), before);
			console.log(
				JSON.stringify({
					scenario,
					actualRootControl: true,
					actualKernelFlock: true,
					actualStopAndArchive: true,
					starts: await load(`${root}/fixture-starts.json`),
					syntheticSystemdSqlAndPriorBoot: true,
					deployed: false,
				}),
			);
		} finally {
			await lock.close();
		}
	}
}
