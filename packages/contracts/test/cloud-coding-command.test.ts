import { describe, expect, it } from "vitest";
import { parseCloudCodingCommandReceipt } from "../src/cloud-coding-command.ts";
import { parseCloudMachineCommandReceipt } from "../src/cloud-machine.ts";

const receipt = {
	schema: "qorpera.coding-command-result/v2",
	workerId: "12345678-1234-4234-8234-000000000001",
	commandId: "12345678-1234-4234-8234-000000000002",
	inputSha256: "a".repeat(64),
	state: "running",
	exitCode: null,
	output: "built\n",
	truncated: true,
	log: { offset: 0, nextOffset: 6, totalBytes: 9, limitBytes: 67108864, limitReached: false },
};
const machineReceipt = (patch: Record<string, unknown>) => {
	const { workerId, schema: _schema, ...rest } = { ...receipt, ...patch };
	return { ...rest, schema: "qorpera.machine-command-result/v1", machineId: workerId };
};

describe("coding command receipt", () => {
	it.each([
		{ state: "running", exitCode: null },
		{ state: "succeeded", exitCode: 0 },
		{ state: "failed", exitCode: 1 },
		{ state: "failed", exitCode: 255 },
		{ state: "cancelled", exitCode: null },
		{ state: "unconfirmed", exitCode: null },
		{ state: "machine_stopped", exitCode: null },
	])("reads state %j", (patch) => {
		expect(parseCloudCodingCommandReceipt({ ...receipt, ...patch })).toEqual({ ...receipt, ...patch });
	});

	it.each([
		{ state: "machine_stopped", exitCode: 0 },
		{ state: "machine_stopped", exitCode: 1 },
		{ state: "lost", exitCode: null },
		{ state: "stopped", exitCode: null },
	])("refuses state %j", (patch) => {
		expect(() => parseCloudCodingCommandReceipt({ ...receipt, ...patch })).toThrow("Invalid coding command result");
	});

	it("keeps a gap the machine's output ring left, with any state", () => {
		for (const state of ["running", "machine_stopped"]) {
			const gapped = { ...receipt, state, log: { ...receipt.log, gapBytes: 4096 } };
			const parsed = parseCloudCodingCommandReceipt(gapped);
			expect(parsed).toEqual(gapped);
			expect(Object.isFrozen(parsed.log)).toBe(true);
		}
		expect(parseCloudCodingCommandReceipt(receipt).log).not.toHaveProperty("gapBytes");
		expect(
			parseCloudCodingCommandReceipt({ ...receipt, log: { ...receipt.log, gapBytes: Number.MAX_SAFE_INTEGER } }).log
				.gapBytes,
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it.each([0, -1, 1.5, "4096", null, undefined, Number.MAX_SAFE_INTEGER + 1])("refuses gapBytes %j", (gapBytes) => {
		expect(() => parseCloudCodingCommandReceipt({ ...receipt, log: { ...receipt.log, gapBytes } })).toThrow(
			"Invalid coding command log",
		);
	});

	it("still refuses any other log key", () => {
		expect(() =>
			parseCloudCodingCommandReceipt({ ...receipt, log: { ...receipt.log, gapBytes: 1, droppedBytes: 1 } }),
		).toThrow("Invalid coding command log");
		expect(() => parseCloudCodingCommandReceipt({ ...receipt, log: { ...receipt.log, droppedBytes: 1 } })).toThrow(
			"Invalid coding command log",
		);
	});
});

describe("machine command receipt", () => {
	it("keeps its own states", () => {
		for (const state of ["running", "cancelled", "lost", "unconfirmed"])
			expect(parseCloudMachineCommandReceipt(machineReceipt({ state })).state).toBe(state);
	});

	it("refuses the coding session's machine_stopped and an output gap", () => {
		expect(() => parseCloudMachineCommandReceipt(machineReceipt({ state: "machine_stopped" }))).toThrow(
			"Invalid machine command result",
		);
		expect(() =>
			parseCloudMachineCommandReceipt(machineReceipt({ log: { ...receipt.log, gapBytes: 4096 } })),
		).toThrow("Invalid machine command result");
	});
});
