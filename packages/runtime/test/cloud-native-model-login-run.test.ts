import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelLoginIssue, ModelLoginIssueRequest } from "@qorpera/runtime/cloud-model-login-vault";
import { type NativeCompanyExecutionRequest, NativeProviderHost } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const computeIdentityId = randomUUID();
const capsuleId = randomUUID();
const loginId = randomUUID();

function login(version: number, token: string): ModelLoginIssue {
	return {
		schema: "qorpera.model-login/v1",
		version,
		accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		authJson: `${JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: token, refresh_token: "" } })}\n`,
	};
}

function request(): NativeCompanyExecutionRequest {
	return {
		runtime: "company-path-v1",
		authority: {
			leaseId: randomUUID(),
			runId: randomUUID(),
			credentialCapsuleId: capsuleId,
			encryptedCapsuleReference: `model-login/${loginId}`,
			attestationPolicySha256: "a".repeat(64),
			computeIdentityId,
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			provider: "openai",
			nativeHarness: "codex-cli",
			model: "gpt-native",
			expiresAt: "2099-08-28T00:00:00Z",
		},
		job: {
			jobId: randomUUID(),
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: null,
		},
	};
}

async function fixture(options: {
	issue: (request: ModelLoginIssueRequest) => Promise<ModelLoginIssue>;
	harness?: (identityRoot: string) => Promise<void>;
	warmIdleMs?: number;
}) {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "qorpera-vault-run-"));
	roots.push(temporaryRoot);
	const capsules = { get: vi.fn(), put: vi.fn() };
	const issue = vi.fn(options.issue);
	const seenRoots: string[] = [];
	const validateExecution = vi.fn(async () => undefined);
	const host = new NativeProviderHost({
		controlPlane: {
			async describeLogin() {
				throw new Error("No login expected");
			},
			async completeLogin() {
				throw new Error("No login expected");
			},
			validateExecution,
			async sendMessage() {
				throw new Error("No public send expected");
			},
		},
		capsules,
		harness: {
			async beginLogin() {
				throw new Error("No login expected");
			},
			async execute() {
				throw new Error("Legacy execution forbidden");
			},
		},
		cloudRuntime: {
			async execute(_request: NativeCompanyExecutionRequest, identityRoot: string) {
				seenRoots.push(identityRoot);
				await options.harness?.(identityRoot);
				return { providerSessionId: "vault-run", delivery: { messageCount: 1, finalMessageId: randomUUID() } };
			},
			prepareSpare: vi.fn(),
			async disposeSpares() {},
		},
		modelLogins: { issue: (issueRequest, _signal) => issue(issueRequest) },
		modelLoginRecheckMs: 20,
		computeIdentityId,
		temporaryRoot,
		...(options.warmIdleMs === undefined ? {} : { warmIdleMs: options.warmIdleMs }),
	});
	return { host, capsules, issue, seenRoots, temporaryRoot, validateExecution };
}

async function accessToken(root: string): Promise<string> {
	return (JSON.parse(await readFile(join(root, "codex", "auth.json"), "utf8")) as { tokens: { access_token: string } })
		.tokens.access_token;
}

it("runs a vault login from the vault's copy, keeps it fresh, and saves nothing back", async () => {
	let version = 1;
	const seen: string[] = [];
	const f = await fixture({
		issue: async ({ knownVersion }) =>
			knownVersion === version
				? { ...login(version, `pass-${version}`), authJson: null }
				: login(version, `pass-${version}`),
		harness: async (root) => {
			seen.push(await accessToken(root));
			expect((await stat(join(root, "codex", "auth.json"))).mode & 0o777).toBe(0o600);
			expect((await stat(join(root, "codex"))).mode & 0o777).toBe(0o700);
			// The vault renews while the run goes on; the host swaps the file in place.
			version = 2;
			await vi.waitFor(async () => expect(await accessToken(root)).toBe("pass-2"), { timeout: 2000 });
			seen.push(await accessToken(root));
			expect((await readdir(join(root, "codex"))).sort()).toEqual(["auth.json"]);
		},
	});
	const run = request();
	await f.host.execute(run);
	expect(seen).toEqual(["pass-1", "pass-2"]);
	expect(f.issue.mock.calls[0]?.[0]).toEqual({
		binding: {
			leaseId: run.authority.leaseId,
			runId: run.authority.runId,
			jobId: run.job.jobId,
			runnerId: run.authority.runnerId,
			assignmentId: run.authority.assignmentId,
			credentialCapsuleId: capsuleId,
			computeIdentityId,
		},
		knownVersion: null,
	});
	expect(f.capsules.get).not.toHaveBeenCalled();
	expect(f.capsules.put).not.toHaveBeenCalled();
	// Authority checked at the start and again at the end.
	expect(f.validateExecution.mock.calls.length).toBeGreaterThanOrEqual(2);
	expect(await readdir(f.temporaryRoot)).toEqual([]);
});

