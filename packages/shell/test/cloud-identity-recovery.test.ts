import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudIdentityRecoveryAuthority,
	type IdentityRecoveryReceipt,
	type RecoveryBackupPlan,
	type RecoveryControl,
	type RecoveryControlOperation,
	type RecoveryObjectStore,
	SupabaseRecoveryControl,
} from "@qorpera/runtime/cloud-identity-recovery";
import {
	type RecoveryReleaseBinding,
	recoveryDigest,
	recoveryPossessionProof,
	recoveryPublicKeyDigest,
	recoveryPublicKeyText,
	wrapRecoveryKey,
} from "@qorpera/runtime/cloud-identity-recovery-crypto";
import {
	assertIdentityRecoveryMarker,
	backupNativeIdentityKey,
	HttpIdentityRecoveryGuestTransport,
	type IdentityRecoveryGuestTransport,
	type IdentityRecoveryRuntimeState,
	identityRecoveryEpochFilename,
	restoreNativeIdentityKey,
} from "@qorpera/runtime/cloud-identity-recovery-guest";
import { HttpIdentityRecoveryService } from "@qorpera/runtime/cloud-identity-recovery-service";
import { FileRecoveryObjectStore, SupabaseRecoveryObjectStore } from "@qorpera/runtime/cloud-identity-recovery-store";
import { openNativeCredentialCapsule, sealNativeCredentialCapsule } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, describe, expect, it, vi } from "vitest";

const wrapper = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 });
const signer = generateKeyPairSync("ed25519");
const roots: string[] = [];
const services: HttpIdentityRecoveryService[] = [];
const signal = new AbortController().signal;
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

class MemoryStore implements RecoveryObjectStore {
	readonly objects = new Map<string, Uint8Array>();
	reads = 0;
	writes = 0;
	failRead = false;
	failWrite = false;
	async get(address: string): Promise<Uint8Array | undefined> {
		this.reads++;
		if (this.failRead) throw new Error("Fixture storage unavailable");
		return this.objects.get(address)?.slice();
	}
	async put(address: string, bytes: Uint8Array): Promise<Uint8Array> {
		this.writes++;
		if (this.failWrite) throw new Error("Fixture storage unavailable");
		if (!this.objects.has(address)) this.objects.set(address, bytes.slice());
		return this.objects.get(address)!.slice();
	}
}

