import type { CompanyComputerGuestCommands } from "@qorpera/runtime/cloud-company-computer-guest";
import { assertCompanyComputerGuestLayout } from "@qorpera/runtime/cloud-company-computer-layout";
import {
	assertCompanyComputerCommandLimits,
	assertCompanyComputerCommandProcess,
	CompanyComputerLinuxCommands,
} from "@qorpera/runtime/cloud-company-computer-linux-commands";
import { describe, expect, it, vi } from "vitest";
import { computerBinding } from "./fixtures/company-computer.ts";

const limits = { memoryBytes: 536870912, pids: 128, cpuQuota: 100000, cpuPeriod: 100000 };
const actual = { memory: "536870912\n", pids: "128\n", cpu: "100000 100000\n" };
const layout = {
	workbenchRoot: "/srv/workbench",
	desktopHome: "/srv/desktop",
	screenStateRoot: "/srv/screens",
	browserProfilesRoot: "/srv/profiles",
};
function fixture() {
	return {
		binding: computerBinding(),
		layout: { ...layout },
		limits: { ...limits },
		workbenchMount: { mountPoint: "/srv/workbench", root: "/", filesystem: "nfs4", source: "192.0.2.90:/workbench" },
		boundary: { assertReady: vi.fn(async () => undefined) },
		xSocket: "/run/office-x/X1",
		captureRoot: "/run/office-captures",
	};
}
function command(): Parameters<CompanyComputerGuestCommands["run"]>[0] {
	return {
		program: "/bin/bash",
		args: ["--noprofile", "--norc", "-c", "true"],
		environment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		workingDirectory: "/home/qorpera",
		timeoutMs: 5000,
		maxOutputBytes: 16384,
		signal: new AbortController().signal,
	};
}

