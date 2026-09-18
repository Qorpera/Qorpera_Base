import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, open, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import {
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import { controlCompanyComputerServiceRestart } from "../../src/cloud-company-computer-service-restart-control.ts";
import { controlCompanyComputerServiceStop } from "../../src/cloud-company-computer-service-stop-control.ts";

const root = "/run/qorpera-office-preparation",
	id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`),
	hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const save = (path: string, value: unknown, mode = 0o600) => writeFile(path, encode(value), { mode }),
	load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const [mode, scenario] = process.argv.slice(2);
const unitPath = `${root}/fixture-office-unit.json`,
	commandPath = `${root}/fixture-restart-command.json`;
if (mode !== "--parent") {
	const stop = new AbortController();
	if (scenario === "cancelled") stop.abort();
	if (mode === "--stop" || mode === "--stop-inspect") {
		await controlCompanyComputerServiceStop(
			await load(`${root}/fixture-stop-command.json`),
			{
				inspect: async () => ({
					service: await load(unitPath),
					cgroupState: (await load(unitPath)).mainPid ? "populated" : "absent",
				}),
				async stop() {
					if (mode === "--stop-inspect") throw new Error("inspection stopped service");
					await save(`${root}/fixture-stop-count.json`, (await load(`${root}/fixture-stop-count.json`)) + 1);
					await save(unitPath, {
						...(await load(unitPath)),
						activeState: "inactive",
						subState: "dead",
						mainPid: 0,
						controlPid: 0,
						jobId: 0,
						controlGroup: "",
					});
				},
			},
			AbortSignal.timeout(15000),
			mode === "--stop-inspect" ? await load(`${root}/fixture-stop-nonce.json`) : undefined,
		);
	} else {
		assert(["--restart", "--inspect"].includes(mode));
		let reads = 0;
		const command = await load(commandPath);
		await controlCompanyComputerServiceRestart(
			command,
			{
				async inspect() {
					if (++reads === 5 && scenario === "invocation-during-confirmation")
						await save(unitPath, { ...(await load(unitPath)), invocationId: "f".repeat(32) });
					return { preparation: await load(`${root}/fixture-unit.json`), service: await load(unitPath) };
				},
				inspectStopped: async () => ({
					service: await load(unitPath),
					cgroupState: scenario === "descendant" ? "populated" : "absent",
				}),
				async start() {
					if (mode === "--inspect") throw new Error("inspection restarted service");
					if (scenario === "crash-before-start") process.kill(process.pid, "SIGKILL");
					await save(`${root}/fixture-restart-count.json`, (await load(`${root}/fixture-restart-count.json`)) + 1);
					if (scenario === "failed-start") throw new Error("must-not-leak");
					const previous = await load(unitPath);
					await save(unitPath, {
						...previous,
						activeState: "active",
						subState: "running",
						mainPid: 43,
						controlPid: 0,
						jobId: 0,
						invocationId: await load(`${root}/fixture-next-invocation.json`),
						controlGroup: "/system.slice/qorpera-company-computer.service",
						restarts: 0,
					});
					if (scenario === "configuration-during-start")
						await writeFile("/etc/qorpera-office/credentials/config.json", "changed");
					if (scenario === "history-during-start") {
						const original = await load(`${root}/service-start-completion.json`);
						await writeFile(
							`/etc/qorpera-office/history/${command.bootId}/${original.activationId}/manifest.json`,
							"{}",
						);
					}
					if (scenario === "crash-after-start") process.kill(process.pid, "SIGKILL");
					if (scenario === "lost-reply") throw new Error("must-not-leak");
					if (scenario === "cancel-during-start") stop.abort();
				},
			},
			AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
			mode === "--inspect" ? (scenario === "same-nonce" ? command.commandId : id(500)) : undefined,
		);
	}
} else {
	const scenarios = [
		"normal",
		"crash-before-start",
		"crash-after-start",
		"lost-reply",
		"failed-start",
		"cancel-during-start",
		"cancelled",
		"no-lock",
		"wrong-boot",
		"stage-hash",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"stop-completion-missing",
		"stop-claim-missing",
		"stop-inspection-missing",
		"history-seal-missing",
		"history-blob-missing",
		"history-seal-changed",
		"history-during-start",
		"different-stop-hash",
		"different-successor",
		"unprepared-successor",
		"wrong-acknowledgement",
		"changed-config",
		"running-unclaimed",
		"descendant",
		"conflicting-claim",
		"completion-without-claim",
		"configuration-during-start",
		"invocation-during-confirmation",
		"prior-invocation",
		"new-stop-claim",
		"new-child-claim",
	];
	for (const scenario of scenarios) {
		const seed = spawnSync(process.execPath, ["/probe.mjs", "--seed"], { encoding: "utf8", timeout: 20000 });
		assert.equal(seed.status, 0, seed.stderr);
		const originalBytes = await readFile(`${root}/service-start-completion.json`),
			original = JSON.parse(originalBytes.toString());
		const originalRequest = await load(`${root}/service-start-incoming-${original.command.requestSha256}.json`),
			config = await load("/etc/qorpera-office/credentials/config.json");
		await save(`${root}/fixture-stop-count.json`, 0);
		await save(`${root}/fixture-restart-count.json`, 0);
		const lock = await open(`${root}/control.lock`, "r+");
		const run = (action: string, selected = "normal", unlocked = false) =>
			spawnSync(
				unlocked ? process.execPath : "/usr/bin/flock",
				[
					...(unlocked ? [] : ["--exclusive", "--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath]),
					"/restart-probe.mjs",
					action,
					selected,
				],
				{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
			);
		const stopInvocation = async (startBytes: Buffer, cycle: number) => {
			const start = JSON.parse(startBytes.toString());
			const request = {
				schema: "qorpera.office-service-stop-request/v1",
				startCompletionSha256: hash(startBytes),
				revocation: {
					schema: "qorpera.office-lifecycle-transition/v1",
					state: "draining",
					requestedAtMs: Date.now(),
					revocationRevision: cycle + 2,
					drains: [],
					request: {
						schema: "qorpera.office-lifecycle-request/v1",
						action: "service_restart",
						transitionId: id(70 + cycle),
						activationId: start.activationId,
						providerId: id(71),
						providerPolicySha256: "f".repeat(64),
						startup: {
							scope: config.scope,
							computerGeneration: config.computerGeneration,
							allocationId: config.linux.attestation.allocationId,
							instanceSha256: config.linux.attestation.instanceSha256,
							imageSha256: config.linux.attestation.imageSha256,
							bootstrapSha256: config.linux.attestation.bootstrapSha256,
							bootId: config.linux.attestation.bootId,
							configurationSha256: start.configurationSha256,
							serviceInvocationId: start.serviceInvocationId,
						},
					},
				},
			};
			const command = {
					commandId: id(80 + cycle),
					requestSha256: hash(encode(request)),
					bootId: config.linux.attestation.bootId,
				},
				nonce = id(90 + cycle);
			await save(`${root}/service-stop-incoming-${command.requestSha256}.json`, request, 0o400);
			await save(`${root}/fixture-stop-command.json`, command);
			await save(`${root}/fixture-stop-nonce.json`, nonce);
			const stopped = run("--stop"),
				inspected = run("--stop-inspect");
			assert.equal(stopped.status, 0, stopped.stderr);
			assert.equal(inspected.status, 0, inspected.stderr);
			const path = `${root}/service-stop-completion${cycle ? `-${start.activationId}` : ""}.json`;
			const completionBytes = await readFile(path),
				inspection = await load(`${root}/service-stop-inspection-${nonce}.json`);
			return {
				request,
				command,
				path,
				completionBytes,
				acknowledgement: {
					schema: "qorpera.office-service-stop-acknowledgement/v1",
					state: "stopped",
					request: request.revocation.request,
					inspection,
					acknowledgedAtMs: Date.now(),
				},
			};
		};
		const prepareRestart = async (previous: Awaited<ReturnType<typeof stopInvocation>>, cycle: number) => {
			const start = {
				...originalRequest,
				attestation: { ...originalRequest.attestation, activationId: id(100 + cycle) },
			};
			const successorRequest = {
				schema: "qorpera.office-service-successor-request/v1",
				predecessor: previous.request.revocation.request,
				attestation: start.attestation,
			};
			const request = {
				schema: "qorpera.office-service-restart-request/v1",
				start,
				stop: previous.request,
				acknowledgement: previous.acknowledgement,
				stopCompletionSha256: hash(previous.completionBytes),
				successor: {
					schema: "qorpera.office-service-successor/v1",
					request: successorRequest,
					state: "prepared",
					serviceInvocationId: null,
					readinessFresh: false,
					stopAcknowledgedAtMs: previous.acknowledgement.acknowledgedAtMs,
					officeRevision: 3 + cycle,
					privacyVersion: 11,
					validForMs: 5000,
				},
			};
			parseCompanyComputerServiceRestartRequest(request);
			return request;
		};
		const stageRestart = async (request: Awaited<ReturnType<typeof prepareRestart>>, cycle: number) => {
			const command = {
				commandId: id(200 + cycle),
				requestSha256: hash(encode(request)),
				bootId: scenario === "wrong-boot" ? id(999) : config.linux.attestation.bootId,
			};
			const path = `${root}/service-restart-incoming-${command.requestSha256}.json`;
			await save(path, request, 0o400);
			await save(commandPath, command);
			await save(`${root}/fixture-next-invocation.json`, cycle ? "d".repeat(32) : "c".repeat(32));
			return { command, path };
		};
		try {
			const previous = await stopInvocation(originalBytes, 0),
				request = await prepareRestart(previous, 0);
			if (scenario === "different-stop-hash") request.stopCompletionSha256 = "0".repeat(64);
			if (scenario === "different-successor")
				request.successor.request.attestation = { ...request.successor.request.attestation, activationId: id(999) };
			if (scenario === "unprepared-successor") request.successor.state = "active";
			if (scenario === "wrong-acknowledgement") request.acknowledgement.acknowledgedAtMs++;
			const staged = await stageRestart(request, 0),
				completionPath = `${root}/service-restart-completion-${id(100)}.json`,
				claimPath = `${root}/service-successor-${original.activationId}.json`;
			if (scenario === "stage-hash") await writeFile(staged.path, "{}");
			if (scenario === "stage-mode") await chmod(staged.path, 0o644);
			if (scenario === "stage-owner") await chown(staged.path, 1000, 1000);
			if (scenario === "stage-symlink") {
				await unlink(staged.path);
				await symlink(commandPath, staged.path);
			}
			if (scenario === "stop-completion-missing") await unlink(previous.path);
			if (scenario === "stop-claim-missing") await unlink(`${root}/service-stop-claim.json`);
			if (scenario === "stop-inspection-missing") await unlink(`${root}/service-stop-inspection-${id(90)}.json`);
			const archivePath = `/etc/qorpera-office/history/${config.linux.attestation.bootId}/${original.activationId}`;
			if (scenario === "history-seal-missing") await unlink(`${archivePath}/manifest.json`);
			if (scenario === "history-seal-changed") await writeFile(`${archivePath}/manifest.json`, "{}");
			if (scenario === "history-blob-missing") {
				const manifest = await load(`${archivePath}/manifest.json`);
				await unlink(`${archivePath}/${manifest.entries[0].sha256}.json`);
			}
			if (scenario === "changed-config") await writeFile("/etc/qorpera-office/credentials/config.json", "changed");
			if (scenario === "running-unclaimed")
				await save(unitPath, {
					...(await load(unitPath)),
					activeState: "active",
					subState: "running",
					mainPid: 42,
				});
			if (scenario === "conflicting-claim") await save(claimPath, {});
			if (scenario === "completion-without-claim") await save(completionPath, {});
			if (scenario === "prior-invocation")
				await save(`${root}/fixture-next-invocation.json`, original.serviceInvocationId);
			if (scenario === "new-stop-claim") await save(`${root}/service-stop-claim-${id(100)}.json`, {});
			if (scenario === "new-child-claim") await save(`${root}/service-successor-${id(100)}.json`, {});
			if (scenario === "normal") assert.equal(run("--inspect").status, 1);
			const result = run("--restart", scenario, scenario === "no-lock");
			assert.equal(
				result.status,
				scenario === "normal" ? 0 : scenario.startsWith("crash-") ? null : 1,
				`${scenario}: ${result.stderr}`,
			);
			assert(!result.stderr.includes("must-not-leak"));
			const recoverable = ["normal", "crash-after-start", "lost-reply", "cancel-during-start"].includes(scenario),
				count = await load(`${root}/fixture-restart-count.json`);
			if (scenario.startsWith("history-")) {
				assert.equal(count, scenario === "history-during-start" ? 1 : 0);
				assert.equal(run("--restart").status, 1);
				assert.equal(run("--inspect").status, 1);
				assert.equal(await load(`${root}/fixture-restart-count.json`), count);
				await assert.rejects(readFile(completionPath), { code: "ENOENT" });
			}
			if (
				recoverable ||
				["crash-before-start", "failed-start", "configuration-during-start", "prior-invocation"].includes(scenario)
			) {
				const replay = run("--restart");
				assert.equal(replay.status, recoverable ? 0 : 1, replay.stderr);
				assert.equal(await load(`${root}/fixture-restart-count.json`), count);
			}
			if (recoverable) {
				const completion = await load(completionPath);
				parseCompanyComputerServiceRestartCompletion(completion, staged.command, request as never);
				assert.equal((await lstat(completionPath)).mode & 0o7777, 0o600);
				assert.equal(run("--inspect").status, 0);
				assert.equal(run("--inspect", "same-nonce").status, 1);
				assert((await readFile(`${root}/service-start-completion.json`)).equals(originalBytes));
				assert((await readFile(previous.path)).equals(previous.completionBytes));
				if (scenario === "normal") {
					const secondStop = await stopInvocation(await readFile(completionPath), 1);
					assert.equal(run("--restart").status, 1, "old restart crossed its stop claim");
					const secondRequest = await prepareRestart(secondStop, 1);
					await stageRestart(secondRequest, 1);
					const second = run("--restart");
					assert.equal(second.status, 0, second.stderr);
					assert.equal(await load(`${root}/fixture-restart-count.json`), 2);
					assert.equal(await load(`${root}/fixture-stop-count.json`), 2);
					assert.equal(
						(await load(`${root}/service-restart-completion-${id(101)}.json`)).serviceInvocationId,
						"d".repeat(32),
					);
					await save(commandPath, staged.command);
					assert.equal(run("--restart").status, 1);
					await save(`${root}/fixture-stop-command.json`, previous.command);
					assert.equal(run("--stop").status, 1);
					assert.equal(await load(`${root}/fixture-restart-count.json`), 2);
					assert.equal(await load(`${root}/fixture-stop-count.json`), 2);
					assert.deepEqual(await load(completionPath), completion);
					assert((await readFile(previous.path)).equals(previous.completionBytes));
				}
			}
			console.log(`PASS protected restart ${scenario}`);
		} finally {
			await lock.close();
		}
	}
	console.log(
		JSON.stringify({
			checks: scenarios.length,
			actualRootCustody: true,
			actualKernelFlock: true,
			repeatedRestarts: 2,
			systemd: "synthetic",
			sql: "synthetic",
			modelCalls: false,
		}),
	);
}
