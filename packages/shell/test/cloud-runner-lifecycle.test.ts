import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type CloudRunnerAdminTransport,
	prepareCloudRunnerRegistration,
	QorperaCloudRunnerAdmin,
} from "../src/cloud-runner-admin.ts";
import {
	type CloudRunnerControlRequest,
	type CloudRunnerControlTransport,
	DisposableCloudRunner,
} from "../src/cloud-runner-control.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const clientRunnerId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const runnerId = "5b07e271-c030-422c-a3ef-ad10830c393d";
const substrateVersionId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const clientJobId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const jobId = "509eb21f-981a-4c39-9f64-5fa1b121f367";
const assignmentId = "509eb21f-981a-4c39-9f64-5fa1b121f368";
const assignmentCapability = "z".repeat(43);
const actorUserId = "4a9d13d1-89fe-4896-a39e-67fc33db67d1";
const createdAt = "2026-08-16T12:00:00.000Z";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

class DisposableRunnerService implements CloudRunnerAdminTransport, CloudRunnerControlTransport {
	#activationTokenSha256?: string;
	#sessionToken?: string;
	#status: "pending" | "active" | "revoked" = "pending";
	#jobStatus: "queued" | "leased" | "completed" = "queued";
	#leaseToken?: string;

	#runnerRecord() {
		return {
			runner_id: runnerId,
			profile_id: profileId,
			client_runner_id: clientRunnerId,
			display_name: "Disposable test runner",
			runner_kind: "local",
			capabilities: ["agent_turn"],
			max_concurrency: 1,
			status: this.#status,
			online: this.#status === "active",
			platform: this.#status === "active" ? "linux-x64" : null,
			runner_version: this.#status === "active" ? "0.1.0" : null,
			activation_expires_at: "2026-08-16T12:15:00.000Z",
			session_expires_at: this.#status === "active" ? "2026-08-16T12:30:00.000Z" : null,
			registered_by_user_id: actorUserId,
			created_at: createdAt,
			activated_at: this.#status === "active" ? createdAt : null,
			last_seen_at: this.#status === "active" ? createdAt : null,
			revoked_by_user_id: this.#status === "revoked" ? actorUserId : null,
			revoked_at: this.#status === "revoked" ? createdAt : null,
			active_lease_count: this.#jobStatus === "leased" ? 1 : 0,
		};
	}

	#jobRecord() {
		return {
			job_id: jobId,
			profile_id: profileId,
			environment_id: environmentId,
			session_id: null,
			substrate_version_id: substrateVersionId,
			client_job_id: clientJobId,
			required_capability: "agent_turn",
			job_type: "agent_turn",
			payload: { prompt: "Run against this immutable substrate" },
			status: this.#jobStatus,
			attempt_count: this.#jobStatus === "queued" ? 0 : 1,
			runner_id: this.#jobStatus === "queued" ? null : runnerId,
			result: this.#jobStatus === "completed" ? { outcome: "ok" } : null,
			output_artifact_count: 0,
			output_artifact_index_id: null,
			output_substrate_version_id: null,
			last_error: null,
			created_by_user_id: actorUserId,
			created_at: createdAt,
			started_at: this.#jobStatus === "queued" ? null : createdAt,
			lease_expires_at: this.#jobStatus === "leased" ? "2026-08-16T12:02:00.000Z" : null,
			finished_at: this.#jobStatus === "completed" ? createdAt : null,
			cancelled_by_user_id: null,
			cancelled_at: null,
		};
	}

	async createRunnerRegistration(
		input: Parameters<CloudRunnerAdminTransport["createRunnerRegistration"]>[0],
	): Promise<unknown> {
		this.#activationTokenSha256 = input.p_activation_token_sha256;
		return this.#runnerRecord();
	}

	async reissueRunnerActivation(
		input: Parameters<CloudRunnerAdminTransport["reissueRunnerActivation"]>[0],
	): Promise<unknown> {
		this.#activationTokenSha256 = input.p_activation_token_sha256;
		return this.#runnerRecord();
	}

	async listRunners(): Promise<unknown> {
		return [this.#runnerRecord()];
	}

	async revokeRunner(): Promise<unknown> {
		this.#status = "revoked";
		this.#sessionToken = undefined;
		if (this.#jobStatus === "leased") this.#jobStatus = "queued";
		return this.#runnerRecord();
	}

	async enqueueRunnerJob(): Promise<unknown> {
		return this.#jobRecord();
	}

	async listRunnerJobs(): Promise<unknown> {
		return [this.#jobRecord()];
	}

	async cancelRunnerJob(): Promise<unknown> {
		throw new Error("not used");
	}

	async listRunnerAudit(): Promise<unknown> {
		return [];
	}

	async listRunnerUsage(): Promise<unknown> {
		return [];
	}

	async configureRunnerModelPolicy(): Promise<unknown> {
		throw new Error("Lifecycle test does not configure model policy");
	}

	async listRunnerModelUsage(): Promise<unknown> {
		return [];
	}

	async request(token: string, body: CloudRunnerControlRequest): Promise<unknown> {
		if (body.action === "activate") {
			if (this.#status !== "pending" || sha256(token) !== this.#activationTokenSha256) {
				throw new Error("runner activation rejected");
			}
			this.#status = "active";
			this.#sessionToken = body.nextSessionToken;
			return this.#runnerRecord();
		}
		if (this.#status !== "active" || token !== this.#sessionToken) throw new Error("runner session rejected");
		if (body.action === "heartbeat") {
			this.#sessionToken = body.nextSessionToken;
			return this.#runnerRecord();
		}
		if (body.action === "accept") {
			if (this.#jobStatus !== "queued") return null;
			this.#jobStatus = "leased";
			this.#leaseToken = body.assignmentCapability;
			return this.#jobRecord();
		}
		if (body.leaseToken !== this.#leaseToken || this.#jobStatus !== "leased") {
			throw new Error("runner lease rejected");
		}
		if (body.action === "complete") {
			this.#jobStatus = "completed";
			return this.#jobRecord();
		}
		return this.#jobRecord();
	}
}

describe("cloud runner lifecycle", () => {
	it("registers, activates, leases exact substrate work, completes, and loses authority on revoke", async () => {
		const service = new DisposableRunnerService();
		const admin = new QorperaCloudRunnerAdmin(service);
		const prepared = prepareCloudRunnerRegistration({
			profileId,
			clientRunnerId,
			displayName: "Disposable test runner",
			capabilities: ["agent_turn"],
		});
		const registration = await admin.registerRunner(prepared);
		await admin.enqueueJob({
			environmentId,
			substrateVersionId,
			clientJobId,
			requiredCapability: "agent_turn",
			jobType: "agent_turn",
			payload: { prompt: "Run against this immutable substrate" },
		});

		const runner = new DisposableCloudRunner(service, registration.runner.runnerId, registration.activationToken);
		await expect(runner.activate("linux-x64", "0.1.0")).resolves.toMatchObject({ status: "active" });
		await expect(
			runner.acceptAssignment({ assignmentId, jobId, capability: assignmentCapability }),
		).resolves.toMatchObject({
			jobId,
			substrateVersionId,
			status: "leased",
		});
		await expect(runner.complete(jobId, { outcome: "ok" })).resolves.toMatchObject({ status: "completed" });
		await expect(admin.listJobs(profileId)).resolves.toMatchObject([{ jobId, status: "completed" }]);

		await expect(admin.revokeRunner(runnerId)).resolves.toMatchObject({ status: "revoked", online: false });
		await expect(runner.heartbeat()).rejects.toThrow("session rejected");
	});
});
