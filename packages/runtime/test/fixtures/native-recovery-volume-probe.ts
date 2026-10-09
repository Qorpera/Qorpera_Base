import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, statfs } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import type {
	CloudRunnerControlRequest,
	CloudRunnerControlTransport,
} from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { CloudRunnerBrokerTransport } from "@qorpera/runtime/cloud-runner-broker";
import { DisposableCloudRunner } from "@qorpera/runtime/cloud-runner-control";
import { EphemeralCloudRunnerWorker } from "@qorpera/runtime/cloud-runner-worker";
import { FileCloudRunnerAuthorityStore } from "@qorpera/runtime/cloud-runner-worker-state";

// Only the dedicated, synthetic test volume. No runtime secrets or model calls.
const root = "/var/lib/qorpera-step2-recovery";
const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const actorId = "ec30142e-47c8-4532-a6c4-10612d02c619";
const jobId = "b953532a-c4f0-4b81-b901-d4bb21237001";
const runId = "b953532a-c4f0-4b81-b901-d4bb21237002";
const assignmentId = "b953532a-c4f0-4b81-b901-d4bb21237003";
const assignment = { assignmentId, jobId, capability: "a".repeat(43) };
const result = { outcome: "private synthetic outcome", neverSend: "NOT_A_PUBLIC_MESSAGE" };
const cases = ["completed", "interrupted", "expired"] as const;

function quotaFailure(error: unknown): void {
	const failure = error as NodeJS.ErrnoException;
	// libuv may expose EDQUOT as an unnamed errno for virtiofs-backed ZFS.
	assert.ok(
		failure.code === "ENOSPC" || failure.errno === -osConstants.errno.EDQUOT,
		`Unexpected quota failure: ${failure.code}/${failure.syscall}`,
	);
}

class SyntheticControl implements CloudRunnerControlTransport {
	readonly calls: CloudRunnerControlRequest["action"][] = [];
	readonly loseCompletion: boolean;
	constructor(loseCompletion: boolean) {
		this.loseCompletion = loseCompletion;
	}
	async request(_token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		this.calls.push(body.action);
		if (body.action === "activate")
			return {
				runner_id: runnerId,
				profile_id: profileId,
				client_runner_id: actorId,
				display_name: "Synthetic recovery",
				runner_kind: "qorpera_computer",
				capabilities: ["agent_turn"],
				max_concurrency: 1,
				status: "active",
				online: true,
				activation_expires_at: new Date(Date.now() + 900_000).toISOString(),
				session_expires_at: new Date(Date.now() + 900_000).toISOString(),
				registered_by_user_id: actorId,
				created_at: new Date().toISOString(),
				active_lease_count: 0,
			};
		assert.ok(body.action === "accept" || body.action === "complete", "Recovery must not acquire fresh authority");
		if (body.action === "complete") {
			assert.deepEqual(body.result, result);
			if (this.loseCompletion) throw new Error("Synthetic lost completion acknowledgement");
		}
		return {
			job_id: jobId,
			run_id: runId,
			assignment_id: assignmentId,
			profile_id: profileId,
			environment_id: actorId,
			substrate_version_id: actorId,
			client_job_id: jobId,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			payload: { prompt: "synthetic" },
			status: body.action === "complete" ? "completed" : "leased",
			attempt_count: 1,
			runner_id: runnerId,
			result: body.action === "complete" ? result : null,
			output_artifact_count: 0,
			created_by_user_id: actorId,
			created_at: new Date().toISOString(),
			lease_expires_at: body.action === "complete" ? null : new Date(Date.now() + 600_000).toISOString(),
		};
	}
}

