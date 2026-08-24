import { describe, expect, it } from "vitest";
import { systemdCredentialMetadataIsSafe } from "../src/cloud-native-provider-service-main.ts";

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
		expect(systemdCredentialMetadataIsSafe(credential(), serviceUid, "linux")).toBe(true);
		expect(systemdCredentialMetadataIsSafe(credential({ mode: 0o100600 }), serviceUid, "linux")).toBe(true);
	});

	it("accepts root-owned read-only credentials projected by systemd", () => {
		expect(systemdCredentialMetadataIsSafe(credential({ uid: 0, gid: 0, mode: 0o100440 }), serviceUid, "linux")).toBe(
			true,
		);
	});

	it("rejects writable, world-readable, foreign, oversized, and non-file credentials", () => {
		for (const metadata of [
			credential({ uid: 0, gid: 0, mode: 0o100640 }),
			credential({ uid: 0, gid: 0, mode: 0o100444 }),
			credential({ uid: 1234, gid: 1234 }),
			credential({ size: 8193 }),
			credential({ isFile: false }),
		]) {
			expect(systemdCredentialMetadataIsSafe(metadata, serviceUid, "linux")).toBe(false);
		}
	});
});
