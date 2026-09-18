import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, link, lstat, open, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import {
	type CompanyComputerPreparationUnitState,
	controlCompanyComputerPreparation,
	OFFICE_PREPARATION_CONTROL_LOCK,
	OFFICE_PREPARATION_CONTROL_ROOT,
	openCompanyComputerPreparationLock,
} from "../../src/cloud-company-computer-preparation-control.ts";

const root = OFFICE_PREPARATION_CONTROL_ROOT;
const requestPath = "/etc/qorpera-office/preparation.json";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idle: CompanyComputerPreparationUnitState = {
	activeState: "inactive",
	subState: "dead",
	result: "success",
	invocationId: "",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
const complete: CompanyComputerPreparationUnitState = {
	...idle,
	activeState: "active",
	subState: "exited",
	invocationId: "a".repeat(32),
	execMainCode: 1,
};
const mode = process.argv[2],
	scenario = process.argv[3];
const save = async (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
if (mode === "--child") {
	const command = await load(`${root}/fixture-command.json`);
	let inspections = 0;
	await controlCompanyComputerPreparation(
		command,
		{
			async inspect() {
				inspections++;
				const state = await load(`${root}/fixture-state.json`);
				return scenario === "unit-changed" && inspections >= 4 ? { ...state, invocationId: "b".repeat(32) } : state;
			},
			async start() {
				await save(`${root}/fixture-starts.json`, (await load(`${root}/fixture-starts.json`)) + 1);
				assert.deepEqual((await load(`${root}/claim.json`)).command, command);
				assert.equal((await lstat(requestPath)).mode & 0o7777, 0o444);
				const request = parseCompanyComputerPreparationRequest(await load(requestPath));
				const report = {
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
					contentSha256: sha(JSON.stringify(request.entries)),
					observationSha256: "e".repeat(64),
					entries: request.entries.length,
					totalBytes: 0,
					requestSha256: command.requestSha256,
					invocationId: complete.invocationId,
				};
				if (scenario === "report-boot") report.bootId = id(99);
				if (scenario === "report-invocation") report.invocationId = "b".repeat(32);
				if (scenario === "report-digest") report.requestSha256 = "f".repeat(64);
				if (scenario === "report-content") report.contentSha256 = "f".repeat(64);
				if (scenario === "report-missing") await unlink(`${root}/result.json`);
				else if (scenario === "report-json") await writeFile(`${root}/result.json`, "{");
				else await save(`${root}/result.json`, report);
				if (scenario === "report-symlink") {
					await unlink(`${root}/result.json`);
					await symlink(requestPath, `${root}/result.json`);
				}
				if (scenario === "report-permissions") await chmod(`${root}/result.json`, 0o644);
				if (scenario === "request-changed") await writeFile(requestPath, "{}");
				if (scenario === "lock-replaced") {
					await unlink(OFFICE_PREPARATION_CONTROL_LOCK);
					await writeFile(OFFICE_PREPARATION_CONTROL_LOCK, "", { mode: 0o600 });
				}
				const state = { ...complete };
				if (scenario === "unit-nonzero") state.execMainStatus = 1;
				if (scenario === "unit-signalled") state.execMainCode = 2;
				if (scenario === "unit-running") {
					state.activeState = "activating";
					state.subState = "start";
					state.mainPid = 42;
				}
				if (scenario === "unit-job") state.jobId = 42;
				if (scenario === "unit-failed") state.result = "exit-code";
				if (scenario === "prior-invocation") state.invocationId = "a".repeat(32);
				await save(`${root}/fixture-state.json`, state);
				if (scenario === "lost-start-response") throw new Error("synthetic lost reply after completion");
			},
		},
		scenario === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
	);
	console.log("verified");
} else {
	assert.equal(mode, "--parent");
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid?.(), 0);
	const scenarios = [
		"normal",
		"large-request",
		"maximum-request",
		"wrong-boot",
		"bad-staging-hash",
		"stage-mode",
		"stage-owner",
		"stage-symlink",
		"stage-hardlink",
		"stage-fifo",
		"stage-oversized",
		"config-conflict",
		"config-parent",
		"claim-conflict",
		"claim-null",
		"claim-without-start",
		"claim-missing",
		"unit-already-active",
		"unit-nonzero",
		"unit-signalled",
		"unit-running",
		"unit-job",
		"unit-failed",
		"unit-changed",
		"prior-invocation",
		"report-boot",
		"report-invocation",
		"report-digest",
		"report-content",
		"report-missing",
		"report-json",
		"report-symlink",
		"report-permissions",
		"request-changed",
		"lock-replaced",
		"lost-start-response",
		"cancelled",
		"no-flock",
		"parent-flock",
		"missing-lock",
		"unsafe-lock",
		"symlink-lock",
		"receipt-conflict",
		"receipt-mode",
		"receipt-owner",
		"receipt-symlink",
		"receipt-hardlink",
		"receipt-fifo",
		"receipt-missing-after-completion",
		"receipt-changed-after-completion",
		"receipt-partial-completion",
		"old-completion",
	];
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	for (const scenario of scenarios) {
		for (const directory of [root, "/etc/qorpera-office"]) {
			await chmod(directory, directory === root ? 0o700 : 0o755);
			for (const name of await readdir(directory))
				await rm(`${directory}/${name}`, { recursive: true, force: true });
		}
		await writeFile(OFFICE_PREPARATION_CONTROL_LOCK, "", { mode: 0o600 });
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
				outputInventorySha256: "a".repeat(64),
			},
			workbenchMount: {
				filesystem: "virtiofs",
				source: "synthetic",
				root: "/",
				mountPoint: "/var/lib/qorpera-office",
			},
			limits: { memoryBytes: 256 * 1024 ** 2, pids: 64, cpuQuota: 100000, cpuPeriod: 100000 },
			entries: [".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
				path,
				kind: "directory",
				mode: 0o700,
				bytes: 0,
				sha256: null,
			})),
		});
		const serialized = JSON.stringify(request);
		const padding =
			scenario === "large-request"
				? 2 * 1024 ** 2
				: scenario === "maximum-request"
					? 16 * 1024 ** 2 - Buffer.byteLength(serialized)
					: 0;
		const encoded = Buffer.from(serialized + " ".repeat(padding));
		const receiptBytes = Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(request))}\n`);
		if (["receipt-conflict", "receipt-mode", "receipt-owner", "receipt-hardlink"].includes(scenario)) {
			await writeFile(
				COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
				scenario === "receipt-conflict" ? "{}" : receiptBytes,
				{ mode: 0o444 },
			);
			if (scenario === "receipt-mode") await chmod(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 0o644);
			if (scenario === "receipt-owner") await chown(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 1000, 1000);
			if (scenario === "receipt-hardlink")
				await link(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, "/etc/qorpera-office/adoption-alias.json");
		}
		if (scenario === "receipt-symlink") await symlink(requestPath, COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH);
		if (scenario === "receipt-fifo")
			assert.equal(spawnSync("mkfifo", ["-m", "444", COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH]).status, 0);
		const command = {
			commandId: id(7),
			requestSha256: sha(encoded),
			bootId: scenario === "wrong-boot" ? id(99) : bootId,
		};
		const staged = `${root}/incoming-${command.requestSha256}.json`;
		await writeFile(staged, encoded, { mode: 0o400 });
		await save(`${root}/fixture-command.json`, command);
		await save(`${root}/fixture-state.json`, idle);
		await save(`${root}/fixture-starts.json`, 0);
		if (scenario === "bad-staging-hash") await writeFile(staged, "{}");
		if (scenario === "stage-mode") await chmod(staged, 0o644);
		if (scenario === "stage-owner") await chown(staged, 1000, 1000);
		if (scenario === "stage-symlink") {
			await unlink(staged);
			await symlink(`${root}/fixture-command.json`, staged);
		}
		if (scenario === "stage-hardlink") await link(staged, `${root}/alias`);
		if (scenario === "stage-fifo") {
			await unlink(staged);
			assert.equal(spawnSync("mkfifo", ["-m", "400", staged]).status, 0);
		}
		if (scenario === "stage-oversized") await writeFile(staged, Buffer.alloc(16 * 1024 ** 2 + 1));
		if (scenario === "config-conflict") await writeFile(requestPath, "existing protected request", { mode: 0o444 });
		if (scenario === "config-parent") await chmod("/etc/qorpera-office", 0o777);
		if (scenario === "claim-conflict")
			await save(`${root}/claim.json`, {
				schema: "qorpera.office-preparation-claim/v1",
				command: { ...command, commandId: id(8) },
				priorInvocationId: "",
			});
		if (scenario === "claim-null") await save(`${root}/claim.json`, null);
		if (scenario === "claim-without-start" || scenario === "prior-invocation") {
			await writeFile(requestPath, encoded, { mode: 0o444 });
			await save(`${root}/claim.json`, {
				schema: "qorpera.office-preparation-claim/v1",
				command,
				priorInvocationId: scenario === "prior-invocation" ? "a".repeat(32) : "",
			});
			if (scenario === "prior-invocation") await save(`${root}/fixture-state.json`, complete);
		}
		if (scenario === "claim-missing") await save(`${root}/completion.json`, {});
		if (scenario === "unit-already-active") await save(`${root}/fixture-state.json`, complete);
		if (scenario === "missing-lock") await unlink(OFFICE_PREPARATION_CONTROL_LOCK);
		if (scenario === "unsafe-lock") await chmod(OFFICE_PREPARATION_CONTROL_LOCK, 0o644);
		if (scenario === "symlink-lock") {
			await unlink(OFFICE_PREPARATION_CONTROL_LOCK);
			await symlink(`${root}/fixture-starts.json`, OFFICE_PREPARATION_CONTROL_LOCK);
		}
		if (["missing-lock", "unsafe-lock", "symlink-lock"].includes(scenario)) {
			await assert.rejects(openCompanyComputerPreparationLock());
			if (scenario === "missing-lock") await assert.rejects(lstat(OFFICE_PREPARATION_CONTROL_LOCK));
		} else {
			const lock = await open(OFFICE_PREPARATION_CONTROL_LOCK, "r+");
			try {
				const run = () =>
					spawnSync(
						scenario === "no-flock" ? process.execPath : "/usr/bin/flock",
						[
							...(scenario === "no-flock"
								? []
								: [
										"--exclusive",
										"--nonblock",
										...(scenario === "parent-flock" ? [] : ["--no-fork"]),
										"/proc/self/fd/3",
										process.execPath,
									]),
							"/probe.mjs",
							"--child",
							scenario,
						],
						{ encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe", lock.fd] },
					);
				const result = run();
				const postCompletion = [
					"receipt-missing-after-completion",
					"receipt-changed-after-completion",
					"receipt-partial-completion",
					"old-completion",
				].includes(scenario);
				const successful = ["normal", "large-request", "maximum-request"].includes(scenario) || postCompletion;
				assert.equal(result.status, successful ? 0 : 1, `${scenario}: ${result.stderr}`);
				if (successful || scenario === "lost-start-response") {
					if (postCompletion) {
						const before = await lstat(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH);
						if (scenario === "receipt-missing-after-completion")
							await unlink(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH);
						if (scenario === "receipt-changed-after-completion")
							await writeFile(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, "{}");
						if (scenario === "receipt-partial-completion") await unlink(`${root}/completion.json`);
						if (scenario === "old-completion") {
							const old = await load(`${root}/completion.json`);
							old.schema = "qorpera.office-preparation-completion/v1";
							delete old.adoptionReceiptSha256;
							await save(`${root}/completion.json`, old);
						}
						const retry = run();
						assert.equal(
							retry.status,
							scenario === "receipt-partial-completion" ? 0 : 1,
							`${scenario}: ${retry.stderr}`,
						);
						assert.equal(await load(`${root}/fixture-starts.json`), 1);
						if (scenario === "receipt-missing-after-completion")
							await assert.rejects(lstat(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH));
						else assert.equal((await lstat(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH)).ino, before.ino);
						if (scenario === "receipt-changed-after-completion")
							assert.equal(await readFile(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, "utf8"), "{}");
					}
					if (!postCompletion || scenario === "receipt-partial-completion") {
						const replay = run();
						assert.equal(replay.status, 0, `${scenario} replay: ${replay.stderr}`);
						assert.equal(await load(`${root}/fixture-starts.json`), 1);
						const completion = await load(`${root}/completion.json`);
						assert.deepEqual(completion.command, command);
						assert.equal(completion.invocationId, complete.invocationId);
						assert.equal(completion.reportSha256, sha(await readFile(`${root}/result.json`)));
						assert.equal(completion.schema, "qorpera.office-preparation-completion/v2");
						assert.equal(completion.adoptionReceiptSha256, sha(receiptBytes));
						assert.deepEqual(await readFile(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH), receiptBytes);
						const receiptStat = await lstat(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH);
						assert.equal(receiptStat.uid, 0);
						assert.equal(receiptStat.gid, 0);
						assert.equal(receiptStat.mode & 0o7777, 0o444);
						assert.equal(receiptStat.nlink, 1);
						for (const name of ["claim.json", "completion.json", "result.json"]) {
							const stat = await lstat(`${root}/${name}`);
							assert.equal(stat.mode & 0o7777, 0o600);
							assert.equal(stat.uid, 0);
							assert.equal(stat.nlink, 1);
						}
						assert.ok((await readFile(requestPath)).equals(encoded));
					}
				} else if (scenario !== "claim-missing") await assert.rejects(lstat(`${root}/completion.json`));
			} finally {
				await lock.close();
			}
		}
		assert.equal((await load(`${root}/fixture-starts.json`)) <= 1, true, scenario);
		console.log(
			JSON.stringify({
				schema: "qorpera.office-preparation-control-linux-proof/v1",
				scenario,
				actualProtectedFiles: true,
				actualKernelFlock: true,
				syntheticSystemdManager: true,
				actualSystemdLifecycle: false,
				physicalLxdGuest: false,
				activated: false,
			}),
		);
	}
}
