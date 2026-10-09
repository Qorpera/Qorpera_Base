import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";
import { ProcessCloudRunnerProviderBackend } from "../src/process-provider.ts";

const roots: string[] = [];
const runId = "10000000-0000-4000-8000-000000000001";
const runnerId = "10000000-0000-4000-8000-000000000002";

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "qorpera-process-provider-"));
	roots.push(value);
	return value;
}

function work(): CloudRunnerWork {
	return {
		runId,
		jobId: "10000000-0000-4000-8000-000000000003",
		profileId: "10000000-0000-4000-8000-000000000004",
		environmentId: "10000000-0000-4000-8000-000000000005",
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: "10000000-0000-4000-8000-000000000006",
		substrateVersionId: "10000000-0000-4000-8000-000000000007",
		companySnapshotId: "10000000-0000-4000-8000-000000000008",
		staffAgentId: "10000000-0000-4000-8000-000000000009",
		staffVersion: 1,
		inputIds: ["10000000-0000-4000-8000-000000000010"],
		transcriptStartSequence: 1,
		deadlineAt: "2099-08-21T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		computeIdentityId: "10000000-0000-4000-8000-000000000011",
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: "10000000-0000-4000-8000-000000000012",
		computeTemplateKey: "qorpera-member-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: "f".repeat(64),
		workerClass: "managed_sandbox",
		requestedByUserId: "10000000-0000-4000-8000-000000000012",
		sponsoredByUserId: "10000000-0000-4000-8000-000000000012",
		sponsor: {
			bindingId: "10000000-0000-4000-8000-000000000013",
			version: 1,
			kind: "member_connection",
			providerConnectionId: "10000000-0000-4000-8000-000000000014",
			providerConnectionVersion: 1,
			provider: "openai",
			authenticationMode: "native_subscription",
			nativeHarness: "codex-cli",
			allowAutonomous: false,
		},
		modelPolicy: {
			provider: "openai",
			model: "gpt-test",
			maxCalls: 1,
			maxInputTokens: 1_000_000,
			maxOutputTokens: 100_000,
			maxCostMicrousd: 1,
		},
		attempt: 1,
	};
}

describe("process cloud runner provider", () => {
	it("provisions immutable compute authority and delivers one assignment", async () => {
		const directory = await root();
		const runnerModule = join(directory, "runner.mjs");
		const nativeProviderModule = join(directory, "native-provider.mjs");
		const nativeProviderMasterKeyFile = join(directory, "native-provider-master-key");
		await writeFile(runnerModule, "setInterval(() => {}, 1000);\n", "utf-8");
		await writeFile(
			nativeProviderModule,
			[
				'import { writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'writeFileSync(join(process.cwd(), "native-env.json"), JSON.stringify({',
				"  masterKey: process.env.QORPERA_NATIVE_PROVIDER_MASTER_KEY,",
				"  masterKeyFile: process.env.QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE,",
				"  executionBoundary: process.env.QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY,",
				"  serviceKey: process.env.QORPERA_SUPABASE_SERVICE_KEY,",
				"}));",
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf-8",
		);
		await writeFile(nativeProviderMasterKeyFile, `${"b".repeat(43)}\n`, { mode: 0o600 });
		const requests: Array<{ url: string; body?: unknown; headers: Headers }> = [];
		const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({
				url,
				headers: new Headers(init?.headers),
				...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
			});
			if (url.includes("/rest/v1/rpc/qorpera_provision_execution_runner")) {
				return new Response(
					JSON.stringify({
						runner_id: runnerId,
						runner_kind: "qorpera_computer",
						status: "pending",
						provider_adapter: "process",
						compute_identity_id: work().computeIdentityId,
						logical_computer_id: null,
						worker_class: "managed_sandbox",
						template_key: "qorpera-member-linux",
						template_version: "v1",
						compute_policy_sha256: "f".repeat(64),
						capabilities: ["agent_turn"],
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
			if (url.endsWith("/v1/assignment")) return new Response('{"accepted":true}', { status: 202 });
			return new Response(null, { status: 404 });
		});
		const backend = new ProcessCloudRunnerProviderBackend(
			{
				adapterId: "process",
				supabaseUrl: "https://example.supabase.co",
				supabaseServiceKey: "sb_secret_private",
				supabasePublishableKey: "publishable-key",
				runnerModulePath: runnerModule,
				nativeProviderModulePath: nativeProviderModule,
				stateRoot: join(directory, "state"),
				temporaryRoot: join(directory, "temporary"),
				image: `registry.example/qorpera@sha256:${"a".repeat(64)}`,
				podmanPath: join(directory, "podman"),
				entrypoint: "/opt/qorpera/run-job",
				nativeProviderMasterKeyFile,
				nativeExecutionBoundary: "virtual_machine",
				codexPath: "codex",
				claudePath: "claude",
				platform: "linux",
				runnerVersion: "test",
			},
			fetchImplementation,
		);
		const request = work();
		const runner = await backend.acquire(runId, request, new AbortController().signal);
		expect(runner).toMatchObject({ runnerId, computeIdentityId: request.computeIdentityId });
		const provisioning = requests.find((entry) => entry.url.includes("qorpera_provision_execution_runner"));
		expect(provisioning?.headers.get("apikey")).toBe("sb_secret_private");
		expect(provisioning?.headers.get("authorization")).toBeNull();
		let nativeEnvironment:
			| { masterKey?: string; masterKeyFile?: string; executionBoundary?: string; serviceKey?: string }
			| undefined;
		for (let attempt = 0; attempt < 100 && !nativeEnvironment; attempt++) {
			try {
				nativeEnvironment = JSON.parse(
					await readFile(join(directory, "state", runId, "native-env.json"), "utf-8"),
				) as { masterKey?: string; masterKeyFile?: string; executionBoundary?: string; serviceKey?: string };
			} catch {
				await new Promise((resolveWait) => setTimeout(resolveWait, 5));
			}
		}
		// G2-5: no service key (toEqual leaves no room for one).
		expect(nativeEnvironment).toEqual({
			masterKeyFile: nativeProviderMasterKeyFile,
			executionBoundary: "virtual_machine",
		});
		const runnerConfig = JSON.parse(
			await readFile(join(directory, "state", runId, "runner-config.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(runnerConfig.native_bridge_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(runnerConfig.native_bridge_boundary).toBe("virtual_machine");
		expect(await readFile(join(directory, "state", runId, "credentials", "qorpera-native-bridge"), "utf-8")).toMatch(
			/^[A-Za-z0-9_-]{43}\n$/,
		);
		const delivery: CloudRunnerAssignmentDelivery = {
			assignment: {
				assignmentId: "10000000-0000-4000-8000-000000000015",
				claimId: "10000000-0000-4000-8000-000000000016",
				runId,
				jobId: request.jobId,
				runnerId,
				capabilitySha256: "c".repeat(64),
				expiresAt: "2099-08-21T18:00:00.000Z",
			},
			capability: "d".repeat(43),
			work: request,
		};
		await backend.deliver(runner, delivery);
		expect(requests.find((entry) => entry.url.endsWith("/v1/assignment"))?.body).toMatchObject({
			assignment_id: delivery.assignment.assignmentId,
			job_id: request.jobId,
		});
		await backend.stop(runner, "idle");
	});
});