const metadata = await lstat(root);
assert.equal(metadata.isDirectory(), true);
assert.equal(metadata.uid, process.getuid?.());
assert.equal(metadata.mode & 0o077, 0);
assert.equal(
	(await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter((line) => line.split(" ")[4] === root).length,
	1,
	"Probe requires a separate test-volume mount",
);

if (process.argv[2] === "seed") {
	for (const name of cases) {
		const store = new FileCloudRunnerAuthorityStore(join(root, name, "authority.json"));
		assert.equal(await store.load(), undefined, "Never overwrite existing recovery data");
		const control = new SyntheticControl(true);
		const runner = await DisposableCloudRunner.open(control, runnerId, store, "b".repeat(43));
		await runner.activate("linux-x64", "synthetic");
		await runner.acceptAssignment(assignment);
		await runner.markExecutionStarted(jobId);
		if (name !== "interrupted")
			await assert.rejects(runner.complete(jobId, result), /lost completion acknowledgement/);
		assert.equal(runner.executionStarted(jobId), true);
	}
	process.stdout.write("SYNTHETIC_RECOVERY_DURABLE_READY_FOR_VM_STOP\n");
	setInterval(() => undefined, 1000);
} else if (process.argv[2] === "verify" || process.argv[2] === "verify-expired") {
	const restoredExpired = process.argv[2] === "verify-expired";
	for (const name of cases) {
		const store = new FileCloudRunnerAuthorityStore(join(root, name, "authority.json"));
		const control = new SyntheticControl(false);
		const runner = await DisposableCloudRunner.open(control, runnerId, store);
		assert.equal(runner.executionStarted(jobId), true);
		let effects = 0;
		const forbidden = (): never => {
			effects++;
			throw new Error("Recovery cannot execute work or publish a message");
		};
		const broker = new Proxy({} as CloudRunnerBrokerTransport, { get: () => forbidden });
		const deadline = Date.parse(runner.leasedJobs()[0]!.leaseExpiresAt!);
		if (restoredExpired) assert.ok(deadline < Date.now(), "Imported authority must already have expired");
		const worker = new EphemeralCloudRunnerWorker({
			runner,
			brokerTransport: broker,
			executeJob: async () => forbidden(),
			platform: "linux-x64",
			runnerVersion: "synthetic",
			...(name === "expired" && !restoredExpired ? { now: () => deadline + 1 } : {}),
		});
		await worker.runNext(undefined);
		assert.equal(effects, 0);
		assert.deepEqual(runner.leasedJobs(), []);
		if (name === "completed" && !restoredExpired) {
			assert.deepEqual(control.calls, ["complete"]);
			assert.deepEqual(runner.recoveryRecords(), []);
		} else {
			assert.deepEqual(control.calls, []);
			assert.equal(
				runner.recoveryRecords()[0]?.reason,
				name === "expired" || restoredExpired ? "authority-unavailable" : "interrupted",
			);
			if (name !== "interrupted") assert.deepEqual(runner.recoveryRecords()[0]?.completion?.result, result);
			await assert.rejects(runner.acceptAssignment(assignment), /reconciliation/);
		}
		assert.deepEqual((await DisposableCloudRunner.open(control, runnerId, store)).snapshot(), runner.snapshot());
		process.stdout.write(`${name.toUpperCase()}_RECOVERY_PASSED\n`);
	}
	process.stdout.write("NATIVE_RECOVERY_VOLUME_PROBE_PASSED\n");
} else if (process.argv[2] === "capacity") {
	const space = await statfs(root);
	assert.ok(space.bsize * space.blocks <= 128 * 1024 * 1024, "Refuse a capacity probe outside the small test volume");
	await mkdir(join(root, "capacity"), { recursive: true, mode: 0o700 });
	const path = join(root, "capacity", "authority.json");
	const store = new FileCloudRunnerAuthorityStore(path);
	await store.save({ kept: "synthetic durable state" });
	const before = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	const filler = join(root, "capacity", "synthetic-fill");
	const handle = await open(filler, "wx", 0o600);
	let full = false;
	try {
		// Incompressible bounded writes fill only this quota-limited test volume.
		for (let i = 0; i < 128; i++) {
			try {
				await handle.write(randomBytes(1024 * 1024));
				await handle.sync();
			} catch (error) {
				quotaFailure(error);
				full = true;
				break;
			}
		}
		assert.equal(full, true, "The test volume must enforce its quota");
		for (let i = 0; i < 512; i++) {
			try {
				await handle.write(randomBytes(4096));
				await handle.sync();
			} catch (error) {
				quotaFailure(error);
				break;
			}
		}
		await assert.rejects(store.save({ replacement: randomBytes(100_000).toString("base64") }));
		assert.equal(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
			before,
		);
		process.stdout.write("CAPACITY_FAILURE_PRESERVED_DURABLE_STATE\n");
	} finally {
		await handle.close();
		await rm(filler);
	}
} else throw new Error("Choose seed, verify, verify-expired or capacity");
