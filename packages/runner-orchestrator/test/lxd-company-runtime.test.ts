import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function officeEnvironment() {
	const current = await environment();
	const root = dirname(current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE!);
	const tokenPath = join(root, "office-token");
	const routePath = join(root, "offices.json");
	const route = {
		companyId: "20000000-0000-4000-8000-000000000004",
		environmentId: "20000000-0000-4000-8000-000000000005",
		url: "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
		tokenPath,
	};
	const document = { schema: "qorpera.lxd-native-office-routes/v1", offices: [route] };
	await writeFile(tokenPath, `${"o".repeat(43)}\n`, { mode: 0o600 });
	await writeFile(routePath, JSON.stringify(document), { mode: 0o600 });
	current.QORPERA_LXD_OFFICE_ROUTES_FILE = routePath;
	return { current, tokenPath, routePath, document };
}

describe("protected company-scoped native office routes", () => {
	it("loads only a complete opt-in with private separate credentials", async () => {
		const { current, document } = await officeEnvironment();
		expect(lxdNativeCompanyRuntimeFromEnvironment(current)?.offices).toEqual([
			{
				companyId: document.offices[0].companyId,
				environmentId: document.offices[0].environmentId,
				url: document.offices[0].url,
				token: "o".repeat(43),
			},
		]);
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({
				QORPERA_LXD_OFFICE_ROUTES_FILE: current.QORPERA_LXD_OFFICE_ROUTES_FILE,
			}),
		).toThrow("requires QORPERA_NATIVE_RUNTIME");
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...current, QORPERA_COMPANY_COMPUTER_TOKEN: "o".repeat(43) }),
		).toThrow("protected route and credential files");
	});

	it.each(["route-readable", "route-symlink", "token-readable", "token-symlink", "token-shared", "route-oversized"])(
		"refuses unsafe route material (%s)",
		async (kind) => {
			const { current, tokenPath, routePath } = await officeEnvironment();
			if (kind === "route-readable") await chmod(routePath, 0o644);
			if (kind === "route-symlink") {
				await symlink(routePath, `${routePath}.link`);
				current.QORPERA_LXD_OFFICE_ROUTES_FILE = `${routePath}.link`;
			}
			if (kind === "token-readable") await chmod(tokenPath, 0o644);
			if (kind === "token-symlink") {
				await rm(tokenPath);
				await symlink(current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE!, tokenPath);
			}
			if (kind === "token-shared") await writeFile(tokenPath, "q".repeat(43));
			if (kind === "route-oversized") await writeFile(routePath, " ".repeat(65537));
			expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow();
		},
	);

	it.each(["scope", "target", "token", "url", "company", "unknown-field", "unknown-document", "empty"])(
		"rejects ambiguous or malformed route authority (%s)",
		async (kind) => {
			const { current, routePath, document } = await officeEnvironment();
			const second = {
				...document.offices[0],
				companyId: "20000000-0000-4000-8000-000000000006",
				url: "https://office.example.test/office/20000000-0000-4000-8000-000000000098/native",
				tokenPath: `${document.offices[0].tokenPath}.second`,
			};
			await writeFile(second.tokenPath, "p".repeat(43), { mode: 0o600 });
			if (kind === "scope") second.companyId = document.offices[0].companyId;
			if (kind === "target") second.url = document.offices[0].url;
			if (kind === "token") second.tokenPath = document.offices[0].tokenPath;
			if (kind === "url") second.url += "?token=leak";
			if (kind === "company") second.companyId = "*";
			document.offices.push(second);
			const encoded = {
				...document,
				...(kind === "unknown-document" ? { token: "o".repeat(43) } : {}),
				offices:
					kind === "empty"
						? []
						: document.offices.map((route) => ({
								...route,
								...(kind === "unknown-field" ? { token: "o".repeat(43) } : {}),
							})),
			};
			await writeFile(routePath, JSON.stringify(encoded));
			expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow();
		},
	);
});

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

describe("coding command gateway (Order 9)", () => {
	async function codingEnvironment() {
		const current = await environment();
		const tokenFile = join(dirname(current.QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE!), "coding-command-token");
		await writeFile(tokenFile, `${"k".repeat(43)}\n`, { mode: 0o600 });
		current.QORPERA_CODING_COMMAND_URL = "https://coding.example.test:8789";
		current.QORPERA_LXD_CODING_COMMAND_TOKEN_FILE = tokenFile;
		return { current, tokenFile };
	}

	it("is absent unless the origin and the private token file are both configured", async () => {
		const current = await environment();
		expect(lxdNativeCompanyRuntimeFromEnvironment(current)?.codingCommand).toBeUndefined();
		const { current: configured } = await codingEnvironment();
		expect(lxdNativeCompanyRuntimeFromEnvironment(configured)?.codingCommand).toEqual({
			origin: "https://coding.example.test:8789",
			token: "k".repeat(43),
		});
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...configured, QORPERA_LXD_CODING_COMMAND_TOKEN_FILE: undefined }),
		).toThrow("together");
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...configured, QORPERA_CODING_COMMAND_URL: undefined }),
		).toThrow("together");
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({
				QORPERA_CODING_COMMAND_URL: configured.QORPERA_CODING_COMMAND_URL,
				QORPERA_LXD_CODING_COMMAND_TOKEN_FILE: configured.QORPERA_LXD_CODING_COMMAND_TOKEN_FILE,
			}),
		).toThrow("requires QORPERA_NATIVE_RUNTIME");
		expect(() =>
			lxdNativeCompanyRuntimeFromEnvironment({ ...configured, QORPERA_CODING_COMMAND_TOKEN: "k".repeat(43) }),
		).toThrow("protected credential file");
	});

	it.each(["http", "path", "query", "readable", "shared-object", "shared-secret", "short"])(
		"refuses an unsafe gateway or token (%s)",
		async (kind) => {
			const { current, tokenFile } = await codingEnvironment();
			if (kind === "http") current.QORPERA_CODING_COMMAND_URL = "http://coding.example.test:8789";
			if (kind === "path") current.QORPERA_CODING_COMMAND_URL = "https://coding.example.test/gateway";
			if (kind === "query") current.QORPERA_CODING_COMMAND_URL = "https://coding.example.test/?token=leak";
			if (kind === "readable") await chmod(tokenFile, 0o644);
			if (kind === "shared-object") await writeFile(tokenFile, `${"q".repeat(43)}\n`);
			if (kind === "shared-secret") await writeFile(tokenFile, `${"s".repeat(43)}\n`);
			if (kind === "short") await writeFile(tokenFile, "short\n");
			expect(() => lxdNativeCompanyRuntimeFromEnvironment(current)).toThrow();
		},
	);
});
