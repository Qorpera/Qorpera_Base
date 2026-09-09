import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import {
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
} from "@qorpera/contracts";
import { controlCompanyComputerServiceStop } from "../../src/cloud-company-computer-service-stop-control.ts";
import { readCompanyComputerStopHistory } from "../../src/cloud-company-computer-stop-history.ts";

const root = "/run/qorpera-office-preparation",
	id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
	encode = (v: unknown) => Buffer.from(`${JSON.stringify(v)}\n`);
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode }),
	load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const [mode, scenario] = process.argv.slice(2);
if (mode === "--stop" || mode === "--inspect") {
	let inspections = 0;
	const command = await load(`${root}/fixture-stop-command.json`);
	await controlCompanyComputerServiceStop(
		command,
		{
			async inspect() {
				inspections++;
				if (scenario === "archive-crash") {
					const current = await load(`${root}/service-start-completion.json`);
					const path = `/etc/qorpera-office/history/${command.bootId}/${current.activationId}/claim.json`;
					if (
						await lstat(path).then(
							() => true,
							() => false,
						)
					)
						process.kill(process.pid, "SIGKILL");
				}
				if (scenario === "evidence-during-inspect" && inspections === 2)
					await writeFile("/etc/qorpera-office/credentials/config.json", "changed");
				return load(`${root}/fixture-stop-state.json`);
			},
			async stop() {
				if (mode === "--inspect") throw new Error("inspection dispatched stop");
				if (scenario === "crash-before-stop") process.kill(process.pid, "SIGKILL");
				await save(`${root}/fixture-stop-count.json`, (await load(`${root}/fixture-stop-count.json`)) + 1);
				if (scenario === "failed-stop") throw new Error("must-not-leak");
				const before = await load(`${root}/fixture-stop-state.json`);
				await save(`${root}/fixture-stop-state.json`, {
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
		mode === "--inspect" ? (scenario === "same-nonce" ? command.commandId : id(90)) : undefined,
	);
} else {
	assert.equal(mode, "--parent");
	const scenarios = [
		"normal",
		"auto-restart",
		"crash-before-stop",
		"crash-after-stop",
		"lost-reply",
		"failed-stop",
		"descendant",
		"cancelled",
		"no-lock",
		"wrong-boot",
		"stage-hash",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"original-completion",
		"wrong-revocation",
		"claim-conflict",
		"completion-without-claim",
		"evidence-during-inspect",
		"history-mode",
		"history-symlink",
		"archive-crash",
		"archive-recover-completion",
		"archive-missing-stop-records",
		"archive-survives-run-clear",
		"archive-missing-blob",
		"archive-missing-seal",
		"archive-changed-seal",
	];
	for (const scenario of scenarios) {
		const seed = spawnSync(process.execPath, ["/probe.mjs", "--seed"], { encoding: "utf8", timeout: 20000 });
		assert.equal(seed.status, 0, seed.stderr);
		const config = await load("/etc/qorpera-office/credentials/config.json"),
			priorBytes = await readFile(`${root}/service-start-completion.json`),
			prior = JSON.parse(priorBytes.toString());
		const startup = {
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			allocationId: config.linux.attestation.allocationId,
			instanceSha256: config.linux.attestation.instanceSha256,
			imageSha256: config.linux.attestation.imageSha256,
			bootstrapSha256: config.linux.attestation.bootstrapSha256,
			bootId: config.linux.attestation.bootId,
			configurationSha256: prior.configurationSha256,
			serviceInvocationId: prior.serviceInvocationId,
		};
		const request = {
			schema: "qorpera.office-service-stop-request/v1",
			startCompletionSha256: hash(priorBytes),
			revocation: {
				schema: "qorpera.office-lifecycle-transition/v1",
				state: "draining",
				revocationRevision: 2,
				requestedAtMs: Date.now(),
				drains: [],
				request: {
					schema: "qorpera.office-lifecycle-request/v1",
					transitionId: id(70),
					action: "service_restart",
					activationId: prior.activationId,
					providerId: id(71),
					providerPolicySha256: "f".repeat(64),
					startup,
				},
			},
		};
		if (scenario === "wrong-revocation") request.revocation.request.startup.allocationId = id(99);
		const command = {
			commandId: id(72),
			requestSha256: hash(encode(request)),
			bootId: scenario === "wrong-boot" ? id(99) : startup.bootId,
		};
		const stage = `${root}/service-stop-incoming-${command.requestSha256}.json`;
		await save(stage, request, 0o400);
		await save(`${root}/fixture-stop-command.json`, command);
		await save(`${root}/fixture-stop-count.json`, 0);
		const service = await load(`${root}/fixture-office-unit.json`);
		if (scenario === "auto-restart") {
			service.invocationId = "c".repeat(32);
			service.restarts = 1;
		}
		await save(`${root}/fixture-stop-state.json`, { service, cgroupState: "populated" });
		if (scenario === "stage-hash") await writeFile(stage, "{}");
		if (scenario === "stage-mode") await chmod(stage, 0o644);
		if (scenario === "stage-owner") await chown(stage, 1000, 1000);
		if (scenario === "stage-symlink") {
			await unlink(stage);
			await symlink(`${root}/fixture-stop-command.json`, stage);
		}
		if (scenario === "original-completion") await writeFile(`${root}/service-start-completion.json`, "{}");
		if (scenario === "claim-conflict") await save(`${root}/service-stop-claim.json`, {});
		if (scenario === "completion-without-claim") await save(`${root}/service-stop-completion.json`, {});
		if (scenario === "history-mode") await mkdir("/etc/qorpera-office/history", { mode: 0o755 });
		if (scenario === "history-symlink") await symlink(root, "/etc/qorpera-office/history");
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (action = "--stop", selected = scenario) =>
			spawnSync(
				scenario === "no-lock" ? process.execPath : "/usr/bin/flock",
				[
					...(scenario === "no-lock"
						? []
						: ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/stop-probe.mjs",
					action,
					selected,
				],
				{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		try {
			if (scenario === "normal") assert.equal(run("--inspect").status, 1);
			const first = run();
			assert.equal(
				first.status,
				["normal", "auto-restart"].includes(scenario) ||
					(scenario.startsWith("archive-") && scenario !== "archive-crash")
					? 0
					: scenario.startsWith("crash-") || scenario === "archive-crash"
						? null
						: 1,
				`${scenario}: ${first.stderr}`,
			);
			assert(!first.stderr.includes("must-not-leak"));
			if (scenario.startsWith("archive-")) {
				const historyRoot = `/etc/qorpera-office/history/${command.bootId}/${prior.activationId}`;
				const count = await load(`${root}/fixture-stop-count.json`);
				if (scenario === "archive-crash") {
					await assert.rejects(readFile(`${root}/service-stop-completion.json`), { code: "ENOENT" });
					const claim = await lstat(`${historyRoot}/claim.json`);
					assert.equal(run("--stop", "normal").status, 0);
					assert.equal((await lstat(`${historyRoot}/claim.json`)).ino, claim.ino);
				}
				const history = await readCompanyComputerStopHistory(command.bootId, prior.activationId);
				const manifest = await lstat(`${historyRoot}/manifest.json`);
				assert(
					history.files
						.get(`${root}/service-stop-completion.json`)!
						.equals(await readFile(`${root}/service-stop-completion.json`)),
				);
				if (scenario === "archive-recover-completion") {
					await unlink(`${root}/service-stop-completion.json`);
					assert.equal(run("--inspect", "normal").status, 1);
					assert.equal(run("--stop", "normal").status, 0);
					assert.equal((await lstat(`${historyRoot}/manifest.json`)).ino, manifest.ino);
				}
				if (scenario === "archive-missing-stop-records") {
					await unlink(`${root}/service-stop-completion.json`);
					await unlink(`${root}/service-stop-claim.json`);
					assert.equal(run("--stop", "normal").status, 1);
					assert.equal(run("--inspect", "normal").status, 1);
					await assert.rejects(readFile(`${root}/service-stop-claim.json`), { code: "ENOENT" });
					assert.equal((await lstat(`${historyRoot}/manifest.json`)).ino, manifest.ino);
				}
				if (scenario === "archive-survives-run-clear") {
					for (const name of await readdir(root)) await rm(`${root}/${name}`, { recursive: true });
					const retained = await readCompanyComputerStopHistory(command.bootId, prior.activationId);
					assert.deepEqual(retained.manifest, history.manifest);
					assert.equal(retained.manifestSha256, history.manifestSha256);
				} else {
					if (scenario === "archive-missing-blob")
						await unlink(`${historyRoot}/${history.manifest.entries[0].sha256}.json`);
					if (scenario === "archive-missing-seal") await unlink(`${historyRoot}/manifest.json`);
					if (scenario === "archive-changed-seal") await writeFile(`${historyRoot}/manifest.json`, "{}");
					if (["archive-missing-blob", "archive-missing-seal", "archive-changed-seal"].includes(scenario)) {
						await assert.rejects(readCompanyComputerStopHistory(command.bootId, prior.activationId));
						assert.equal(run("--inspect", "normal").status, 1);
						assert.equal(run("--stop", "normal").status, 1);
					}
					assert.equal(await load(`${root}/fixture-stop-count.json`), count);
				}
				console.log(`PASS protected stop ${scenario}`);
				continue;
			}
			const recoverable = ["normal", "auto-restart", "crash-after-stop", "lost-reply"].includes(scenario);
			if (recoverable || ["crash-before-stop", "failed-stop", "descendant"].includes(scenario)) {
				const count = await load(`${root}/fixture-stop-count.json`);
				const replay = run("--stop", "normal");
				assert.equal(replay.status, recoverable ? 0 : 1, `${scenario}: ${replay.stderr}`);
				assert.equal(await load(`${root}/fixture-stop-count.json`), count, "repeated unknown stop");
				// Start and stop share the same kernel lock and retained claim fence.
				const restart = spawnSync(
					"/usr/bin/flock",
					[
						"--exclusive",
						"--nonblock",
						"--no-fork",
						"/proc/self/fd/3",
						process.execPath,
						"/probe.mjs",
						"--start",
						"normal",
					],
					{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
				);
				assert.equal(restart.status, 1, "start crossed stop claim");
				if (recoverable) {
					const completed = await load(`${root}/service-stop-completion.json`);
					parseCompanyComputerServiceStopCompletion(completed, command, request as never);
					assert.equal(completed.fromServiceInvocationId, prior.serviceInvocationId);
					assert.equal(completed.observedInvocationId, service.invocationId);
					assert.equal((await lstat(`${root}/service-stop-completion.json`)).mode & 0o7777, 0o600);
					assert.equal(run("--inspect").status, 0);
					const inspection = await load(`${root}/service-stop-inspection-${id(90)}.json`);
					parseCompanyComputerServiceStopInspection(inspection, id(90), completed, request as never);
					assert.equal(run("--inspect", "same-nonce").status, 1);
					await save(`${root}/fixture-stop-state.json`, { service, cgroupState: "populated" });
					assert.equal(run("--inspect").status, 1, "stale stop accepted live process");
					assert.equal(await load(`${root}/fixture-stop-count.json`), count);
					assert.deepEqual(await load(`${root}/service-stop-inspection-${id(90)}.json`), inspection);
				}
			}
			console.log(`PASS protected stop ${scenario}`);
		} finally {
			await lock.close();
		}
	}
	console.log(
		JSON.stringify({
			checks: scenarios.length,
			actualRootCustody: true,
			actualKernelFlock: true,
			systemd: "synthetic",
			physicalStop: false,
			modelCalls: false,
		}),
	);
}
