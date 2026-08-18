import { describe, expect, it, vi } from "vitest";
import {
	type CloudRunnerAdminTransport,
	prepareCloudRunnerActivation,
	prepareCloudRunnerRegistration,
	QorperaCloudRunnerAdmin,
} from "../src/cloud-runner-admin.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const runnerId = "a17381c2-3508-4573-b351-a5394adbd1f4";
const clientRunnerId = "5b07e271-c030-422c-a3ef-ad10830c393d";
const sessionId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const substrateVersionId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const clientJobId = "509eb21f-981a-4c39-9f64-5fa1b121f367";
const jobId = "4a9d13d1-89fe-4896-a39e-67fc33db67d1";
const actorUserId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-08-16T12:00:00.000Z";

function runnerRecord(status: "pending" | "active" | "revoked" = "pending") {
	return {
		runner_id: runnerId,
		profile_id: profileId,
		client_runner_id: clientRunnerId,
		display_name: "Jonas development runner",
		runner_kind: "local",
		capabilities: ["agent_turn", "git_worktree"],
		max_concurrency: 2,
		status,
		online: status === "active",
		platform: status === "active" ? "darwin-arm64" : null,
		runner_version: status === "active" ? "0.1.0" : null,
		activation_expires_at: "2026-08-16T12:15:00.000Z",
		session_expires_at: status === "active" ? "2026-08-16T12:15:00.000Z" : null,
		registered_by_user_id: actorUserId,
		created_at: createdAt,
		activated_at: status === "active" ? createdAt : null,
		last_seen_at: status === "active" ? createdAt : null,
		revoked_by_user_id: status === "revoked" ? actorUserId : null,
		revoked_at: status === "revoked" ? createdAt : null,
		active_lease_count: 0,
	};
}

function jobRecord(status: "queued" | "cancelled" = "queued") {
	return {
		job_id: jobId,
		profile_id: profileId,
		environment_id: environmentId,
		session_id: sessionId,
		substrate_version_id: substrateVersionId,
		client_job_id: clientJobId,
		required_capability: "agent_turn",
		job_type: "agent_turn",
		payload: { prompt: "Prepare the verified financial baseline" },
		status,
		attempt_count: 0,
		runner_id: null,
		result: null,
		output_artifact_count: 0,
		output_artifact_index_id: null,
		output_substrate_version_id: null,
		last_error: null,
		created_by_user_id: actorUserId,
		created_at: createdAt,
		started_at: null,
		lease_expires_at: null,
		finished_at: null,
		cancelled_by_user_id: status === "cancelled" ? actorUserId : null,
		cancelled_at: status === "cancelled" ? createdAt : null,
	};
}

function transport(): CloudRunnerAdminTransport {
	return {
		createRunnerRegistration: vi.fn(async () => runnerRecord()),
		reissueRunnerActivation: vi.fn(async () => runnerRecord()),
		listRunners: vi.fn(async () => [runnerRecord()]),
		revokeRunner: vi.fn(async () => runnerRecord("revoked")),
		enqueueRunnerJob: vi.fn(async () => jobRecord()),
		listRunnerJobs: vi.fn(async () => [jobRecord()]),
		cancelRunnerJob: vi.fn(async () => jobRecord("cancelled")),
		listRunnerAudit: vi.fn(async () => [
			{
				receipt_id: 1,
				profile_id: profileId,
				runner_id: runnerId,
				job_id: null,
				event_type: "runner_registered",
				payload: { capabilities: ["agent_turn", "git_worktree"] },
				actor_user_id: actorUserId,
				created_at: createdAt,
			},
		]),
		listRunnerUsage: vi.fn(async () => [
			{
				observation_id: 1,
				profile_id: profileId,
				environment_id: environmentId,
				job_id: jobId,
				runner_id: runnerId,
				actor_user_id: actorUserId,
				usage: {
					schema: "qorpera.runner-usage/v1",
					execution_ms: 250,
					input_bytes: 1024,
					output_bytes: 512,
					result_bytes: 64,
					limits: {
						wall_time_ms: 30_000,
						memory_bytes: 512 * 1024 * 1024,
						cpu_millis: 2000,
						max_pids: 64,
						max_input_bytes: 2048,
						max_output_bytes: 1024,
						max_result_bytes: 1024,
					},
				},
				reserved_cpu_milliseconds: 500,
				reserved_memory_mib_milliseconds: 128_000,
				created_at: createdAt,
			},
		]),
		configureRunnerModelPolicy: vi.fn(async (input) => ({
			job_id: input.p_job_id,
			profile_id: profileId,
			environment_id: environmentId,
			allowed_models: input.p_allowed_models,
			max_calls: input.p_max_calls,
			max_input_tokens: input.p_max_input_tokens,
			max_output_tokens: input.p_max_output_tokens,
			authorized_by_user_id: actorUserId,
			created_at: createdAt,
		})),
		listRunnerModelUsage: vi.fn(async () => [
			{
				observation_id: 2,
				profile_id: profileId,
				environment_id: environmentId,
				job_id: jobId,
				request_id: "34343434-3434-4434-8434-343434343434",
				runner_id: runnerId,
				actor_user_id: actorUserId,
				authorized_by_user_id: actorUserId,
				provider: "openai",
				model: "gpt-test",
				outcome: "completed",
				input_tokens: 12,
				output_tokens: 4,
				cost_microusd: 125,
				created_at: createdAt,
			},
		]),
	};
}