function fixture() {
	const key = randomBytes(32);
	const companyId = randomUUID();
	const identityId = randomUUID();
	const authorityId = randomUUID();
	const loginId = randomUUID();
	const recoveryId = randomUUID();
	const targetId = randomUUID();
	const targetCapability = randomBytes(32).toString("base64url");
	const loginCapability = randomBytes(32).toString("base64url");
	let plan: RecoveryBackupPlan = {
		binding: {
			companyId,
			computeIdentityId: identityId,
			authorityId,
			revision: 1,
			policySha256: "a".repeat(64),
			keySha256: recoveryDigest(key),
			wrappingKeySha256: recoveryPublicKeyDigest(wrapper.publicKey),
		},
		status: "prepared",
		objectSha256: null,
		objectBytes: null,
	};
	const journal = new MemoryStore();
	const nas = new MemoryStore();
	const supabase = new MemoryStore();
	let approved = false;
	let authorized = true;
	let source: "nas" | "supabase" = "nas";
	let binding: RecoveryReleaseBinding | undefined;
	let releaseSha: string | null = null;
	let releaseBytes: number | null = null;
	let proofSha: string | null = null;
	let receipt: IdentityRecoveryReceipt | undefined;
	let loseCommit = false;
	let loseCompletion = false;
	const calls: RecoveryControlOperation[] = [];
	const control: RecoveryControl = {
		async call(operation, args, requestSignal) {
			requestSignal.throwIfAborted();
			calls.push(operation);
			if (!authorized) throw new Error("Fixture current authority revoked");
			if (operation === "prepare_identity_key_backup" || operation === "complete_identity_key_backup") {
				if (
					args.p_login_id !== loginId ||
					args.p_login_capability_sha256 !== recoveryDigest(loginCapability) ||
					args.p_key_sha256 !== plan.binding.keySha256
				)
					throw new Error("Fixture login rejected");
				if (operation === "complete_identity_key_backup")
					plan = {
						...plan,
						status: "ready",
						objectSha256: String(args.p_object_sha256),
						objectBytes: Number(args.p_object_bytes),
					};
				return plan;
			}
			if (operation === "register_identity_recovery_target") return {};
			if (
				!approved ||
				args.p_recovery_id !== recoveryId ||
				args.p_target_capability_sha256 !== recoveryDigest(targetCapability)
			)
				throw new Error("Fixture recovery not approved");
			if (operation === "complete_identity_recovery") {
				if (args.p_release_sha256 !== releaseSha || (proofSha !== null && proofSha !== args.p_proof_sha256))
					throw new Error("Fixture completion rebound");
				proofSha = String(args.p_proof_sha256);
				receipt ??= {
					recoveryId,
					companyId,
					computeIdentityId: identityId,
					targetId,
					backupRevision: 1,
					storageSource: source,
					status: "completed",
					epoch: 1,
					notBefore: new Date(Date.now() - 1000).toISOString(),
					expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
					receiptId: randomUUID(),
				};
				if (loseCompletion) {
					loseCompletion = false;
					throw new Error("Fixture lost completion response");
				}
				return receipt;
			}
			if (receipt) return { status: "completed", receipt };
			if (operation === "identity_recovery_completion_authority")
				return { status: "released", backup: plan, storageSource: source, releaseSha256: releaseSha };
			const issuedAt = Date.now();
			binding ??= {
				key: plan.binding,
				recoveryId,
				targetId,
				epoch: 1,
				backupSha256: plan.objectSha256!,
				recipientKeySha256: recoveryPublicKeyDigest(recipient.publicKey),
				issuedAt: new Date(issuedAt).toISOString(),
				expiresAt: new Date(issuedAt + 60_000).toISOString(),
			};
			if (operation === "commit_identity_key_release") {
				if (releaseSha !== null && releaseSha !== args.p_release_sha256)
					throw new Error("Fixture competing release");
				releaseSha = String(args.p_release_sha256);
				releaseBytes = Number(args.p_release_bytes);
				if (loseCommit) {
					loseCommit = false;
					throw new Error("Fixture lost release response");
				}
				return { releaseSha256: releaseSha, releaseBytes };
			}
			return {
				status: releaseSha ? "released" : "approved",
				binding,
				backupBytes: plan.objectBytes,
				storageSource: source,
				recipientPublicKey: recoveryPublicKeyText(recipient.publicKey),
				releaseSha256: releaseSha,
				releaseBytes,
			};
		},
	};
	const createAuthority = (store: RecoveryObjectStore = journal) =>
		new CloudIdentityRecoveryAuthority({
			companyId,
			authorityId,
			wrapper: wrapper.privateKey,
			signer: signer.privateKey,
			control,
			journal: store,
			nas,
			supabase,
		});
	const authority = createAuthority();
	const backup = () =>
		authority.backup(
			{
				loginId,
				loginCapability,
				binding: plan.binding,
				wrappedKey: wrapRecoveryKey(key, plan.binding, wrapper.publicKey),
			},
			signal,
		);
	const transport: IdentityRecoveryGuestTransport = {
		async post(path, body, requestSignal) {
			if (path === "release") {
				const value = await authority.release(
					String(body.recoveryId),
					String(body.targetCapability),
					requestSignal,
				);
				return value instanceof Uint8Array
					? { release: Buffer.from(value).toString("base64url") }
					: { receipt: value };
			}
			if (path === "complete")
				return authority.complete(
					String(body.recoveryId),
					String(body.targetCapability),
					String(body.releaseSha256),
					String(body.proof),
					requestSignal,
				);
			throw new Error("Fixture transport supports restoration only");
		},
	};
	return {
		key,
		companyId,
		identityId,
		authorityId,
		loginId,
		loginCapability,
		recoveryId,
		targetId,
		targetCapability,
		journal,
		nas,
		supabase,
		control,
		calls,
		authority,
		createAuthority,
		backup,
		transport,
		plan: () => plan,
		receipt: () => receipt,
		approve: (selected: "nas" | "supabase" = "nas") => {
			approved = true;
			source = selected;
		},
		revoke: () => {
			authorized = false;
		},
		loseCommit: () => {
			loseCommit = true;
		},
		loseCompletion: () => {
			loseCompletion = true;
		},
	};
}

async function directory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-identity-recovery-"));
	roots.push(root);
	return root;
}

