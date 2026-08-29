import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lxdNativeCompanyRuntimeFromEnvironment } from "../src/lxd-company-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function environment(): Promise<NodeJS.ProcessEnv> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-native-company-config-")));
	roots.push(root);
	const tokenFile = join(root, "object-token");
	const secretRuntimeTokenFile = join(root, "secret-runtime-token");
	const secretCaFile = join(root, "secret-ca.pem");
	const secretCa = await readFile(
		new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
		"utf-8",
	);
	await writeFile(tokenFile, `${"q".repeat(43)}\n`, { mode: 0o600 });
	await writeFile(secretRuntimeTokenFile, `${"s".repeat(43)}\n`, { mode: 0o600 });
	await writeFile(secretCaFile, secretCa, { mode: 0o600 });
	return {
		QORPERA_NATIVE_RUNTIME: "company-path-v1",
		QORPERA_NATIVE_CODEX_FENCE_PATH: "/opt/qorpera-harnesses/native-company/codex",
		QORPERA_NATIVE_CODEX_FENCE_SHA256: "a".repeat(64),
		QORPERA_NATIVE_OBJECT_GATEWAY_URL: "https://objects.example.test",
		QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE: tokenFile,
		QORPERA_LXD_COMPANY_NETWORK: "qorpera0",
		QORPERA_LXD_RECOVERY_VOLUME_PREFIX: "native-recovery-",
		QORPERA_LXD_RECOVERY_VOLUME_SIZE: "1GiB",
		QORPERA_CLOUD_SECRET_BROKER_URL: "https://secrets.example.test",
		QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE: secretRuntimeTokenFile,
		QORPERA_LXD_CLOUD_SECRET_CA_FILE: secretCaFile,
		QORPERA_LXD_CLOUD_SECRET_CA_SHA256: createHash("sha256").update(secretCa).digest("hex"),
	};
}

describe("explicit governed LXD runtime configuration", () => {
	it("requires a complete opt-in and loads a private token file", async () => {
		expect(lxdNativeCompanyRuntimeFromEnvironment({})).toBeUndefined();
		expect(() => lxdNativeCompanyRuntimeFromEnvironment({ QORPERA_NATIVE_CODEX_FENCE_PATH: "/opt/codex" })).toThrow(
			"requires QORPERA_NATIVE_RUNTIME",
		);
		const current = await environment();
		expect(lxdNativeCompanyRuntimeFromEnvironment(current)).toMatchObject({
			mode: "company-path-v1",
			objectGatewayToken: "q".repeat(43),
			recoveryVolumeSize: "1GiB",
			secretBroker: { origin: "https://secrets.example.test", runtimeToken: "s".repeat(43) },
		});
	});

	it.each(["http://objects.example.test", "https://secret@objects.example.test", "https://objects.example.test/api"])(
		"rejects an unsafe gateway origin %s",
		async (url) => {
			const current = await environment();
			current.QORPERA_NATIVE_OBJECT_GATEWAY_URL = url;
			expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow("HTTPS origin");
		},
	);

	it("rejects environment tokens, readable credential files, and symlinked credentials", async () => {
		const current = await environment();
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...current, QORPERA_NATIVE_OBJECT_GATEWAY_TOKEN: "q".repeat(43) }),
		).toThrow("private native object-token file");
		const tokenPath = current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE;
		if (!tokenPath) throw new Error("missing credential fixture");
		await chmod(tokenPath, 0o644);
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow("unsafe ownership, permissions, or size");
		await chmod(tokenPath, 0o600);
		await symlink(tokenPath, `${tokenPath}.link`);
		current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE = `${tokenPath}.link`;
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow("physical path");
	});

	it("requires a distinct physical runtime credential for the cloud secret broker", async () => {
		const current = await environment();
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({
				...current,
				QORPERA_CLOUD_SECRET_BROKER_TOKEN: "s".repeat(43),
			}),
		).toThrow("private cloud secret runtime-token file");
		delete current.QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE;
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow(
			"requires QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE",
		);
		const duplicate = await environment();
		const secretPath = duplicate.QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE;
		if (!secretPath) throw new Error("missing secret-runtime credential fixture");
		await writeFile(secretPath, `${"q".repeat(43)}\n`, { mode: 0o600 });
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(duplicate)).toThrow("configuration is invalid");
	});

	it("requires the exact physical cloud secret broker CA", async () => {
		const current = await environment();
		current.QORPERA_LXD_CLOUD_SECRET_CA_SHA256 = "0".repeat(64);
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow("does not match its pinned authority");
		delete current.QORPERA_LXD_CLOUD_SECRET_CA_FILE;
		expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow(
			"requires QORPERA_LXD_CLOUD_SECRET_CA_FILE",
		);
	});

	it("rejects unknown modes, malformed pins and noncanonical executable paths", async () => {
		const current = await environment();
		expect(() => lxdNativeCompanyRuntimeFromEnvironment({ ...current, QORPERA_NATIVE_RUNTIME: "automatic" })).toThrow(
			"mode is unsupported",
		);
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...current, QORPERA_NATIVE_CODEX_FENCE_SHA256: "latest" }),
		).toThrow("configuration is invalid");
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...current, QORPERA_NATIVE_CODEX_FENCE_PATH: "/opt/../tmp/codex" }),
		).toThrow("configuration is invalid");
	});

	it.each(["", "q".repeat(42), "q".repeat(44), "q".repeat(257), "\ufffd".repeat(43)])(
		"rejects malformed or oversized token-file contents (%#)",
		async (contents) => {
			const current = await environment();
			const tokenPath = current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE;
			if (!tokenPath) throw new Error("missing credential fixture");
			await writeFile(tokenPath, contents);
			expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow();
		},
	);
});
