import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const credentialPaths = new Set(["codex/auth.json"]);

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-credential-custody-"));
	roots.push(root);
	const identity = join(root, "identity");
	await mkdir(join(identity, "codex"), { recursive: true, mode: 0o700 });
	const auth = join(identity, "codex", "auth.json");
	const external = join(root, "private-host-sentinel");
	await writeFile(auth, '{"access_token":"synthetic-original"}', { mode: 0o600 });
	await writeFile(external, "SYNTHETIC_HOST_SECRET_DO_NOT_SEAL", { mode: 0o600 });
	return { root, identity, auth, external };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("retains exact original credential paths and ignores compatibility aliases and transient files", async () => {
	const f = await fixture();
	await mkdir(join(f.identity, "home"));
	await symlink(join(f.identity, "codex"), join(f.identity, "home", ".codex"), "dir");
	const initial = await sealNativeCredentialCapsule(f.identity, key, capsuleId);
	const restored = join(f.root, "restored");
	await openNativeCredentialCapsule(initial, restored, key, capsuleId);
	expect(await readFile(join(restored, "codex", "auth.json"), "utf8")).toContain("synthetic-original");
	await expect(readFile(join(restored, "home", ".codex", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
	await writeFile(f.auth, '{"access_token":"synthetic-refreshed"}', { mode: 0o600 });
	await mkdir(join(f.identity, "codex", "sessions"));
	await writeFile(join(f.identity, "codex", "sessions", "private.jsonl"), "PRIVATE_REASONING");
	const refreshed = await sealNativeCredentialCapsule(f.identity, key, capsuleId, credentialPaths);
	const next = join(f.root, "next");
	await openNativeCredentialCapsule(refreshed, next, key, capsuleId);
	expect(await readFile(join(next, "codex", "auth.json"), "utf8")).toContain("synthetic-refreshed");
	await expect(readFile(join(next, "codex", "sessions", "private.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
	"missing-auth",
	"duplicate-auth",
	"invalid-path",
	"duplicate-ignored",
	"invalid-mode",
	"parent-before-file",
	"parent-after-file",
] as const)("does not accept an invalid archive while projecting auth-only credentials: %s", async (kind) => {
	const f = await fixture();
	const auth = { path: "codex/auth.json", mode: 0o600, data: Buffer.from("synthetic-auth").toString("base64") };
	const other = {
		path: "codex/config.toml",
		mode: 0o600,
		data: Buffer.from("synthetic-config").toString("base64"),
	};
	let files =
		kind === "missing-auth"
			? [other]
			: kind === "duplicate-auth"
				? [auth, auth]
				: kind === "duplicate-ignored"
					? [auth, other, other]
					: [auth, { ...other, ...(kind === "invalid-path" ? { path: "../escaped" } : { mode: -1 }) }];
	if (kind === "parent-before-file") files = [{ ...other, path: "codex" }, auth];
	if (kind === "parent-after-file") files = [auth, { ...other, path: "codex" }];
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), nonce);
	cipher.setAAD(Buffer.from(`qorpera.native-credential-capsule/v1:${capsuleId}`));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify({ schema: "qorpera.native-credential-capsule/v1", files })),
		cipher.final(),
	]);
	const archive = Buffer.concat([Buffer.from("QNC1"), nonce, cipher.getAuthTag(), ciphertext]);
	await expect(
		openNativeCredentialCapsule(archive, join(f.root, "projected"), key, capsuleId, credentialPaths),
	).rejects.toThrow(
		kind === "missing-auth"
			? "Credential capsule is missing a required credential path"
			: "Credential capsule entry is invalid",
	);
	await expect(readFile(join(f.root, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("rejects hard-linked credential files (refresh=%s)", async (refresh) => {
	const f = await fixture();
	await rm(f.auth);
	await link(f.external, f.auth);
	await expect(
		sealNativeCredentialCapsule(f.identity, key, capsuleId, refresh ? credentialPaths : undefined),
	).rejects.toThrow("Credential capsule file is unsafe or changed");
	expect(await readFile(f.external, "utf8")).toBe("SYNTHETIC_HOST_SECRET_DO_NOT_SEAL");
});

it.each(["missing", "symlink", "parent-symlink"])("rejects an incomplete credential refresh: %s", async (kind) => {
	const f = await fixture();
	if (kind === "parent-symlink") {
		await rm(join(f.identity, "codex"), { recursive: true });
		const other = join(f.root, "other");
		await mkdir(other);
		await writeFile(join(other, "auth.json"), "SYNTHETIC_HOST_SECRET_DO_NOT_SEAL", { mode: 0o600 });
		await symlink(other, join(f.identity, "codex"), "dir");
	} else {
		await rm(f.auth);
		if (kind === "symlink") await symlink(f.external, f.auth);
	}
	await expect(sealNativeCredentialCapsule(f.identity, key, capsuleId, credentialPaths)).rejects.toThrow(
		"Credential capsule lost an original credential path",
	);
});

it("does not follow a symbolic identity root", async () => {
	const f = await fixture();
	const alias = join(f.root, "alias");
	await symlink(f.identity, alias, "dir");
	await expect(sealNativeCredentialCapsule(alias, key, capsuleId)).rejects.toThrow(
		"Credential capsule directory is unsafe",
	);
});

it("checks the file byte budget before allocating its contents", async () => {
	const f = await fixture();
	const file = await open(f.auth, "r+");
	try {
		await file.truncate(64 * 1024 * 1024 + 1);
	} finally {
		await file.close();
	}
	await expect(sealNativeCredentialCapsule(f.identity, key, capsuleId, credentialPaths)).rejects.toThrow(
		"Credential capsule exceeds its storage budget",
	);
});

it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
	const f = await fixture();
	await rm(f.auth);
	execFileSync("mkfifo", [f.auth], { timeout: 5000 });
	await expect(sealNativeCredentialCapsule(f.identity, key, capsuleId, credentialPaths)).rejects.toThrow(
		"Credential capsule contains an unsupported entry",
	);
});

it.each(["hardlink", "symlink", "missing"])(
	"keeps the prior sealed capsule when a governed harness leaves %s",
	async (kind) => {
		const f = await fixture();
		const original = await sealNativeCredentialCapsule(f.identity, key, capsuleId);
		const computeIdentityId = randomUUID();
		const put = vi.fn(async () => {});
		const execute = vi.fn(async (_request: NativeCompanyExecutionRequest, identityRoot: string) => {
			const auth = join(identityRoot, "codex", "auth.json");
			await rm(auth);
			if (kind === "hardlink") await link(f.external, auth);
			if (kind === "symlink") await symlink(f.external, auth);
			return { providerSessionId: "custody-fixture", delivery: { messageCount: 0, finalMessageId: null } };
		});
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
			capsules: { get: async () => original, put },
			harness: {
				async beginLogin() {
					throw new Error("No login expected");
				},
			},
			cloudRuntime: { execute },
			masterKey: key,
			computeIdentityId,
			temporaryRoot: f.root,
		});
		const request: NativeCompanyExecutionRequest = {
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
		await expect(host.execute(request)).rejects.toThrow(
			`credential-sealing stage failed (${kind === "hardlink" ? "unsafe-file" : "missing-credential"})`,
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(put).not.toHaveBeenCalled();
		const restored = join(f.root, "stored-still-original");
		await openNativeCredentialCapsule(original, restored, key, capsuleId);
		expect(await readFile(join(restored, "codex", "auth.json"), "utf8")).toContain("synthetic-original");
		expect(await readFile(f.external, "utf8")).toBe("SYNTHETIC_HOST_SECRET_DO_NOT_SEAL");
	},
);