describe("cloud recovery coordinator", () => {
	it("requires two read-verified copies and reuses the exact staged envelope on retry", async () => {
		const f = fixture();
		f.supabase.failWrite = true;
		await expect(f.backup()).rejects.toThrow("unavailable");
		expect(f.plan().status).toBe("prepared");
		expect(f.calls).not.toContain("complete_identity_key_backup");
		const staged = [...f.journal.objects.values()][0];
		f.supabase.failWrite = false;
		await f.backup();
		expect(f.plan().objectSha256).toBe(recoveryDigest(staged!));
		expect([...f.nas.objects.values()][0]).toEqual([...f.supabase.objects.values()][0]);
		expect(Buffer.from(staged!).includes(f.key.toString("base64url"))).toBe(false);
	});

	it("does not release before approval or silently change the selected replica", async () => {
		const f = fixture();
		await f.backup();
		await expect(f.authority.release(f.recoveryId, f.targetCapability, signal)).rejects.toThrow("not approved");
		f.approve("nas");
		f.nas.failRead = true;
		const reads = f.supabase.reads;
		await expect(f.authority.release(f.recoveryId, f.targetCapability, signal)).rejects.toThrow("unavailable");
		expect(f.supabase.reads).toBe(reads);
		expect(f.calls).not.toContain("commit_identity_key_release");
	});

	it("rechecks current authority after reading the encrypted object", async () => {
		const f = fixture();
		await f.backup();
		f.approve();
		const get = f.nas.get.bind(f.nas);
		vi.spyOn(f.nas, "get").mockImplementation(async (address) => {
			const bytes = await get(address);
			f.revoke();
			return bytes;
		});
		await expect(f.authority.release(f.recoveryId, f.targetCapability, signal)).rejects.toThrow("revoked");
		expect(f.receipt()).toBeUndefined();
	});

	it("replays one committed release after a lost response and service restart", async () => {
		const f = fixture();
		const root = await directory();
		const authority = f.createAuthority(new FileRecoveryObjectStore(root));
		await f.backup();
		f.approve();
		f.loseCommit();
		await expect(authority.release(f.recoveryId, f.targetCapability, signal)).rejects.toThrow("lost release");
		const restarted = f.createAuthority(new FileRecoveryObjectStore(root));
		const replay = await restarted.release(f.recoveryId, f.targetCapability, signal);
		expect(replay).toBeInstanceOf(Uint8Array);
		expect(await restarted.release(f.recoveryId, f.targetCapability, signal)).toEqual(replay);
	});

	it("publishes one immutable release when two service processes race", async () => {
		const f = fixture();
		await f.backup();
		f.approve();
		const root = await directory();
		const processes = [0, 1].map(() => f.createAuthority(new FileRecoveryObjectStore(root)));
		const releases = await Promise.all(
			processes.map((authority) => authority.release(f.recoveryId, f.targetCapability, signal)),
		);
		expect(releases[0]).toBeInstanceOf(Uint8Array);
		expect(releases[0]).toEqual(releases[1]);
		expect(
			await f.createAuthority(new FileRecoveryObjectStore(root)).release(f.recoveryId, f.targetCapability, signal),
		).toEqual(releases[0]);
	});

	it("restores the existing capsule key, resumes a lost completion and never reruns work", async () => {
		const f = fixture();
		await f.backup();
		f.approve("supabase");
		f.loseCompletion();
		const root = await directory();
		const restoredDirectory = join(root, "identity");
		await mkdir(restoredDirectory, { mode: 0o700 });
		const options = {
			directory: restoredDirectory,
			companyId: f.companyId,
			computeIdentityId: f.identityId,
			authorityId: f.authorityId,
			recoveryId: f.recoveryId,
			targetId: f.targetId,
			epoch: 1,
			backupSha256: f.plan().objectSha256!,
			recipientKey: recipient.privateKey,
			signingKey: signer.publicKey,
			targetCapability: f.targetCapability,
			transport: f.transport,
			signal,
		};
		await expect(restoreNativeIdentityKey(options)).rejects.toThrow("lost completion");
		const receipt = await restoreNativeIdentityKey(options);
		expect(receipt).toEqual(f.receipt());
		expect(await restoreNativeIdentityKey(options)).toEqual(receipt);
		const master = (await readFile(join(restoredDirectory, "qorpera-native-provider-master-key"), "utf8")).trim();
		expect(master).toBe(f.key.toString("base64url"));
		const marker = JSON.parse(await readFile(join(restoredDirectory, identityRecoveryEpochFilename(1)), "utf8"));
		const state: IdentityRecoveryRuntimeState = {
			companyId: f.companyId,
			computeIdentityId: f.identityId,
			epoch: 1,
			keySha256: recoveryDigest(f.key),
			policySha256: "a".repeat(64),
			canInitialize: false,
			blocked: false,
			recoveryConfiguration: null,
		};
		expect(() => assertIdentityRecoveryMarker(marker, state)).not.toThrow();
		expect(() => assertIdentityRecoveryMarker(marker, { ...state, epoch: 2 })).toThrow("generation");
		const original = join(root, "original");
		const target = join(root, "target");
		await mkdir(join(original, "codex"), { recursive: true, mode: 0o700 });
		await mkdir(target, { mode: 0o700 });
		await writeFile(join(original, "codex/auth.json"), '{"syntheticCredential":true}', { mode: 0o600 });
		const capsuleId = randomUUID();
		const capsule = await sealNativeCredentialCapsule(original, f.key.toString("base64url"), capsuleId);
		await openNativeCredentialCapsule(capsule, target, master, capsuleId);
		expect(await readFile(join(target, "codex/auth.json"), "utf8")).toBe('{"syntheticCredential":true}');
		expect(f.calls.every((operation) => !operation.includes("run") && !operation.includes("send"))).toBe(true);
	});

	it("rejects a forged possession proof and preserves the pending fence", async () => {
		const f = fixture();
		await f.backup();
		f.approve();
		const release = (await f.authority.release(f.recoveryId, f.targetCapability, signal)) as Uint8Array;
		await expect(
			f.authority.complete(
				f.recoveryId,
				f.targetCapability,
				recoveryDigest(release),
				randomBytes(32).toString("base64url"),
				signal,
			),
		).rejects.toThrow("proof rejected");
		expect(f.receipt()).toBeUndefined();
		const receipt = await f.authority.complete(
			f.recoveryId,
			f.targetCapability,
			recoveryDigest(release),
			recoveryPossessionProof(f.key, f.recoveryId, recoveryDigest(release)).toString("base64url"),
			signal,
		);
		expect(await f.authority.release(f.recoveryId, f.targetCapability, signal)).toEqual(receipt);
	});

	it("rejects corrupt backup objects before generating a release", async () => {
		const f = fixture();
		await f.backup();
		f.approve();
		f.nas.objects.set(f.plan().objectSha256!, Buffer.from("tampered"));
		await expect(f.authority.release(f.recoveryId, f.targetCapability, signal)).rejects.toThrow("corrupt");
		expect(f.calls).not.toContain("commit_identity_key_release");
	});
});