describe("cloud runner administration", () => {
	it("prepares retry-safe pairing and sends only the activation hash to the hosted RPC", async () => {
		const fake = transport();
		const admin = new QorperaCloudRunnerAdmin(fake);
		const prepared = prepareCloudRunnerRegistration({
			profileId,
			clientRunnerId,
			displayName: " Jonas development runner ",
			capabilities: ["git_worktree", "agent_turn"],
			maxConcurrency: 2,
		});

		await expect(admin.registerRunner(prepared)).resolves.toMatchObject({
			runner: { runnerId, profileId, status: "pending" },
			activationToken: prepared.pairingSecret.activationToken,
		});
		expect(fake.createRunnerRegistration).toHaveBeenCalledWith({
			p_profile_id: profileId,
			p_client_runner_id: clientRunnerId,
			p_display_name: "Jonas development runner",
			p_capabilities: ["agent_turn", "git_worktree"],
			p_max_concurrency: 2,
			p_activation_token_sha256: prepared.pairingSecret.activationTokenSha256,
		});
		expect(JSON.stringify(vi.mocked(fake.createRunnerRegistration).mock.calls)).not.toContain(
			prepared.pairingSecret.activationToken,
		);

		const reissue = prepareCloudRunnerActivation(runnerId);
		await expect(admin.reissueRunnerActivation(reissue)).resolves.toMatchObject({
			runner: { runnerId, status: "pending" },
			activationToken: reissue.pairingSecret.activationToken,
		});
		await expect(
			admin.registerRunner({
				...prepared,
				pairingSecret: { ...prepared.pairingSecret, activationToken: "z".repeat(43) },
			}),
		).rejects.toThrow("hash");
	});

	it("queues exact substrate work and exposes revocation and audit controls", async () => {
		const fake = transport();
		const admin = new QorperaCloudRunnerAdmin(fake);

		await expect(
			admin.enqueueJob({
				environmentId,
				sessionId,
				substrateVersionId,
				clientJobId,
				requiredCapability: "agent_turn",
				jobType: "agent_turn",
				payload: { prompt: "Prepare the verified financial baseline" },
			}),
		).resolves.toMatchObject({ jobId, substrateVersionId, status: "queued" });
		expect(fake.enqueueRunnerJob).toHaveBeenCalledWith(
			expect.objectContaining({
				p_substrate_version_id: substrateVersionId,
				p_required_capability: "agent_turn",
			}),
		);
		await expect(admin.listRunners(profileId)).resolves.toHaveLength(1);
		await expect(admin.listJobs(profileId)).resolves.toHaveLength(1);
		await expect(admin.cancelJob(jobId)).resolves.toMatchObject({ status: "cancelled" });
		await expect(admin.revokeRunner(runnerId)).resolves.toMatchObject({ status: "revoked" });
		await expect(admin.listAudit(profileId)).resolves.toMatchObject([
			{ receiptId: 1, runnerId, eventType: "runner_registered" },
		]);
		await expect(admin.listUsage(profileId)).resolves.toMatchObject([
			{ observationId: 1, jobId, actorUserId, executionMs: 250 },
		]);
		await expect(
			admin.configureModelPolicy({
				jobId,
				allowedModels: [{ provider: "openai", model: "gpt-test" }],
				maxCalls: 4,
				maxInputTokens: 10_000,
				maxOutputTokens: 2_000,
			}),
		).resolves.toMatchObject({ jobId, maxCalls: 4, authorizedByUserId: actorUserId });
		await expect(admin.listModelUsage(profileId)).resolves.toMatchObject([
			{ observationId: 2, jobId, provider: "openai", costMicrousd: 125 },
		]);

		await expect(
			admin.enqueueJob({
				environmentId,
				substrateVersionId,
				clientJobId,
				requiredCapability: "agent_turn",
				jobType: "agent_turn",
				payload: [],
			}),
		).rejects.toThrow("payload");
	});
});