it("keeps a warm root with its vault version and reuses it while the version holds", async () => {
	const f = await fixture({
		issue: async ({ knownVersion }) =>
			knownVersion === 1 ? { ...login(1, "pass-1"), authJson: null } : login(1, "pass-1"),
		warmIdleMs: 60_000,
	});
	await f.host.execute(request());
	await f.host.execute(request());
	expect(f.seenRoots[1]).toBe(f.seenRoots[0]);
	expect(f.issue.mock.calls[1]?.[0].knownVersion).toBe(1);
	expect(await accessToken(f.seenRoots[0] as string)).toBe("pass-1");
	await f.host.releaseWarm();
	expect(await readdir(f.temporaryRoot)).toEqual([]);
});

it("writes a newer pass into a warm root the vault renewed meanwhile", async () => {
	let version = 1;
	const f = await fixture({
		issue: async ({ knownVersion }) =>
			knownVersion === version
				? { ...login(version, `pass-${version}`), authJson: null }
				: login(version, `pass-${version}`),
		warmIdleMs: 60_000,
	});
	await f.host.execute(request());
	version = 2;
	const tokens: string[] = [];
	await f.host.execute(request());
	tokens.push(await accessToken(f.seenRoots[1] as string));
	expect(f.seenRoots[1]).toBe(f.seenRoots[0]);
	expect(tokens).toEqual(["pass-2"]);
	await f.host.releaseWarm();
});

it("fails a vault run without the vault or when the vault refuses, and keeps no root", async () => {
	const refused = await fixture({
		issue: async () => {
			throw new Error("Cloud secret broker refused the model login");
		},
	});
	await expect(refused.host.execute(request())).rejects.toThrow("credential-download");
	expect(await readdir(refused.temporaryRoot)).toEqual([]);
	expect(
		() =>
			new NativeProviderHost({
				controlPlane: {
					describeLogin: vi.fn(),
					completeLogin: vi.fn(),
					validateExecution: vi.fn(),
					sendMessage: vi.fn(),
				},
				capsules: { get: vi.fn(), put: vi.fn() },
				harness: { beginLogin: vi.fn(), execute: vi.fn() },
				computeIdentityId,
			}),
	).toThrow("capsule key or the login vault");
});

it("refuses a vault copy that carries a renewal token and starts no harness", async () => {
	const harness = vi.fn(async () => undefined);
	const f = await fixture({
		issue: async () => ({
			...login(1, "pass-1"),
			authJson: `${JSON.stringify({ tokens: { access_token: "pass-1", refresh_token: "renewal-secret" } })}\n`,
		}),
		harness,
	});
	await expect(f.host.execute(request())).rejects.toThrow();
	expect(harness).not.toHaveBeenCalled();
	expect(await readdir(f.temporaryRoot)).toEqual([]);
});

it("leaves the usage check of a vault login to the vault", async () => {
	const f = await fixture({ issue: async () => login(1, "pass-1") });
	const listAccountRefreshes = vi.fn(async () => [
		{
			connectionId: randomUUID(),
			connectionVersion: 1,
			capsuleId,
			encryptedCapsuleReference: `model-login/${loginId}`,
			nativeHarness: "codex-cli" as const,
		},
	]);
	const host = new NativeProviderHost({
		controlPlane: {
			describeLogin: vi.fn(),
			completeLogin: vi.fn(),
			validateExecution: vi.fn(),
			sendMessage: vi.fn(),
			listAccountRefreshes,
			recordAccountMetadata: vi.fn(),
		},
		capsules: f.capsules,
		harness: { beginLogin: vi.fn(), execute: vi.fn() },
		modelLogins: { issue: vi.fn() },
		computeIdentityId,
		temporaryRoot: f.temporaryRoot,
	});
	await host.refreshAccountMetadata();
	expect(listAccountRefreshes).toHaveBeenCalled();
	expect(f.capsules.get).not.toHaveBeenCalled();
});
