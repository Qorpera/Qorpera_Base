import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { controlCompanyComputerServiceStop } from "../../src/cloud-company-computer-service-stop-control.ts";
import { readCompanyComputerStopHistory } from "../../src/cloud-company-computer-stop-history.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { bootServiceStopFixture } from "./company-computer-boot-service-stop.ts";

const root = "/run/qorpera-office-preparation";
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode });
const [mode, scenario] = process.argv.slice(2);
if (mode === "--stop" || mode === "--inspect") {
	let inspections = 0;
	const command = await load(`${root}/fixture-command.json`),
		request = await load(`${root}/service-stop-incoming-${command.requestSha256}.json`),
		directory = `/etc/qorpera-office/boots/${command.bootId.replaceAll("-", "")}`;
	await controlCompanyComputerServiceStop(
		command,
		{
			async inspect() {
				inspections++;
				if (scenario === "changed-during-inspection" && inspections === 2)
					await writeFile(`${directory}/credentials/config.json`, "changed");
				if (scenario === "old-record-appeared" && inspections === 2)
					await save(`${root}/service-start-completion.json`, {});
				if (
					scenario === "archive-crash" &&
					(await lstat(
						`/etc/qorpera-office/history/${command.bootId}/${request.revocation.request.activationId}/claim.json`,
					).then(
						() => true,
						() => false,
					))
				)
					process.kill(process.pid, "SIGKILL");
				return load(`${root}/fixture-state.json`);
			},
			async stop() {
				assert.equal(mode, "--stop");
				if (scenario === "crash-before-stop") process.kill(process.pid, "SIGKILL");
				await save(`${root}/fixture-count.json`, (await load(`${root}/fixture-count.json`)) + 1);
				if (scenario === "failed-stop") throw new Error("must-not-leak");
				const before = await load(`${root}/fixture-state.json`);
				await save(`${root}/fixture-state.json`, {
					service: {
						...before.service,
						activeState: "inactive",
						subState: "dead",
						mainPid: 0,
						controlPid: 0,
						jobId: 0,
						controlGroup: "",
					},
					cgroupState: scenario === "descendant" ? "populated" : "absent",
				});
				if (scenario === "crash-after-stop") process.kill(process.pid, "SIGKILL");
				if (scenario === "lost-reply") throw new Error("must-not-leak");
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(15000),
		mode === "--inspect" ? id(390) : undefined,
	);
} else {
	assert.equal(mode, "--parent");
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const scenarios = [
		"normal",
		"auto-restart",
		"lost-reply",
		"crash-before-stop",
		"crash-after-stop",
		"failed-stop",
		"descendant",
		"cancelled",
		"no-lock",
		"wrong-boot",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"missing-start",
		"missing-receipt",
		"wrong-configuration",
		"changed-during-inspection",
		"old-record-appeared",
		"archive-crash",
		"archive-completion-lost",
		"archive-seal-lost",
	];
	for (const scenario of scenarios) {
		for (const parent of [root, "/etc/qorpera-office"])
			for (const name of await readdir(parent)) await rm(`${parent}/${name}`, { recursive: true, force: true });
		const f = bootServiceStopFixture({ bootId }),
			activationId = f.startCompletion.activationId,
			completionPath = `${root}/service-stop-completion-${activationId}.json`,
			claimPath = `${root}/service-stop-claim-${activationId}.json`,
			historyDirectory = `/etc/qorpera-office/history/${bootId}/${activationId}`;
		// Only public current-boot evidence exists. No credential tokens, original
		// preparation file or mutable workbench are available to this stop helper.
		for (const [path, file] of f.files) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, file.bytes, { mode: file.mode });
		}
		await mkdir(f.historyDirectory, { recursive: true, mode: 0o700 });
		for (const [path, bytes] of f.archiveFiles) await writeFile(path, bytes, { mode: 0o600 });
		const priorArchive = await Promise.all(
			[...f.archiveFiles].map(async ([path]) => ({
				path,
				ino: (await lstat(path)).ino,
				sha256: hash(await readFile(path)),
			})),
		);
		const command = { ...f.stopCommand, bootId: scenario === "wrong-boot" ? id(399) : bootId },
			stage = `${root}/service-stop-incoming-${command.requestSha256}.json`;
		await save(stage, f.stopRequest, 0o400);
		await save(`${root}/fixture-command.json`, command);
		await save(`${root}/fixture-count.json`, 0);
		await save(`${root}/fixture-state.json`, {
			service: {
				invocationId: scenario === "auto-restart" ? "c".repeat(32) : f.startCompletion.serviceInvocationId,
				activeState: "active",
				subState: "running",
				result: "success",
				mainPid: 42,
				controlPid: 0,
				jobId: 0,
				execMainCode: 0,
				execMainStatus: 0,
				controlGroup: "/system.slice/qorpera-company-computer.service",
				restarts: scenario === "auto-restart" ? 1 : 0,
			},
			cgroupState: "populated",
		});
		if (scenario === "stage-mode") await chmod(stage, 0o644);
		if (scenario === "stage-owner") await chown(stage, 1000, 1000);
		if (scenario === "stage-symlink") {
			await unlink(stage);
			await symlink(`${root}/fixture-command.json`, stage);
		}
		if (scenario === "missing-start") await unlink(`${root}/boot-service-start-completion.json`);
		if (scenario === "missing-receipt") await unlink(`${f.directory}/adoption.json`);
		if (scenario === "wrong-configuration") await writeFile(`${f.directory}/credentials/config.json`, "{}");
		await writeFile(`${root}/control.lock`, "", { mode: 0o600 });
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (action = "--stop", selected = scenario) =>
			spawnSync(
				scenario === "no-lock" ? process.execPath : "/usr/bin/flock",
				[
					...(scenario === "no-lock"
						? []
						: ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/boot-stop-probe.mjs",
					action,
					selected,
				],
				{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		try {
			assert.equal(run("--inspect").status, 1);
			const first = run();
			const completes = ["normal", "auto-restart", "archive-completion-lost", "archive-seal-lost"].includes(
					scenario,
				),
				crashes = ["crash-before-stop", "crash-after-stop", "archive-crash"].includes(scenario);
			assert.equal(first.status, completes ? 0 : crashes ? null : 1, `${scenario}: ${first.stderr}`);
			assert(!first.stderr.includes("must-not-leak"));
			if (completes || ["lost-reply", "crash-after-stop", "archive-crash"].includes(scenario)) {
				const claimInode = (await lstat(claimPath)).ino;
				assert.equal(run("--stop", "normal").status, 0, scenario);
				assert.equal((await lstat(claimPath)).ino, claimInode);
				assert.equal(await load(`${root}/fixture-count.json`), 1);
				const archive = await readCompanyComputerStopHistory(bootId, activationId);
				assert.equal(archive.manifest.completionPath, completionPath);
				assert.equal(archive.manifest.entries.length, 10);
				assert(archive.files.get(completionPath)!.equals(await readFile(completionPath)));
				assert(
					archive.manifest.entries.every(
						(entry) =>
							!/credentials\/(?!config\.json)|boot-configuration-incoming|preparation\.json/.test(entry.path),
					),
				);
				if (scenario === "archive-completion-lost") {
					await unlink(completionPath);
					assert.equal(run("--inspect", "normal").status, 1);
					assert.equal(run("--stop", "normal").status, 0);
				}
				if (scenario === "archive-seal-lost") {
					await unlink(`${historyDirectory}/manifest.json`);
					assert.equal(run("--stop", "normal").status, 1);
					assert.equal(run("--inspect", "normal").status, 1);
				} else {
					assert.equal(run("--inspect", "normal").status, 0);
					const inspection = await load(`${root}/service-stop-inspection-${id(390)}.json`);
					assert.deepEqual(inspection.stop, await load(completionPath));
				}
				assert.equal(await load(`${root}/fixture-count.json`), 1);
			} else {
				const count = await load(`${root}/fixture-count.json`);
				if (scenario !== "cancelled") assert.equal(run("--stop", "normal").status, 1, scenario);
				assert.equal(await load(`${root}/fixture-count.json`), count);
				await assert.rejects(readFile(completionPath), { code: "ENOENT" });
			}
			assert.deepEqual(
				await Promise.all(
					[...f.archiveFiles].map(async ([path]) => ({
						path,
						ino: (await lstat(path)).ino,
						sha256: hash(await readFile(path)),
					})),
				),
				priorArchive,
			);
			console.log(
				JSON.stringify({
					scenario,
					stoppedBoot: bootId,
					priorArchivePreserved: true,
					actualRootCustodyAndFlock: true,
					syntheticSystemdAndSql: true,
				}),
			);
		} finally {
			await lock.close();
		}
	}
}
