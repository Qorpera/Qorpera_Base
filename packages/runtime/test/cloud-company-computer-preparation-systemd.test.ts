import { describe, expect, it } from "vitest";
import { parseCompanyComputerPreparationCommand } from "../src/cloud-company-computer-preparation-control.ts";
import { parseCompanyComputerPreparationSystemdState } from "../src/cloud-company-computer-preparation-systemd.ts";

const base = (name: string) => ({
	Id: name,
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	MainPID: "0",
	ControlPID: "0",
	Job: "",
	FragmentPath: `/etc/systemd/system/${name}`,
	DropInPaths: "",
	NeedDaemonReload: "no",
});
const ordinary = base("qorpera-company-computer.service");
const prep = {
	...base("qorpera-company-computer-preparation.service"),
	Type: "oneshot",
	RemainAfterExit: "yes",
	InvocationID: "",
	Result: "success",
	ExecMainCode: "0",
	ExecMainStatus: "0",
};
const encode = (value: Record<string, string>) =>
	`${Object.entries(value)
		.map(([key, v]) => `${key}=${v}`)
		.join("\n")}\n`;
describe("fixed preparation systemd readback", () => {
	it("parses a never-started unit and the exact stopped ordinary service", () => {
		expect(parseCompanyComputerPreparationSystemdState(encode(prep), encode(ordinary))).toEqual({
			invocationId: "",
			activeState: "inactive",
			subState: "dead",
			mainPid: 0,
			controlPid: 0,
			jobId: 0,
			result: "success",
			execMainCode: 0,
			execMainStatus: 0,
		});
	});
	it("retains actual completion fields for fresh invocation correlation", () => {
		expect(
			parseCompanyComputerPreparationSystemdState(
				encode({
					...prep,
					ActiveState: "active",
					SubState: "exited",
					InvocationID: "a".repeat(32),
					ExecMainCode: "1",
				}),
				encode(ordinary),
			),
		).toMatchObject({ invocationId: "a".repeat(32), activeState: "active", execMainCode: 1 });
	});
	it.each([
		{ Id: "other.service" },
		{ LoadState: "not-found" },
		{ FragmentPath: "/tmp/unit" },
		{ DropInPaths: "/etc/systemd/system/override.conf" },
		{ NeedDaemonReload: "yes" },
		{ Type: "simple" },
		{ RemainAfterExit: "no" },
		{ InvocationID: "0".repeat(32) },
		{ InvocationID: "A".repeat(32) },
		{ MainPID: "-1" },
		{ ControlPID: "01" },
		{ ExecMainCode: "7" },
		{ ExecMainStatus: "256" },
		{ Job: "unsafe" },
	])("refuses invalid unit settings %j", (changed) => {
		expect(() =>
			parseCompanyComputerPreparationSystemdState(encode({ ...prep, ...changed }), encode(ordinary)),
		).toThrow();
	});
	it.each([
		{ ActiveState: "active" },
		{ SubState: "running" },
		{ MainPID: "42" },
		{ ControlPID: "42" },
		{ Job: "10" },
		{ LoadState: "not-found" },
		{ DropInPaths: "/override" },
		{ NeedDaemonReload: "yes" },
	])("refuses an unconfirmed ordinary service %j", (changed) => {
		expect(() =>
			parseCompanyComputerPreparationSystemdState(encode(prep), encode({ ...ordinary, ...changed })),
		).toThrow();
	});
	it.each(["missing", "extra", "duplicate", "control", "oversized"])("refuses %s raw fields", (fault) => {
		let raw = encode(prep);
		if (fault === "missing") raw = raw.replace("Job=\n", "");
		if (fault === "extra") raw += "Unknown=yes\n";
		if (fault === "duplicate") raw += "Type=oneshot\n";
		if (fault === "control") raw += "\0";
		if (fault === "oversized") raw += "a".repeat(16385);
		expect(() => parseCompanyComputerPreparationSystemdState(raw, encode(ordinary))).toThrow();
	});
	it("does not treat a queued preparation job as completed", () => {
		expect(parseCompanyComputerPreparationSystemdState(encode({ ...prep, Job: "5" }), encode(ordinary)).jobId).toBe(
			5,
		);
	});
	it("accepts only the closed command and preserves immutable identity", () => {
		const command = {
			commandId: "11111111-1111-4111-8111-111111111111",
			bootId: "22222222-2222-4222-8222-222222222222",
			requestSha256: "a".repeat(64),
		};
		const parsed = parseCompanyComputerPreparationCommand(command);
		command.requestSha256 = "b".repeat(64);
		expect(parsed.requestSha256).toBe("a".repeat(64));
		expect(Object.isFrozen(parsed)).toBe(true);
		for (const invalid of [
			null,
			[],
			{ ...command, path: "/tmp/input" },
			{ ...command, commandId: "../command" },
			{ ...command, bootId: "" },
			{ ...command, requestSha256: "short" },
		])
			expect(() => parseCompanyComputerPreparationCommand(invalid)).toThrow("INVALID_OFFICE_PREPARATION_COMMAND");
	});
});
