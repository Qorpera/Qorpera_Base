import {
	nativeCompanyComputerConfiguration,
	nativeCompanyRuntimeConfiguration,
	nativeRunBoxConfiguration,
	nativeWarmIdleMs,
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

describe("native Company Computer service composition", () => {
	const url = "https://office.example.test/office/00000000-0000-4000-8000-000000000003/native";
	it("selects the configured headless office endpoint only with the governed runtime", () => {
		expect(nativeCompanyComputerConfiguration({})).toBeUndefined();
		expect(
			nativeCompanyComputerConfiguration({
				QORPERA_NATIVE_RUNTIME: "company-path-v1",
				QORPERA_COMPANY_COMPUTER_URL: url,
			}),
		).toEqual({ url });
	});
	it("rejects partial selections, insecure endpoints and ambient transport credentials", () => {
		for (const environment of [
			{ QORPERA_COMPANY_COMPUTER_URL: url },
			{ QORPERA_NATIVE_RUNTIME: "company-path-v1", QORPERA_COMPANY_COMPUTER_URL: "" },
			{ QORPERA_NATIVE_RUNTIME: "company-path-v1", QORPERA_COMPANY_COMPUTER_URL: url.replace("https:", "http:") },
			{ QORPERA_NATIVE_RUNTIME: "company-path-v1", QORPERA_COMPANY_COMPUTER_URL: `${url}?token=secret` },
			{ QORPERA_COMPANY_COMPUTER_TOKEN: "A".repeat(43) },
		])
			expect(() => nativeCompanyComputerConfiguration(environment)).toThrow();
	});
});

describe("native run box composition", () => {
	it("takes the slot's two box sockets together, with the governed runtime, or nothing", () => {
		expect(nativeRunBoxConfiguration({})).toBeUndefined();
		const environment = {
			QORPERA_NATIVE_RUNTIME: "company-path-v1",
			QORPERA_RUN_BOX_SOCKET: "/run/qorpera-shared-box/3.sock",
			QORPERA_RUN_BOX_READS: "/run/qorpera-shared-box/3.reads",
		};
		expect(nativeRunBoxConfiguration(environment)).toEqual({
			socket: "/run/qorpera-shared-box/3.sock",
			reads: "/run/qorpera-shared-box/3.reads",
		});
		for (const bad of [
			{ ...environment, QORPERA_RUN_BOX_READS: undefined },
			{ ...environment, QORPERA_RUN_BOX_SOCKET: "/tmp/3.sock" },
			{ ...environment, QORPERA_RUN_BOX_READS: "/run/qorpera-shared-box/3.sock" },
			// Both sockets are one slot's.
			{ ...environment, QORPERA_RUN_BOX_READS: "/run/qorpera-shared-box/4.reads" },
			{ ...environment, QORPERA_NATIVE_RUNTIME: undefined },
		])
			expect(() => nativeRunBoxConfiguration(bad)).toThrow();
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