describe("office command admission (Linux process behavior has a separate real probe)", () => {
	it("requires no privilege acquisition and an empty effective, permitted, ambient and bounding capability set", () => {
		const fields = {
			CapPrm: "0000000000000000",
			CapEff: "0000000000000000",
			CapBnd: "0000000000000000",
			CapAmb: "0000000000000000",
			NoNewPrivs: "1",
		};
		const status = (input: Record<string, string>) =>
			Object.entries(input)
				.map(([key, value]) => `${key}:\t${value}\n`)
				.join("");
		expect(() => assertCompanyComputerCommandProcess(status(fields))).not.toThrow();
		for (const [name] of Object.entries(fields)) {
			expect(() =>
				assertCompanyComputerCommandProcess(
					status({ ...fields, [name]: name === "NoNewPrivs" ? "0" : "0000000000000001" }),
				),
			).toThrow("OFFICE_PROCESS_PRIVILEGES_UNSAFE");
			expect(() =>
				assertCompanyComputerCommandProcess(`${status(fields)}${name}:\t${fields[name as keyof typeof fields]}\n`),
			).toThrow("OFFICE_PROCESS_PRIVILEGES_UNSAFE");
			const missing = { ...fields } as Record<string, string>;
			delete missing[name];
			expect(() => assertCompanyComputerCommandProcess(status(missing))).toThrow("OFFICE_PROCESS_PRIVILEGES_UNSAFE");
		}
	});
	it("accepts only finite kernel ceilings at or below the admitted allocation, comparing CPU ratios exactly", () => {
		expect(() => assertCompanyComputerCommandLimits(limits, actual)).not.toThrow();
		expect(() =>
			assertCompanyComputerCommandLimits(limits, { memory: "1024", pids: "4", cpu: "50000 100000" }),
		).not.toThrow();
		expect(() => assertCompanyComputerCommandLimits(limits, { ...actual, cpu: "50000 50000" })).not.toThrow();
		for (const changed of [
			{ memory: "max" },
			{ pids: "max" },
			{ cpu: "max 100000" },
			{ memory: "536870913" },
			{ pids: "129" },
			{ cpu: "100001 100000" },
			{ cpu: "50001 50000" },
			{ cpu: "1 0" },
			{ cpu: "1 100000 extra" },
			{ cpu: "1\t100000" },
			{ memory: "0" },
			{ pids: "-1" },
			{ pids: "1.5" },
		])
			expect(() => assertCompanyComputerCommandLimits(limits, { ...actual, ...changed })).toThrow(
				"OFFICE_COMMAND_LIMITS_UNAVAILABLE",
			);
	});
	it("rejects malformed admitted ceilings and closed configuration substitutions", () => {
		for (const changed of [
			{ pids: 0 },
			{ pids: 1.5 },
			{ cpuQuota: NaN },
			{ memoryBytes: Infinity },
			{ cpuPeriod: -1 },
		])
			expect(() => new CompanyComputerLinuxCommands({ ...fixture(), limits: { ...limits, ...changed } })).toThrow(
				"INVALID_OFFICE_COMMAND_LIMITS",
			);
		expect(
			() => new CompanyComputerLinuxCommands({ ...fixture(), limits: { ...limits, unknown: 1 } } as never),
		).toThrow("INVALID_OFFICE_COMMAND_LIMITS");
		expect(
			() =>
				new CompanyComputerLinuxCommands({
					...fixture(),
					workbenchMount: { ...fixture().workbenchMount, source: "" },
				}),
		).toThrow("INVALID_OFFICE_WORKBENCH_MOUNT");
		expect(
			() =>
				new CompanyComputerLinuxCommands({
					...fixture(),
					workbenchMount: { ...fixture().workbenchMount, credential: "fixture" },
				} as never),
		).toThrow("INVALID_OFFICE_WORKBENCH_MOUNT");
	});
	it("rejects aliasing, provider/canonical paths and renamed layout keys", () => {
		for (const workbenchRoot of [
			"/",
			"/srv//workbench",
			"/srv/../workbench",
			"/srv/workbench/",
			"/srv/live/files",
			"/srv/.codex",
			"/srv/work\tbench",
			"/srv/work\\bench",
		])
			expect(() => assertCompanyComputerGuestLayout({ ...layout, workbenchRoot })).toThrow("UNSAFE_COMPUTER_LAYOUT");
		expect(() => assertCompanyComputerGuestLayout({ ...layout, workbenchRoot: layout.desktopHome })).toThrow(
			"OVERLAPPING_COMPUTER_LAYOUT",
		);
		const { browserProfilesRoot, ...other } = layout;
		expect(() => assertCompanyComputerGuestLayout({ ...other, profiles: browserProfilesRoot } as never)).toThrow(
			"UNSAFE_COMPUTER_LAYOUT",
		);
		for (const xSocket of ["/srv/profiles/X1", "/srv", "relative", "/run/../socket", "/run/office\0X1"])
			expect(() => new CompanyComputerLinuxCommands({ ...fixture(), xSocket })).toThrow(
				"UNSAFE_OFFICE_CONTROL_PATH",
			);
	});
	it("rejects command/environment substitution and over-budget input before checking guest readiness", async () => {
		const options = fixture();
		const runner = new CompanyComputerLinuxCommands(options);
		try {
			for (const changed of [
				{ program: "/usr/bin/scrot" },
				{ program: "/usr/bin/bash" },
				{ args: ["has\0nul"] },
				{ args: Array.from({ length: 65 }, () => "arg") },
				{ args: ["x".repeat(20001)] },
				{ stdin: "x".repeat(16385) },
				{ workingDirectory: "/srv/profiles" },
				// A shell command never gets the screen's display, and xdotool only its own.
				{ environment: { ...command().environment, DISPLAY: ":1" } },
				{ program: "/usr/bin/xdotool", args: ["getdisplaygeometry"] },
				{
					program: "/usr/bin/xdotool",
					args: ["getdisplaygeometry"],
					environment: { ...command().environment, DISPLAY: ":2" },
				},
				{ environment: { ...command().environment, LD_PRELOAD: "fake.so" } },
				{ environment: { ...command().environment, PATH: "/srv/workbench" } },
				{ timeoutMs: 0 },
				{ timeoutMs: 15001 },
				{ maxOutputBytes: 16385 },
				{ maxOutputBytes: 0 },
			])
				await expect(runner.run({ ...command(), ...changed })).rejects.toThrow("INVALID_OFFICE_COMMAND");
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await runner.close();
		}
	});
	it("rejects a substituted screen and unbounded screenshot allocation before accessing the guest", async () => {
		const options = fixture();
		const runner = new CompanyComputerLinuxCommands(options);
		try {
			for (const changed of [{ display: ":2" }, { maxBytes: 32 }, { maxBytes: 16777217 }])
				await expect(
					runner.capturePng({
						display: ":1",
						maxBytes: 16777216,
						signal: new AbortController().signal,
						...changed,
					}),
				).rejects.toThrow("INVALID_OFFICE_CAPTURE");
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await runner.close();
		}
	});
});
