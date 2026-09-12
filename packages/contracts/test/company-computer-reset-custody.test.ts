import { describe, expect, it } from "vitest";
import {
	parseCompanyComputerResetCustodyBinding,
	parseCompanyComputerResetOutboxManifest,
	parseCompanyComputerResetOutboxRestoreReceipt,
} from "../src/company-computer-reset-custody.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const binding = () => ({
	schema: "qorpera.office-reset-custody-binding/v1" as const,
	resetId: id(1),
	transitionId: id(2),
	predecessorActivationId: id(3),
	successorActivationId: id(4),
	rootIncarnationId: id(5),
	outboxUid: 1001,
	outboxGid: 1001,
	predecessor: {
		scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
		computerGeneration: 1,
		allocationId: id(10),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId: id(11),
		configurationSha256: "d".repeat(64),
		serviceInvocationId: "e".repeat(32),
	},
});
const manifest = () => ({
	schema: "qorpera.office-reset-outbox/v1",
	binding: binding(),
	files: [{ name: "scope.json", bytes: 300, sha256: "f".repeat(64), uid: 1001, gid: 1001, mode: 0o600 }],
	recordCount: 0,
	totalBytes: 300,
});
describe("reset outbox custody contract", () => {
	it("preserves exact predecessor identity and seals immutable parsed values", () => {
		const input = manifest(),
			parsed = parseCompanyComputerResetOutboxManifest(input, binding());
		expect(parsed.binding.predecessor).toEqual(input.binding.predecessor);
		expect(Object.isFrozen(parsed.files)).toBe(true);
		input.files[0].sha256 = "0".repeat(64);
		expect(parsed.files[0].sha256).toBe("f".repeat(64));
	});
	it("rejects broadened, aliased, rebound and invalid owner identities", () => {
		for (const change of [
			{ extra: true },
			{ successorActivationId: id(3) },
			{ resetId: id(11) },
			{ outboxUid: -1 },
			{ outboxGid: 1.5 },
		])
			expect(() => parseCompanyComputerResetCustodyBinding({ ...binding(), ...change })).toThrow();
		for (const change of [
			{ resetId: id(12) },
			{ outboxUid: 1002 },
			{ predecessor: { ...binding().predecessor, bootId: id(12) } },
		])
			expect(() =>
				parseCompanyComputerResetOutboxManifest({ ...manifest(), binding: { ...binding(), ...change } }, binding()),
			).toThrow();
	});
	it("accepts only sorted unique observation/scope filenames and exact bounded totals", () => {
		for (const name of [
			"credentials.json",
			"../scope.json",
			"/scope.json",
			".write-test",
			"scope.json/child",
			`${id(12)}-0000000000000000.json/extra`,
		])
			expect(() =>
				parseCompanyComputerResetOutboxManifest(
					{ ...manifest(), files: [{ ...manifest().files[0], name }] },
					binding(),
				),
			).toThrow();
		for (const field of [{ mode: 0o644 }, { bytes: 73730 }, { uid: 0 }, { sha256: "A".repeat(64) }, { extra: true }])
			expect(() =>
				parseCompanyComputerResetOutboxManifest(
					{ ...manifest(), files: [{ ...manifest().files[0], ...field }] },
					binding(),
				),
			).toThrow();
		expect(() =>
			parseCompanyComputerResetOutboxManifest(
				{ ...manifest(), files: [manifest().files[0], manifest().files[0]], recordCount: 1, totalBytes: 600 },
				binding(),
			),
		).toThrow();
		for (const change of [{ totalBytes: 299 }, { recordCount: 1 }, { files: [] }])
			expect(() => parseCompanyComputerResetOutboxManifest({ ...manifest(), ...change }, binding())).toThrow();
		const files = Array.from({ length: 1025 }, (_, n) => ({
			...manifest().files[0],
			name: `${id(n + 100)}-0000000000000001.json`,
			bytes: 65536,
		}));
		files.push(manifest().files[0]);
		expect(() =>
			parseCompanyComputerResetOutboxManifest(
				{ ...manifest(), files, recordCount: 1025, totalBytes: 1025 * 65536 + 300 },
				binding(),
			),
		).toThrow();
		for (const sequence of ["0000000000000000", "9007199254740992"]) {
			const files = [{ ...manifest().files[0], name: `${id(12)}-${sequence}.json` }, manifest().files[0]];
			expect(() =>
				parseCompanyComputerResetOutboxManifest(
					{ ...manifest(), files, recordCount: 1, totalBytes: 600 },
					binding(),
				),
			).toThrow();
		}
		const excessive = Array.from({ length: 8193 }, (_, n) => ({
			...manifest().files[0],
			name: `${id(n + 100)}-0000000000000001.json`,
			bytes: 1,
		}));
		excessive.push(manifest().files[0]);
		expect(() =>
			parseCompanyComputerResetOutboxManifest(
				{ ...manifest(), files: excessive, recordCount: 8193, totalBytes: 8493 },
				binding(),
			),
		).toThrow();
	});
	it("binds readback receipts to the exact sealed manifest and reset", () => {
		const m = parseCompanyComputerResetOutboxManifest(manifest(), binding()),
			sha = "f".repeat(64);
		const receipt = {
			schema: "qorpera.office-reset-outbox-restore/v1",
			state: "restored",
			binding: binding(),
			manifestSha256: sha,
			fileCount: 1,
			totalBytes: 300,
		};
		expect(parseCompanyComputerResetOutboxRestoreReceipt(receipt, m, sha).state).toBe("restored");
		for (const changed of [
			{ manifestSha256: "0".repeat(64) },
			{ fileCount: 2 },
			{ state: "active" },
			{ credentials: {} },
		])
			expect(() => parseCompanyComputerResetOutboxRestoreReceipt({ ...receipt, ...changed }, m, sha)).toThrow();
	});
});
