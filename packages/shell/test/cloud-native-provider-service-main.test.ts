import { describe, expect, it } from "vitest";
import { nativeCompanyRuntimeConfiguration } from "../src/cloud-native-provider-service-main.ts";
import { systemdCredentialMetadataIsSafe } from "../src/systemd-credential.ts";

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
		});
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
		])
			expect(() => nativeCompanyRuntimeConfiguration({ ...configured, ...patch })).toThrow();
	});
});
