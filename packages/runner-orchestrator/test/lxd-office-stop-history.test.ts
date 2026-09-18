import { companyComputerStopHistoryDirectory, parseCompanyComputerStopHistoryManifest } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";

const bootId = "11111111-1111-4111-8111-111111111111",
	activationId = "22222222-2222-4222-8222-222222222222";
const fixture = () => ({
	schema: "qorpera.office-stop-history/v1",
	command: { commandId: "33333333-3333-4333-8333-333333333333", bootId, requestSha256: "a".repeat(64) },
	activationId,
	completionPath: "/run/qorpera-office-preparation/service-stop-completion.json",
	entries: [
		{ path: "/etc/qorpera-office/adoption.json", bytes: 12, mode: 0o444, sha256: "b".repeat(64) },
		{
			path: "/run/qorpera-office-preparation/service-stop-completion.json",
			bytes: 12,
			mode: 0o600,
			sha256: "c".repeat(64),
		},
	],
});
describe("portable root stop history", () => {
	it.each(["adoption.json", "configuration-claim.json", "configuration-completion.json", "credentials/config.json"])(
		"accepts current boot public %s while preserving wire bytes",
		(name) => {
			const input = fixture();
			input.entries[0].path = `/etc/qorpera-office/boots/${bootId.replaceAll("-", "")}/${name}`;
			expect(JSON.stringify(parseCompanyComputerStopHistoryManifest(input, bootId, activationId))).toBe(
				JSON.stringify(input),
			);
		},
	);
	it.each([
		"credentials/native",
		"credentials/registry",
		"credentials/tls-key.pem",
		"../adoption.json",
		"preparation.json",
	])("refuses non-public boot path %s", (name) => {
		const input = fixture();
		input.entries[0].path = `/etc/qorpera-office/boots/${bootId.replaceAll("-", "")}/${name}`;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow();
	});
	it("refuses a public receipt from a different boot", () => {
		const input = fixture();
		input.entries[0].path = `/etc/qorpera-office/boots/${activationId.replaceAll("-", "")}/adoption.json`;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow();
	});
	it("preserves existing wire key order and returns independent immutable metadata", () => {
		const input = fixture(),
			wire = JSON.stringify(input),
			parsed = parseCompanyComputerStopHistoryManifest(input, bootId, activationId);
		expect(JSON.stringify(parsed)).toBe(wire);
		input.entries[0].sha256 = "d".repeat(64);
		expect(parsed.entries[0].sha256).toBe("b".repeat(64));
		expect(Object.isFrozen(parsed.entries[0])).toBe(true);
		expect(Object.isFrozen(parsed.entries)).toBe(true);
		expect(Object.isFrozen(parsed.command)).toBe(true);
	});
	it.each(["../run", "", "11111111-1111-1111-1111-111111111111"])("rejects malformed directory identity %s", (id) => {
		expect(() => companyComputerStopHistoryDirectory(id, activationId)).toThrow();
		expect(() => parseCompanyComputerStopHistoryManifest(fixture(), bootId, id)).toThrow();
	});
	it.each([
		"traversal",
		"credential",
		"duplicate",
		"ordering",
		"missing-completion",
		"size",
		"count",
		"mode",
		"length",
		"hash",
		"prototype",
		"extra",
		"boot",
		"activation",
	])("refuses %s manifests", (fault) => {
		const input = fixture();
		if (fault === "traversal") input.entries[0].path = "/run/qorpera-office-preparation/../secret.json";
		if (fault === "credential") input.entries[0].path = "/etc/qorpera-office/credentials/tls-key.pem";
		if (fault === "duplicate") input.entries[1] = { ...input.entries[0] };
		if (fault === "ordering") input.entries.reverse();
		if (fault === "missing-completion")
			input.entries[1].path = "/run/qorpera-office-preparation/service-start-completion.json";
		if (fault === "size")
			input.entries = Array.from({ length: 70 }, (_, index) => ({
				...input.entries[0],
				path: `/run/qorpera-office-preparation/a${String(index).padStart(3, "0")}.json`,
				bytes: 65536,
			}));
		if (fault === "count") input.entries = Array.from({ length: 129 }, () => input.entries[0]);
		if (fault === "mode") input.entries[0].mode = 0o644;
		if (fault === "length") input.entries[0].bytes = 65537;
		if (fault === "hash") input.entries[0].sha256 = "x".repeat(64);
		if (fault === "prototype") Object.setPrototypeOf(input, { foreign: true });
		if (fault === "extra") Object.assign(input, { authority: true });
		if (fault === "boot") input.command.bootId = activationId;
		if (fault === "activation") input.activationId = bootId;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow(
			"INVALID_OFFICE_STOP_HISTORY_MANIFEST",
		);
	});
});