describe("recovery transport and storage", () => {
	it("uses the separate operator capability and excludes browser-origin requests", async () => {
		const f = fixture();
		const service = new HttpIdentityRecoveryService(f.authority, "o".repeat(43));
		services.push(service);
		const url = await service.start();
		expect(
			(
				await fetch(`${url}/operator/target`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${url}/v1/backup`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: "https://attacker.test" },
					body: "{}",
				})
			).status,
		).toBe(400);
		const invalid = await fetch(`${url}/v1/backup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"secret":"do-not-reflect"}',
		});
		expect(await invalid.text()).not.toContain("do-not-reflect");
		expect(f.calls).toEqual([]);
	});

	it("connects native login backup through the real HTTP service without sending plaintext", async () => {
		const f = fixture();
		const service = new HttpIdentityRecoveryService(f.authority, "o".repeat(43));
		services.push(service);
		const url = await service.start();
		const requests: string[] = [];
		const transport = new HttpIdentityRecoveryGuestTransport("https://recovery.example.test", async (input, init) => {
			requests.push(String(init?.body));
			return fetch(new URL(new URL(String(input)).pathname, url), init);
		});
		await backupNativeIdentityKey({
			state: {
				companyId: f.companyId,
				computeIdentityId: f.identityId,
				epoch: 0,
				blocked: false,
				policySha256: "a".repeat(64),
				keySha256: null,
				canInitialize: true,
				recoveryConfiguration: {
					authorityId: f.authorityId,
					serviceOrigin: "https://recovery.example.test",
					signingPublicKey: recoveryPublicKeyText(signer.publicKey),
					wrappingPublicKey: recoveryPublicKeyText(wrapper.publicKey),
				},
			},
			masterKey: f.key.toString("base64url"),
			loginId: f.loginId,
			loginCapability: f.loginCapability,
			transport,
			signal,
		});
		expect(f.plan().status).toBe("ready");
		expect(requests.join("")).not.toContain(f.key.toString("base64url"));
	});

	it("retains immutable private objects and rejects symlinks or public directories", async () => {
		const root = await directory();
		const store = new FileRecoveryObjectStore(root);
		const address = "a".repeat(64);
		expect(await store.put(address, Buffer.from("original"), signal)).toEqual(Buffer.from("original"));
		expect(await store.put(address, Buffer.from("replacement"), signal)).toEqual(Buffer.from("original"));
		const path = join(root, "b".repeat(64));
		await symlink(join(root, address), path);
		await expect(store.get("b".repeat(64), signal)).rejects.toThrow();
		await chmod(root, 0o755);
		await expect(store.get(address, signal)).rejects.toThrow("private");
	});

	it("reconciles typed Storage conflicts without overwriting the immutable object", async () => {
		let stored: Buffer | undefined;
		let writes = 0;
		const store = new SupabaseRecoveryObjectStore(
			"https://project.test",
			"sb_secret_fixture",
			randomUUID(),
			async (_input, init) => {
				if (init?.method === "POST") {
					writes++;
					expect(new Headers(init.headers).get("x-upsert")).toBe("false");
					if (!Buffer.isBuffer(init.body)) throw new Error("Expected bounded byte upload");
					stored = Buffer.from(init.body);
					return Response.json(
						{ code: "ResourceAlreadyExists", error: "Duplicate", statusCode: "409" },
						{ status: 400 },
					);
				}
				return stored
					? new Response(stored)
					: Response.json({ code: "NoSuchKey", error: "not_found", statusCode: "404" }, { status: 400 });
			},
		);
		const address = "a".repeat(64);
		expect(Buffer.from(await store.put(address, Buffer.from("verified"), signal)).toString()).toBe("verified");
		expect(Buffer.from(await store.put(address, Buffer.from("conflicting"), signal)).toString()).toBe("verified");
		expect(writes).toBe(1);
	});

	it("never interprets write denial or an error message as a successful replica", async () => {
		for (const [status, body] of [
			[401, { code: "ResourceAlreadyExists" }],
			[403, { code: "ResourceAlreadyExists" }],
			[400, { code: "ResourceAlreadyExists", statusCode: "403" }],
			[400, { code: "AccessDenied", statusCode: "409" }],
			[400, { message: "Asset Already Exists" }],
		] as const) {
			let reads = 0;
			const store = new SupabaseRecoveryObjectStore(
				"https://project.test",
				"sb_secret_fixture",
				randomUUID(),
				async (_input, init) => {
					if (init?.method === "POST") return Response.json(body, { status });
					reads++;
					return new Response(null, { status: 404 });
				},
			);
			await expect(store.put("a".repeat(64), Buffer.from("candidate"), signal)).rejects.toThrow(
				`write rejected (${status})`,
			);
			expect(reads).toBe(1);
		}
	});

	it("keeps modern Supabase keys out of Authorization and bounds stalled reads", async () => {
		const requests: Headers[] = [];
		const control = new SupabaseRecoveryControl(
			"https://project.test",
			"sb_secret_fixture",
			randomUUID(),
			"s".repeat(43),
			async (_input, init) => {
				requests.push(new Headers(init?.headers));
				return Response.json({});
			},
		);
		await control.call("prepare_identity_key_backup", {}, signal);
		const store = new SupabaseRecoveryObjectStore(
			"https://project.test",
			"sb_secret_fixture",
			randomUUID(),
			async (_input, init) => {
				requests.push(new Headers(init?.headers));
				return new Response("test");
			},
		);
		await store.get("a".repeat(64), signal);
		for (const headers of requests) {
			expect(headers.get("apikey")).toBe("sb_secret_fixture");
			expect(headers.has("authorization")).toBe(false);
		}
		const stalled = new SupabaseRecoveryObjectStore(
			"https://project.test",
			"sb_secret_fixture",
			randomUUID(),
			async () => new Response(new ReadableStream({ start() {} })),
			20,
		);
		await expect(stalled.get("a".repeat(64), signal)).rejects.toThrow("deadline");
	});
});
