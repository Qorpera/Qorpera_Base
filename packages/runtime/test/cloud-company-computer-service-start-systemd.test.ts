import { describe, expect, it } from "vitest";
import { parseCompanyComputerServiceSystemdState } from "../src/cloud-company-computer-service-start-systemd.ts";

const initial = {
	Id: "qorpera-company-computer.service",
	LoadState: "loaded",
	ActiveState: "inactive",
	SubState: "dead",
	MainPID: "0",
	ControlPID: "0",
	Job: "",
	FragmentPath: "/etc/systemd/system/qorpera-company-computer.service",
	DropInPaths: "",
	NeedDaemonReload: "no",
	Type: "exec",
	RemainAfterExit: "no",
	InvocationID: "",
	Result: "success",
	ExecMainCode: "0",
	ExecMainStatus: "0",
	ControlGroup: "",
	NRestarts: "0",
	Restart: "on-failure",
	User: "qorpera-office",
	Group: "qorpera-office",
};
const encode = (value: Record<string, string>) =>
	Object.entries(value)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
describe("fixed ordinary systemd inspection", () => {
	it("reads actual idle and running identity without treating running as SQL activation", () => {
		expect(parseCompanyComputerServiceSystemdState(encode(initial))).toEqual({
			invocationId: "",
			activeState: "inactive",
			subState: "dead",
			mainPid: 0,
			controlPid: 0,
			jobId: 0,
			result: "success",
			execMainCode: 0,
			execMainStatus: 0,
			controlGroup: "",
			restarts: 0,
		});
		expect(
			parseCompanyComputerServiceSystemdState(
				encode({
					...initial,
					InvocationID: "a".repeat(32),
					ActiveState: "active",
					SubState: "running",
					MainPID: "42",
					ControlGroup: "/system.slice/qorpera-company-computer.service",
				}),
			),
		).toMatchObject({ invocationId: "a".repeat(32), mainPid: 42, activeState: "active" });
	});
	it.each([
		{ Id: "other.service" },
		{ LoadState: "not-found" },
		{ FragmentPath: "/tmp/unit" },
		{ DropInPaths: "/override" },
		{ NeedDaemonReload: "yes" },
		{ Type: "simple" },
		{ RemainAfterExit: "yes" },
		{ Restart: "always" },
		{ User: "root" },
		{ Group: "root" },
		{ InvocationID: "0".repeat(32) },
		{ InvocationID: "A".repeat(32) },
		{ MainPID: "01" },
		{ MainPID: "2147483648" },
		{ ControlPID: "-1" },
		{ Job: "unsafe" },
		{ NRestarts: "01" },
		{ ExecMainCode: "7" },
		{ ExecMainStatus: "256" },
		{ ControlGroup: "/other" },
		{ SubState: "running\0" },
	])("refuses changed or malformed manager fields %j", (change) => {
		expect(() => parseCompanyComputerServiceSystemdState(encode({ ...initial, ...change }))).toThrow();
	});
	it("retains queued jobs, restarts and failed state for the start controller to refuse", () => {
		expect(
			parseCompanyComputerServiceSystemdState(
				encode({
					...initial,
					Job: "10",
					NRestarts: "1",
					ActiveState: "failed",
					SubState: "failed",
					Result: "exit-code",
					ExecMainCode: "1",
					ExecMainStatus: "1",
				}),
			),
		).toMatchObject({ jobId: 10, restarts: 1, activeState: "failed", execMainStatus: 1 });
	});
	it.each(["missing", "extra", "duplicate", "large"])("refuses %s property output", (fault) => {
		let value = encode(initial);
		if (fault === "missing") value = value.replace("Job=\n", "");
		if (fault === "extra") value += "\nUnknown=1";
		if (fault === "duplicate") value += "\nType=exec";
		if (fault === "large") value += "x".repeat(16385);
		expect(() => parseCompanyComputerServiceSystemdState(value)).toThrow();
	});
});
