import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type NativeCompanyExecutionRequest,
	NativeProviderHost,
	sealNativeCredentialCapsule,
} from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const key = randomBytes(32).toString("base64url");
const capsuleId = randomUUID();

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function files(root: string, directory = root): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await files(root, path)));
		else found.push(path.slice(root.length + 1));
	}
	return found.sort();
}

async function fixture(warmIdleMs?: number) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-warm-credential-"));
	roots.push(root);
	const identity = join(root, "identity");
	await mkdir(join(identity, "codex"), { recursive: true, mode: 0o700 });
	await writeFile(join(identity, "codex", "auth.json"), '{"access_token":"synthetic-original"}', { mode: 0o600 });
	const store = { bytes: await sealNativeCredentialCapsule(identity, key, capsuleId) };
	const computeIdentityId = randomUUID();
	const seenRoots: string[] = [];
	let fail = false;
	const execute = vi.fn(async (_request: NativeCompanyExecutionRequest, identityRoot: string) => {
		seenRoots.push(identityRoot);
		// A harness refreshes its token and leaves transient files behind.
		await writeFile(join(identityRoot, "codex", "auth.json"), `{"access_token":"refreshed-${seenRoots.length}"}`, {
			mode: 0o600,
		});
		await mkdir(join(identityRoot, "codex", "log"), { recursive: true });
		await writeFile(join(identityRoot, "codex", "log", "codex.log"), "transient");
		await writeFile(join(identityRoot, "scratch.tmp"), "transient");
		if (fail) throw new Error("Harness failed");
		return { providerSessionId: "warm-fixture", delivery: { messageCount: 1, finalMessageId: randomUUID() } };
	});
	const prepareSpare = vi.fn<(identityRoot: string, idleMs: number) => void>();
	const disposeSpares = vi.fn(async (_identityRoot: string) => undefined);
	const host = new NativeProviderHost({
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
		capsules: {
			get: async () => store.bytes,
			put: async (_reference, bytes) => {
				store.bytes = bytes;
			},
		},
		harness: {
			async beginLogin() {
				throw new Error("No login expected");
			},
			async execute() {
				throw new Error("Legacy execution forbidden");
			},
		},
		cloudRuntime: { execute, prepareSpare, disposeSpares },
		masterKey: key,
		computeIdentityId,
		temporaryRoot: root,
		...(warmIdleMs === undefined ? {} : { warmIdleMs }),
	});
	const request = (): NativeCompanyExecutionRequest => ({
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
	});
	return {
		host,
		store,
		identity,
		seenRoots,
		execute,
		prepareSpare,
		disposeSpares,
		request,
		fail: (value: boolean) => {
			fail = value;
		},
	};
}

it("keeps the opened capsule for the next run, pruned to its credential files", async () => {
	const f = await fixture(60_000);
	await f.host.execute(f.request());
	const [first] = f.seenRoots;
	expect(await files(first)).toEqual(["codex/auth.json"]);
	expect(f.prepareSpare).toHaveBeenCalledWith(first, 60_000);
	await f.host.execute(f.request());
	expect(f.seenRoots[1]).toBe(first);
	await f.host.releaseWarm();
	expect(await exists(first)).toBe(false);
	expect(f.disposeSpares).toHaveBeenCalledWith(first);
});

it("opens the stored capsule afresh when it is not the one this host uploaded", async () => {
	const f = await fixture(60_000);
	await f.host.execute(f.request());
	const [first] = f.seenRoots;
	// Another host (an account refresh, a new login) stored a newer capsule meanwhile.
	await writeFile(join(f.identity, "codex", "auth.json"), '{"access_token":"from-elsewhere"}', { mode: 0o600 });
	f.store.bytes = await sealNativeCredentialCapsule(f.identity, key, capsuleId);
	await f.host.execute(f.request());
	expect(f.seenRoots[1]).not.toBe(first);
	expect(await exists(first)).toBe(false);
	expect(f.disposeSpares).toHaveBeenCalledWith(first);
	await f.host.releaseWarm();
});

it("never keeps the root of a failed run", async () => {
	const f = await fixture(60_000);
	f.fail(true);
	await expect(f.host.execute(f.request())).rejects.toThrow();
	const [first] = f.seenRoots;
	expect(await exists(first)).toBe(false);
	expect(f.prepareSpare).not.toHaveBeenCalled();
	f.fail(false);
	await f.host.execute(f.request());
	expect(f.seenRoots[1]).not.toBe(first);
	await f.host.releaseWarm();
});

it("wipes a kept root when its window ends, and keeps none without a window", async () => {
	const f = await fixture(50);
	await f.host.execute(f.request());
	const [first] = f.seenRoots;
	expect(await exists(first)).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(await exists(first)).toBe(false);
	expect(f.disposeSpares).toHaveBeenCalledWith(first);
	const cold = await fixture();
	await cold.host.execute(cold.request());
	expect(await exists(cold.seenRoots[0])).toBe(false);
	expect(cold.prepareSpare).not.toHaveBeenCalled();
});
