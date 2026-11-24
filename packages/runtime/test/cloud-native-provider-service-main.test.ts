import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	nativeCompanyDataConfiguration,
	nativeCompanyRuntimeConfiguration,
	nativeFolderSearchConfiguration,
	nativeWarmIdleMs,
	runNativeProviderHostServiceMain,
} from "@qorpera/runtime/cloud-native-provider-service-main";
import { systemdCredentialMetadataIsSafe } from "@qorpera/runtime/systemd-credential";
import { describe, expect, it } from "vitest";

const serviceUid = 997;

function credential(
	overrides: Partial<Parameters<typeof systemdCredentialMetadataIsSafe>[0]> = {},
): Parameters<typeof systemdCredentialMetadataIsSafe>[0] {
	return {
		isFile: true,
		size: 42,
		uid: serviceUid,
		gid: serviceUid,
		mode: 0o100400,
		...overrides,
	};
}

describe("systemd credential metadata", () => {
	it("accepts service-owned private credentials", () => {
		expect(systemdCredentialMetadataIsSafe(credential(), serviceUid, 8192, "linux")).toBe(true);
		expect(systemdCredentialMetadataIsSafe(credential({ mode: 0o100600 }), serviceUid, 8192, "linux")).toBe(true);
	});

	it("accepts root-owned read-only credentials projected by systemd", () => {
		expect(
			systemdCredentialMetadataIsSafe(credential({ uid: 0, gid: 0, mode: 0o100440 }), serviceUid, 8192, "linux"),
		).toBe(true);
	});

	it("rejects writable, world-readable, foreign, oversized, and non-file credentials", () => {
		for (const metadata of [
			credential({ uid: 0, gid: 0, mode: 0o100640 }),
			credential({ uid: 0, gid: 0, mode: 0o100444 }),
			credential({ uid: 1234, gid: 1234 }),
			credential({ size: 8193 }),
			credential({ isFile: false }),
		]) {
			expect(systemdCredentialMetadataIsSafe(metadata, serviceUid, 8192, "linux")).toBe(false);
		}
	});
});

describe("native Company File runtime selection", () => {
	const configured = {
		QORPERA_NATIVE_RUNTIME: "company-path-v1",
		QORPERA_NATIVE_CODEX_FENCE_PATH: "/opt/qorpera/codex-fenced",
		QORPERA_NATIVE_CODEX_FENCE_SHA256: "a".repeat(64),
		QORPERA_NATIVE_OBJECT_GATEWAY_URL: "https://objects.example.test",
	};
	it("selects only a complete pinned cloud runtime configuration", () => {
		expect(nativeCompanyRuntimeConfiguration({})).toBeUndefined();
		expect(nativeCompanyRuntimeConfiguration(configured)).toEqual({
			command: [configured.QORPERA_NATIVE_CODEX_FENCE_PATH],
			binarySha256: configured.QORPERA_NATIVE_CODEX_FENCE_SHA256,
			objectGatewayUrl: configured.QORPERA_NATIVE_OBJECT_GATEWAY_URL,
			isolation: { entryPoint: "/opt/qorpera-runner/qorpera-native-isolation-child.mjs" },
			chatGptPlanAuth: "command",
		});
		// A ChatGPT plan run's token: Codex's token command by default, the environment as the fallback.
		expect(
			nativeCompanyRuntimeConfiguration({ ...configured, QORPERA_CHATGPT_PLAN_AUTH: "environment" })
				?.chatGptPlanAuth,
		).toBe("environment");
	});
	it("does not downgrade a misspelled or incomplete selection to legacy execution", () => {
		for (const patch of [
			{ QORPERA_NATIVE_RUNTIME: "company-path-v2" },
			{ QORPERA_NATIVE_RUNTIME: "" },
			{ QORPERA_NATIVE_CODEX_FENCE_PATH: "codex" },
			{ QORPERA_NATIVE_CODEX_FENCE_SHA256: "" },
			{ QORPERA_NATIVE_OBJECT_GATEWAY_URL: "http://objects.example.test" },
			{ QORPERA_NATIVE_OBJECT_GATEWAY_URL: "https://secret@objects.example.test" },
			{ QORPERA_NATIVE_OBJECT_GATEWAY_URL: "https://objects.example.test/another-route" },
			{ QORPERA_CHATGPT_PLAN_AUTH: "" },
			{ QORPERA_CHATGPT_PLAN_AUTH: "file" },
		])
			expect(() => nativeCompanyRuntimeConfiguration({ ...configured, ...patch })).toThrow();
	});
});

