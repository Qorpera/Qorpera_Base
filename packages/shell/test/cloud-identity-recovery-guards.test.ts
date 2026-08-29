import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecoveryPrivateKey, readRecoveryCredential } from "../src/cloud-identity-recovery-config.ts";
import { recoveryPublicKeyText } from "../src/cloud-identity-recovery-crypto.ts";
import { parseIdentityRecoveryRuntimeState } from "../src/cloud-identity-recovery-guest.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { SupabaseNativeProviderControlPlane } from "../src/cloud-native-provider-service.ts";

const signer = generateKeyPairSync("ed25519");
const wrapper = generateKeyPairSync("rsa", { modulusLength: 3072 });
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private recovery configuration", () => {
	it("accepts only canonical private keys with the required algorithms", () => {
		for (const [pair, algorithm] of [
			[signer, "ed25519"],
			[wrapper, "rsa"],
		] as const) {
			const encoded = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
			expect(recoveryPublicKeyText(parseRecoveryPrivateKey(encoded, algorithm))).toBe(
				recoveryPublicKeyText(pair.publicKey),
			);
			expect(() => parseRecoveryPrivateKey(`${encoded}=`, algorithm)).toThrow("encoding");
		}
		const weak = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(() =>
			parseRecoveryPrivateKey(weak.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"), "rsa"),
		).toThrow();
		expect(() =>
			parseRecoveryPrivateKey(
				signer.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
				"rsa",
			),
		).toThrow();
	});

	it("rejects public, oversized and symlinked credential files", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-recovery-credentials-"));
		roots.push(root);
		const filename = join(root, "qorpera-recovery-test");
		await writeFile(filename, "synthetic-private-value\n", { mode: 0o600 });
		expect(await readRecoveryCredential(root, "qorpera-recovery-test")).toBe("synthetic-private-value");
		await symlink(filename, join(root, "qorpera-recovery-link"));
		await expect(readRecoveryCredential(root, "qorpera-recovery-link")).rejects.toThrow();
		await chmod(filename, 0o644);
		await expect(readRecoveryCredential(root, "qorpera-recovery-test")).rejects.toThrow("unsafe");
		await chmod(filename, 0o600);
		await writeFile(filename, "x".repeat(16_385));
		await expect(readRecoveryCredential(root, "qorpera-recovery-test")).rejects.toThrow("unsafe");
		await expect(readRecoveryCredential("relative", "qorpera-recovery-test")).rejects.toThrow("path");
		await expect(readRecoveryCredential(root, "../qorpera-recovery-test")).rejects.toThrow("path");
	});

	it("pins HTTPS recovery configuration and rejects contradictory startup authority", () => {
		const state = {
			companyId: randomUUID(),
			computeIdentityId: randomUUID(),
			epoch: 0,
			blocked: false,
			policySha256: "a".repeat(64),
			keySha256: null,
			canInitialize: true,
			recoveryConfiguration: {
				authorityId: randomUUID(),
				serviceOrigin: "https://recovery.example.test",
				signingPublicKey: recoveryPublicKeyText(signer.publicKey),
				wrappingPublicKey: recoveryPublicKeyText(wrapper.publicKey),
			},
		};
		expect(parseIdentityRecoveryRuntimeState(state)).toEqual(state);
		for (const change of [{ blocked: true }, { epoch: 1 }, { keySha256: "b".repeat(64) }])
			expect(() => parseIdentityRecoveryRuntimeState({ ...state, ...change })).toThrow("Conflicting");
		expect(() => parseIdentityRecoveryRuntimeState({ ...state, allowOverride: true })).toThrow();
		for (const serviceOrigin of [
			"http://recovery.example.test",
			"https://recovery.example.test/path",
			"https://user:secret@recovery.example.test",
		])
			expect(() =>
				parseIdentityRecoveryRuntimeState({
					...state,
					recoveryConfiguration: { ...state.recoveryConfiguration, serviceOrigin },
				}),
			).toThrow("HTTPS");
	});
});

describe("native identity generation enforcement", () => {
	const request: NativeCompanyExecutionRequest = {
		runtime: "company-path-v1",
		authority: {
			leaseId: randomUUID(),
			runId: randomUUID(),
			credentialCapsuleId: randomUUID(),
			encryptedCapsuleReference: "native-capsule/fixture",
			attestationPolicySha256: "a".repeat(64),
			computeIdentityId: randomUUID(),
			runnerId: randomUUID(),
			assignmentId: randomUUID(),
			provider: "openai",
			nativeHarness: "codex-cli",
			model: "fixture",
			expiresAt: new Date().toISOString(),
		},
		job: {
			jobId: randomUUID(),
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: null,
		},
	};
	const pin = { computeIdentityId: request.authority.computeIdentityId, epoch: 3 };

	it("requires a matching trusted local generation before contacting authority", async () => {
		const fetcher = vi.fn(async () => Response.json({ compute_identity_epoch: 3 }));
		for (const identity of [undefined, { ...pin, computeIdentityId: randomUUID() }]) {
			const control = new SupabaseNativeProviderControlPlane(
				"https://project.test",
				"sb_secret_fixture",
				fetcher,
				identity,
			);
			await expect(control.validateExecution(request)).rejects.toThrow("no matching local identity generation");
		}
		expect(fetcher).not.toHaveBeenCalled();
		expect(
			() =>
				new SupabaseNativeProviderControlPlane("https://project.test", "sb_secret_fixture", fetcher, {
					...pin,
					epoch: -1,
				}),
		).toThrow();
		expect(
			() =>
				new SupabaseNativeProviderControlPlane("https://project.test", "sb_secret_fixture", fetcher, {
					...pin,
					computeIdentityId: "invalid",
				}),
		).toThrow();
	});

	it("rejects missing and stale server generations and accepts only the pinned generation", async () => {
		for (const epoch of [undefined, 0, 2, 4, "3"]) {
			const control = new SupabaseNativeProviderControlPlane(
				"https://project.test",
				"sb_secret_fixture",
				async () => Response.json({ compute_identity_epoch: epoch }),
				pin,
			);
			await expect(control.validateExecution(request)).rejects.toThrow("generation differs");
		}
		const mutablePin = { ...pin };
		const control = new SupabaseNativeProviderControlPlane(
			"https://project.test",
			"sb_secret_fixture",
			async () => Response.json({ compute_identity_epoch: 3 }),
			mutablePin,
		);
		mutablePin.epoch = 4;
		await expect(control.validateExecution(request)).resolves.toBeUndefined();
	});
});
