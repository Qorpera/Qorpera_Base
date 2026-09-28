import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type NativeCompanyExecutionRequest,
	NativeProviderHost,
	openNativeCredentialCapsule,
	sealNativeCredentialCapsule,
} from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const key = randomBytes(32).toString("base64url");
const capsuleId = randomUUID();
const computeIdentityId = randomUUID();

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporary(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

/** One stored capsule shared by every host, as the cloud bucket is. */
async function sharedStore(accessToken: string) {
	const identity = await temporary("qorpera-write-back-identity-");
	await mkdir(join(identity, "codex"), { recursive: true, mode: 0o700 });
	await writeFile(join(identity, "codex", "auth.json"), JSON.stringify({ access_token: accessToken }), {
		mode: 0o600,
	});
	const store = { bytes: await sealNativeCredentialCapsule(identity, key, capsuleId), puts: 0, gets: 0, failGetAt: 0 };
	return {
		store,
		capsules: {
			get: async () => {
				store.gets += 1;
				if (store.gets === store.failGetAt) throw new Error("Storage is briefly unavailable");
				return store.bytes;
			},
			put: async (_reference: string, bytes: Uint8Array) => {
				store.puts += 1;
				store.bytes = bytes;
			},
		},
		async storedAccessToken(): Promise<string> {
			const opened = await temporary("qorpera-write-back-read-");
			await openNativeCredentialCapsule(store.bytes, opened, key, capsuleId);
			return (JSON.parse(await readFile(join(opened, "codex", "auth.json"), "utf-8")) as { access_token: string })
				.access_token;
		},
	};
}

type Harness = (identityRoot: string) => Promise<void>;

async function host(
	capsules: { get: () => Promise<Uint8Array>; put: (r: string, b: Uint8Array) => Promise<void> },
	warmIdleMs?: number,
) {
	let harness: Harness = async () => undefined;
	const seenRoots: string[] = [];
	const prepareSpare = vi.fn<(identityRoot: string, idleMs: number) => void>();
	const temporaryRoot = await temporary("qorpera-write-back-host-");
	const nativeHost = new NativeProviderHost({
		controlPlane: {
			async describeLogin() {
				throw new Error("No login expected");
			},
			async completeLogin() {
				throw new Error("No login expected");
			},
			async validateExecution() {},
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
				// Every harness leaves transient files; they are never credentials.
				await mkdir(join(identityRoot, "codex", "log"), { recursive: true });
				await writeFile(join(identityRoot, "codex", "log", "codex.log"), "transient");
				await harness(identityRoot);
				return { providerSessionId: "write-back", delivery: { messageCount: 1, finalMessageId: randomUUID() } };
			},
			prepareSpare,
			async disposeSpares() {},
		},
		masterKey: key,
		computeIdentityId,
		temporaryRoot,
		...(warmIdleMs === undefined ? {} : { warmIdleMs }),
	});
	return {
		host: nativeHost,
		seenRoots,
		prepareSpare,
		setHarness(next: Harness) {
			harness = next;
		},
	};
}

