import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	type NativeCredentialGeneration,
	NativeCredentialOwner,
	type NativeCredentialRefreshClaim,
	NativeCredentialUnavailableError,
} from "../src/cloud-native-credential-owner.ts";
import { NativeProcessSettlementError } from "../src/cloud-native-process-settlement.ts";
import {
	type NativeCompanyExecutionRequest,
	NativeProviderHost,
	openNativeCredentialCapsule,
	sealNativeCredentialCapsule,
} from "../src/cloud-native-provider-host.ts";
import { SupabaseNativeCredentialCapsuleStore } from "../src/cloud-native-provider-service.ts";
import { nativeCredentialGenerationConfiguration } from "../src/cloud-native-provider-service-main.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "credential-owner-test-"));
	roots.push(root);
	const enrollment = join(root, "enrollment");
	await mkdir(join(enrollment, "codex"), { recursive: true, mode: 0o700 });
	await writeFile(join(enrollment, "codex/auth.json"), '{"synthetic":"original"}', { mode: 0o600 });
	const key = randomBytes(32).toString("base64url");
	const id = randomUUID();
	const request: NativeCompanyExecutionRequest = {
		runtime: "company-path-v1",
		authority: {
			leaseId: randomUUID(),
			runId: randomUUID(),
			credentialCapsuleId: id,
			encryptedCapsuleReference: `native-capsule/${id}`,
			attestationPolicySha256: "a".repeat(64),
			computeIdentityId: randomUUID(),
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			provider: "openai",
			nativeHarness: "codex-cli",
			model: "gpt-native",
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
		job: {
			jobId: randomUUID(),
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: {},
		},
	};
	const objects = new Map<string, Uint8Array>([
		[request.authority.encryptedCapsuleReference, await sealNativeCredentialCapsule(enrollment, key, id)],
	]);
	let generation: NativeCredentialGeneration = {
		schema: "qorpera.native-credential-generation/v1",
		capsuleId: id,
		generation: 0,
		reference: request.authority.encryptedCapsuleReference,
		ciphertextSha256: null,
		state: "ready",
		ownerId: null,
	};
	let owner: NativeCredentialRefreshClaim | undefined;
	const control = {
		readCredentialGeneration: vi.fn(async () => structuredClone(generation)),
		claimCredentialRefresh: vi.fn(async (_request: unknown, claim: NativeCredentialRefreshClaim) => {
			if (generation.state !== "ready" || generation.generation !== claim.expectedGeneration)
				throw new Error("fenced");
			owner = claim;
			generation = { ...generation, state: "refreshing", ownerId: claim.ownerId };
			return structuredClone(generation);
		}),
		publishCredentialGeneration: vi.fn(
			async (_request: unknown, claim: NativeCredentialRefreshClaim, digest: string) => {
				if (owner?.ownerId !== claim.ownerId || owner.ownerTokenSha256 !== claim.ownerTokenSha256)
					throw new Error("fenced");
				generation = {
					...generation,
					state: "ready",
					ownerId: null,
					generation: claim.expectedGeneration + 1,
					reference: claim.candidateReference,
					ciphertextSha256: digest,
				};
				return structuredClone(generation);
			},
		),
		failCredentialRefresh: vi.fn(async () => undefined),
	};
	const store = {
		put: vi.fn(async (reference: string, bytes: Uint8Array) => {
			objects.set(reference, bytes);
		}),
		get: vi.fn(async (reference: string) => {
			const bytes = objects.get(reference);
			if (!bytes) throw new Error("absent");
			return bytes;
		}),
		putImmutable: vi.fn(async (reference: string, bytes: Uint8Array) => {
			const prior = objects.get(reference);
			if (prior && !Buffer.from(prior).equals(bytes)) throw new Error("immutable");
			objects.set(reference, bytes);
		}),
	};
	const makeOwner = () => new NativeCredentialOwner({ control, store, masterKey: key, temporaryRoot: root });
	const driver = { beginLogin: vi.fn(), execute: vi.fn() };
	const run = vi.fn(async (_request: NativeCompanyExecutionRequest, identityRoot: string) => {
		await writeFile(join(identityRoot, "codex/auth.json"), '{"synthetic":"rotated"}', { mode: 0o600 });
		return { providerSessionId: "thread-1", delivery: { messageCount: 0, finalMessageId: null } };
	});
	const host = new NativeProviderHost({
		controlPlane: {
			describeLogin: vi.fn(),
			completeLogin: vi.fn(),
			validateExecution: vi.fn(),
			sendMessage: vi.fn(),
		},
		capsules: store,
		harness: driver,
		cloudRuntime: { execute: run },
		credentialGenerations: makeOwner(),
		masterKey: key,
		computeIdentityId: request.authority.computeIdentityId,
		temporaryRoot: root,
	});
	return { root, key, id, request, control, store, objects, makeOwner, run, host, generation: () => generation };
}
it("publishes rotated auth through the actual host before returning and restores the newest generation", async () => {
	const f = await fixture();
	await f.host.execute(f.request);
	expect(f.generation().generation).toBe(1);
	expect(f.store.put).not.toHaveBeenCalled();
	f.run.mockImplementationOnce(async (_r, root) => {
		expect(await readFile(join(root, "codex/auth.json"), "utf8")).toContain("rotated");
		return { providerSessionId: "thread-2", delivery: { messageCount: 0, finalMessageId: null } };
	});
	await f.host.execute(f.request);
	expect(f.generation().generation).toBe(2);
});
it("blocks a concurrent same-capsule execution before giving another process refresh credentials", async () => {
	const f = await fixture();
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	f.run.mockImplementationOnce(async () => {
		started();
		await blocked;
		return { providerSessionId: "one", delivery: { messageCount: 0, finalMessageId: null } };
	});
	const first = f.host.execute(f.request);
	await ready;
	await expect(
		f.host.execute({ ...f.request, authority: { ...f.request.authority, leaseId: randomUUID() } }),
	).rejects.toMatchObject({ cause: expect.any(NativeCredentialUnavailableError) });
	expect(f.run).toHaveBeenCalledTimes(1);
	release();
	await first;
});
it("does not serialize independent capsules", async () => {
	const [a, b] = await Promise.all([fixture(), fixture()]);
	let entered = 0;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const run = async () => {
		if (++entered === 2) release();
		await gate;
		return { providerSessionId: "parallel", delivery: { messageCount: 0, finalMessageId: null } };
	};
	a.run.mockImplementationOnce(run);
	b.run.mockImplementationOnce(run);
	await Promise.all([a.host.execute(a.request), b.host.execute(b.request)]);
	expect(entered).toBe(2);
});
it("preserves rotated auth after a model failure", async () => {
	const f = await fixture();
	f.run.mockImplementationOnce(async (_r, root) => {
		await writeFile(join(root, "codex/auth.json"), '{"synthetic":"rotated-on-failure"}', { mode: 0o600 });
		throw new Error("synthetic failure");
	});
	await expect(f.host.execute(f.request)).rejects.toThrow();
	expect(f.generation().generation).toBe(1);
	const target = join(f.root, "readback");
	await mkdir(target);
	await openNativeCredentialCapsule(
		f.objects.get(f.generation().reference)!,
		target,
		f.key,
		f.id,
		new Set(["codex/auth.json"]),
		1,
	);
	expect(await readFile(join(target, "codex/auth.json"), "utf8")).toContain("rotated-on-failure");
});
it("reconciles a lost publication response without rerunning the official client", async () => {
	const f = await fixture();
	const publish = f.control.publishCredentialGeneration.getMockImplementation()!;
	f.control.publishCredentialGeneration.mockImplementationOnce(async (...args) => {
		await publish(...args);
		throw new Error("lost response");
	});
	await f.host.execute(f.request);
	expect(f.run).toHaveBeenCalledTimes(1);
	expect(f.generation().generation).toBe(1);
});
it("recovers an uploaded candidate after host loss without replaying its model execution", async () => {
	const f = await fixture();
	f.control.publishCredentialGeneration.mockRejectedValueOnce(new Error("transport"));
	await expect(f.host.execute(f.request)).rejects.toThrow("credential-publication");
	expect(f.generation().state).toBe("refreshing");
	const next = join(f.root, "next");
	await mkdir(next);
	const claim = await f.makeOwner().restore(f.request, next, AbortSignal.timeout(1000));
	expect(await readFile(join(next, "codex/auth.json"), "utf8")).toContain("rotated");
	expect(claim.expectedGeneration).toBe(1);
	expect(f.run).toHaveBeenCalledTimes(1);
});
it("never uses elapsed time to take over an owner whose candidate is absent", async () => {
	const f = await fixture();
	const first = join(f.root, "first");
	await mkdir(first);
	await f.makeOwner().restore(f.request, first, AbortSignal.timeout(1000));
	const next = join(f.root, "next");
	await mkdir(next);
	await expect(f.makeOwner().restore(f.request, next, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(
		NativeCredentialUnavailableError,
	);
	expect(f.control.claimCredentialRefresh).toHaveBeenCalledTimes(1);
	expect(f.run).not.toHaveBeenCalled();
});
it("binds encrypted capsules to their generation and rejects old-generation substitution", async () => {
	const f = await fixture();
	await f.host.execute(f.request);
	const target = join(f.root, "bad");
	await mkdir(target);
	await expect(
		openNativeCredentialCapsule(
			f.objects.get(f.generation().reference)!,
			target,
			f.key,
			f.id,
			new Set(["codex/auth.json"]),
			2,
		),
	).rejects.toThrow();
});
it("keeps unsupported external token activation closed", () => {
	expect(nativeCredentialGenerationConfiguration({})).toBe(false);
	expect(nativeCredentialGenerationConfiguration({ QORPERA_NATIVE_RUNTIME: "company-path-v1" })).toBe(true);
	expect(
		nativeCredentialGenerationConfiguration({
			QORPERA_NATIVE_RUNTIME: "company-path-v1",
			QORPERA_NATIVE_CREDENTIAL_MODE: "managed-generations-v1",
		}),
	).toBe(true);
	expect(() =>
		nativeCredentialGenerationConfiguration({
			QORPERA_NATIVE_RUNTIME: "company-path-v1",
			QORPERA_NATIVE_CREDENTIAL_MODE: "external-tokens",
		}),
	).toThrow("Unsupported");
});

it("saves a completed credential rotation when the caller cancels after the child settles", async () => {
	const f = await fixture();
	const abort = new AbortController();
	f.run.mockImplementationOnce(async (_request, root) => {
		await writeFile(join(root, "codex/auth.json"), '{"synthetic":"cancelled-rotation"}', { mode: 0o600 });
		abort.abort(new Error("cancelled"));
		throw new Error("child settled after cancellation");
	});
	await expect(f.host.execute(f.request, abort.signal)).rejects.toThrow();
	expect(f.generation().state).toBe("ready");
	expect(f.generation().generation).toBe(1);
});

it("an ambiguous ownership acknowledgement never starts the provider", async () => {
	const f = await fixture();
	const claim = f.control.claimCredentialRefresh.getMockImplementation()!;
	f.control.claimCredentialRefresh.mockImplementationOnce(async (...args) => {
		await claim(...args);
		throw new Error("reply lost");
	});
	await expect(f.host.execute(f.request)).rejects.toMatchObject({
		cause: expect.any(NativeCredentialUnavailableError),
	});
	expect(f.run).not.toHaveBeenCalled();
	expect(f.generation().state).toBe("refreshing");
	expect(f.store.putImmutable).not.toHaveBeenCalled();
});

it("immutable capsule storage uses create-only uploads and verifies conflict bytes", async () => {
	const bytes = Buffer.from("synthetic encrypted envelope");
	const transport = vi.fn<typeof fetch>(async (_url, init) =>
		init?.method === "POST" ? new Response(null, { status: 409 }) : new Response(bytes),
	);
	const store = new SupabaseNativeCredentialCapsuleStore(
		"https://project.example",
		"synthetic-service-key",
		transport,
	);
	const reference = `native-capsule/${randomUUID()}/generations/${randomUUID()}`;
	await store.putImmutable(reference, bytes);
	expect(new Headers(transport.mock.calls[0][1]?.headers).get("x-upsert")).toBe("false");
	expect(transport.mock.calls[0][1]?.redirect).toBe("error");
	await expect(store.put(reference, bytes)).rejects.toThrow("immutable");
});
it("immutable storage rejects a different object at the same reference", async () => {
	const transport = vi.fn<typeof fetch>(async (_url, init) =>
		init?.method === "POST" ? new Response(null, { status: 409 }) : new Response("different"),
	);
	const store = new SupabaseNativeCredentialCapsuleStore(
		"https://project.example",
		"synthetic-service-key",
		transport,
	);
	await expect(
		store.putImmutable(`native-capsule/${randomUUID()}/generations/${randomUUID()}`, Buffer.from("expected")),
	).rejects.toThrow("readback differs");
});

it.each([false, true])(
	"keeps ownership fenced and private credentials when settlement is unknown (aggregate=%s)",
	async (aggregate) => {
		const f = await fixture();
		let identityRoot = "";
		f.run.mockImplementationOnce(async (_request, root) => {
			identityRoot = root;
			throw aggregate
				? new AggregateError(
						[new Error("wrapped", { cause: new NativeProcessSettlementError() })],
						"cleanup failed",
					)
				: new NativeProcessSettlementError();
		});
		await expect(f.host.execute(f.request)).rejects.toThrow();
		expect(f.generation().state).toBe("refreshing");
		expect(f.store.putImmutable).not.toHaveBeenCalled();
		expect(await readFile(join(identityRoot, "codex/auth.json"), "utf8")).toContain("original");
	},
);

it("retains rotated auth and a protected owner locator when cloud publication cannot persist a candidate", async () => {
	const f = await fixture();
	let location = "";
	f.run.mockImplementationOnce(async (_request, root) => {
		location = root;
		await writeFile(join(root, "codex/auth.json"), '{"synthetic":"rotated-before-upload-failure"}', { mode: 0o600 });
		return { providerSessionId: "rotated", delivery: { messageCount: 0, finalMessageId: null } };
	});
	f.store.putImmutable.mockRejectedValueOnce(new Error("storage unavailable"));
	await expect(f.host.execute(f.request)).rejects.toThrow("credential-publication");
	expect(await readFile(join(location, "codex/auth.json"), "utf8")).toContain("rotated-before-upload-failure");
	const path = join(location, "qorpera-credential-owner.json");
	const info = await stat(path);
	expect(info.mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
		schema: "qorpera.native-credential-owner-location/v1",
		capsuleId: f.id,
		runId: f.request.authority.runId,
		ownerId: f.generation().ownerId,
		expectedGeneration: 0,
	});
	expect(f.generation().state).toBe("refreshing");
});