describe("native company data composition", () => {
	it("takes the data gateway's run door as an HTTPS origin with its CA file, with the governed runtime, or nothing", () => {
		expect(nativeCompanyDataConfiguration({ QORPERA_NATIVE_RUNTIME: "company-path-v1" })).toBeUndefined();
		const environment = {
			QORPERA_NATIVE_RUNTIME: "company-path-v1",
			QORPERA_COMPANY_DATA_URL: "https://192.0.2.10:28480",
			QORPERA_COMPANY_DATA_CA_FILE: "/etc/qorpera/company-data-ca.pem",
		};
		expect(nativeCompanyDataConfiguration(environment)).toEqual({
			url: "https://192.0.2.10:28480",
			caFile: "/etc/qorpera/company-data-ca.pem",
		});
		for (const bad of [
			{ ...environment, QORPERA_COMPANY_DATA_URL: "http://192.0.2.10:28480" },
			{ ...environment, QORPERA_COMPANY_DATA_URL: "https://192.0.2.10:28480/v1" },
			{ ...environment, QORPERA_COMPANY_DATA_URL: "" },
			{ ...environment, QORPERA_COMPANY_DATA_CA_FILE: undefined },
			{ ...environment, QORPERA_COMPANY_DATA_CA_FILE: "ca.pem" },
			{ ...environment, QORPERA_NATIVE_RUNTIME: undefined },
		])
			expect(() => nativeCompanyDataConfiguration(bad)).toThrow();
	});
});

describe("native folder search composition", () => {
	it("takes the slot's relay socket, with the governed runtime, or nothing", () => {
		expect(nativeFolderSearchConfiguration({})).toBeUndefined();
		const environment = {
			QORPERA_NATIVE_RUNTIME: "company-path-v1",
			QORPERA_FOLDER_SEARCH_SOCKET: "/run/qorpera-folder-relay/3.sock",
		};
		expect(nativeFolderSearchConfiguration(environment)).toEqual({ socketPath: "/run/qorpera-folder-relay/3.sock" });
		for (const bad of [
			{ ...environment, QORPERA_FOLDER_SEARCH_SOCKET: "/tmp/3.sock" },
			{ ...environment, QORPERA_FOLDER_SEARCH_SOCKET: "/run/qorpera-folder-relay/../x.sock" },
			{ ...environment, QORPERA_FOLDER_SEARCH_SOCKET: "" },
			{ ...environment, QORPERA_NATIVE_RUNTIME: undefined },
		])
			expect(() => nativeFolderSearchConfiguration(bad)).toThrow();
	});
});

describe("warm conversation window", () => {
	it("is off unless set, and bounded to the ratified five minutes", () => {
		expect(nativeWarmIdleMs(undefined)).toBeUndefined();
		expect(nativeWarmIdleMs("")).toBeUndefined();
		expect(nativeWarmIdleMs("300000")).toBe(300_000);
		for (const value of ["0", "-1", "1.5", "1e3", " 300000", "300001"])
			expect(() => nativeWarmIdleMs(value)).toThrow("QORPERA_NATIVE_WARM_IDLE_MS is invalid");
	});
});

describe("the native host's service key guard (G2-5)", () => {
	it("refuses to start with a service key in its environment or as a systemd credential", async () => {
		const base = { QORPERA_SUPABASE_URL: "https://project.supabase.test" };
		await expect(runNativeProviderHostServiceMain({ ...base, QORPERA_SUPABASE_SERVICE_KEY: "" })).rejects.toThrow(
			"A native host must hold no service key",
		);
		const credentials = await mkdtemp(join(tmpdir(), "qorpera-native-host-credentials-"));
		try {
			await writeFile(join(credentials, "qorpera-supabase-service-key"), "service-key\n", { mode: 0o600 });
			await expect(
				runNativeProviderHostServiceMain({ ...base, CREDENTIALS_DIRECTORY: credentials }),
			).rejects.toThrow("A native host must hold no service key");
			// Without it the host goes on to its own credentials (here: the empty directory has none).
			await rm(join(credentials, "qorpera-supabase-service-key"));
			await expect(
				runNativeProviderHostServiceMain({ ...base, CREDENTIALS_DIRECTORY: credentials }),
			).rejects.not.toThrow("A native host must hold no service key");
		} finally {
			await rm(credentials, { recursive: true, force: true });
		}
	});
});