function request(): NativeCompanyExecutionRequest {
	return {
		runtime: "company-path-v1",
		authority: {
			leaseId: randomUUID(),
			runId: randomUUID(),
			credentialCapsuleId: capsuleId,
			encryptedCapsuleReference: `native-capsule/${capsuleId}`,
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

async function renew(identityRoot: string, accessToken: string): Promise<void> {
	await writeFile(join(identityRoot, "codex", "auth.json"), JSON.stringify({ access_token: accessToken }), {
		mode: 0o600,
	});
}

it("saves nothing when the run did not change its login", async () => {
	const shared = await sharedStore("original");
	const before = shared.store.bytes;
	const h = await host(shared.capsules);
	await h.host.execute(request());
	expect(shared.store.puts).toBe(0);
	expect(shared.store.bytes).toBe(before);
	expect(await shared.storedAccessToken()).toBe("original");
});

it("saves a renewed login over the capsule the run opened", async () => {
	const shared = await sharedStore("original");
	const h = await host(shared.capsules);
	h.setHarness((root) => renew(root, "renewed"));
	await h.host.execute(request());
	expect(shared.store.puts).toBe(1);
	expect(await shared.storedAccessToken()).toBe("renewed");
});

it("keeps a login another run renewed while this run was still going", async () => {
	const shared = await sharedStore("original");
	const slow = await host(shared.capsules);
	const fast = await host(shared.capsules);
	let releaseSlow!: () => void;
	const slowMayFinish = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	let slowStarted!: () => void;
	const slowIsRunning = new Promise<void>((resolve) => {
		slowStarted = resolve;
	});
	slow.setHarness(async () => {
		slowStarted();
		await slowMayFinish;
	});
	fast.setHarness((root) => renew(root, "renewed-by-fast"));
	const slowRun = slow.host.execute(request());
	await slowIsRunning;
	await fast.host.execute(request());
	releaseSlow();
	await slowRun;
	// Before the fix the slow run resealed its old copy last and undid the renewal.
	expect(shared.store.puts).toBe(1);
	expect(await shared.storedAccessToken()).toBe("renewed-by-fast");
});

it("does not overwrite a newer stored login with its own renewal", async () => {
	const shared = await sharedStore("original");
	const late = await host(shared.capsules);
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	late.setHarness(async (root) => {
		// Another run saves a newer login while this run renews its own copy.
		const elsewhere = await temporary("qorpera-write-back-elsewhere-");
		await mkdir(join(elsewhere, "codex"), { recursive: true, mode: 0o700 });
		await renew(elsewhere, "renewed-elsewhere");
		shared.store.bytes = await sealNativeCredentialCapsule(elsewhere, key, capsuleId);
		await renew(root, "renewed-late");
	});
	await expect(late.host.execute(request())).resolves.toMatchObject({ provider_session_id: "write-back" });
	expect(shared.store.puts).toBe(0);
	expect(await shared.storedAccessToken()).toBe("renewed-elsewhere");
	expect(error).toHaveBeenCalledWith(expect.stringContaining("kept a newer stored login"));
	expect(JSON.stringify(error.mock.calls)).not.toContain("renewed-late");
});

it("keeps a warm root after an unchanged run and saves a later renewal from it", async () => {
	const shared = await sharedStore("original");
	const h = await host(shared.capsules, 60_000);
	await h.host.execute(request());
	await h.host.execute(request());
	expect(h.seenRoots[1]).toBe(h.seenRoots[0]);
	expect(shared.store.puts).toBe(0);
	h.setHarness((root) => renew(root, "renewed"));
	await h.host.execute(request());
	expect(h.seenRoots[2]).toBe(h.seenRoots[0]);
	expect(shared.store.puts).toBe(1);
	expect(await shared.storedAccessToken()).toBe("renewed");
	h.setHarness(async () => undefined);
	await h.host.execute(request());
	expect(h.seenRoots[3]).toBe(h.seenRoots[0]);
	await h.host.releaseWarm();
});

it("saves a renewal made in the kept root between two runs", async () => {
	const shared = await sharedStore("original");
	const h = await host(shared.capsules, 60_000);
	await h.host.execute(request());
	const [kept] = h.seenRoots;
	// The spare harness renews its login while the root waits for the next run.
	await renew(kept as string, "renewed-by-spare");
	await h.host.execute(request());
	expect(h.seenRoots[1]).toBe(kept);
	expect(shared.store.puts).toBe(1);
	expect(await shared.storedAccessToken()).toBe("renewed-by-spare");
	await h.host.releaseWarm();
});

it("does not keep a root warm after keeping a newer stored login", async () => {
	const shared = await sharedStore("original");
	const h = await host(shared.capsules, 60_000);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	h.setHarness(async (root) => {
		const elsewhere = await temporary("qorpera-write-back-elsewhere-");
		await mkdir(join(elsewhere, "codex"), { recursive: true, mode: 0o700 });
		await renew(elsewhere, "renewed-elsewhere");
		shared.store.bytes = await sealNativeCredentialCapsule(elsewhere, key, capsuleId);
		await renew(root, "renewed-here");
	});
	await h.host.execute(request());
	expect(h.prepareSpare).not.toHaveBeenCalled();
	await expect(access(h.seenRoots[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries one failed read of the stored login before saving a renewal", async () => {
	const shared = await sharedStore("original");
	// The first read opens the login; the second, the check before saving, fails once.
	shared.store.failGetAt = 2;
	const h = await host(shared.capsules);
	h.setHarness((root) => renew(root, "renewed"));
	await h.host.execute(request());
	expect(shared.store.puts).toBe(1);
	expect(await shared.storedAccessToken()).toBe("renewed");
});
