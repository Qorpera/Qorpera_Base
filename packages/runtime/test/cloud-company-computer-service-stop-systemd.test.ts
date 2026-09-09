import { describe, expect, it } from "vitest";
import {
	assertCompanyComputerServiceStopped,
	parseCompanyComputerCgroupEvents,
} from "../src/cloud-company-computer-service-stop-systemd.ts";

const stopped = {
	service: {
		invocationId: "a".repeat(32),
		activeState: "inactive",
		subState: "dead",
		result: "success",
		mainPid: 0,
		controlPid: 0,
		jobId: 0,
		execMainCode: 1,
		execMainStatus: 0,
		controlGroup: "",
		restarts: 0,
	},
	cgroupState: "absent" as const,
};
describe("whole ordinary-service stop observation", () => {
	it("requires the descendant population event, even with no main PID", () => {
		expect(parseCompanyComputerCgroupEvents("populated 0\nfrozen 0\n")).toBe("empty");
		expect(parseCompanyComputerCgroupEvents("populated 1\nfrozen 0\n")).toBe("populated");
		expect(() => assertCompanyComputerServiceStopped({ ...stopped, cgroupState: "populated" })).toThrow(
			"NOT_STOPPED",
		);
		expect(() => assertCompanyComputerServiceStopped(stopped)).not.toThrow();
		expect(() =>
			assertCompanyComputerServiceStopped({
				...stopped,
				service: { ...stopped.service, activeState: "failed", subState: "failed" },
				cgroupState: "empty",
			}),
		).not.toThrow();
	});
	it.each([
		"",
		"populated 0\n",
		"frozen 0\n",
		"populated 2\nfrozen 0\n",
		"populated 0\nfrozen 2\n",
		"populated 0\npopulated 0\nfrozen 0\n",
		"populated 00\nfrozen 0\n",
		"populated 0\nfrozen 0",
		"populated 0\nfrozen 0\n\0",
		"x".repeat(4097),
	])("refuses incomplete or ambiguous events %j", (value) =>
		expect(() => parseCompanyComputerCgroupEvents(value)).toThrow("UNCONFIRMED"),
	);
	it.each([
		{ mainPid: 1 },
		{ controlPid: 2 },
		{ jobId: 3 },
		{ activeState: "active", subState: "running" },
		{ activeState: "activating", subState: "auto-restart" },
		{ activeState: "deactivating", subState: "stop-sigterm" },
		{ activeState: "inactive", subState: "auto-restart" },
		{ activeState: "failed", subState: "dead" },
	])("refuses live or pending state %j", (change) =>
		expect(() =>
			assertCompanyComputerServiceStopped({ ...stopped, service: { ...stopped.service, ...change } }),
		).toThrow("NOT_STOPPED"),
	);
});
