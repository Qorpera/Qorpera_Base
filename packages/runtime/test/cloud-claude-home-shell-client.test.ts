import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cloudClaudeHomeArgument, cloudClaudeRipgrepCommand } from "@qorpera/runtime/cloud-claude-home-shell-client";
import { describe, expect, it } from "vitest";

/** A readlink that answers for one descriptor path, as the box's /proc would. */
const pointing = (target: string) => (path: string) => {
	if (path !== "/proc/self/fd/7") throw new Error("ENOENT");
	return target;
};

it("hands the home every argument exactly, however it is quoted", () => {
	const args = ["--json", "-e", "it's", "a b", "$(touch /company/x)", "`id`", "'", "", "\\n", "--", "/company"];
	const command = cloudClaudeRipgrepCommand(args, (arg) => arg);
	expect(command.startsWith("exec rg '--json' '-e' 'it'\\''s' ")).toBe(true);
	// bash -c on the home runs it: the same words come out, none of them run.
	const printed = execFileSync("/bin/bash", ["-c", command.replace(/^exec rg /, "printf '%s\\0' ")]);
	expect(printed.toString().split("\0").slice(0, -1)).toEqual(args);
});

it("maps a descriptor of Claude Code's to the home's file only inside the home's three folders", () => {
	expect(cloudClaudeHomeArgument("/dev/fd/7", pointing("/company/tree/a.txt"))).toBe("/company/tree/a.txt");
	expect(cloudClaudeHomeArgument("/proc/self/fd/7", pointing("/var/lib/qorpera-agent/n.md"))).toBe(
		"/var/lib/qorpera-agent/n.md",
	);
	expect(cloudClaudeHomeArgument("/dev/fd/7", pointing("/tmp/claude-1/out"))).toBe("/tmp/claude-1/out");
	// The box's own files and /proc stay a descriptor path the home does not have.
	for (const target of [
		"/proc/42/environ",
		"/slot/config/.credentials.json",
		"/etc/hostname",
		"/opt/claude/claude",
		"/companyx/a.txt",
		"/company",
		"/company/a.txt (deleted)",
		"/company/../slot/config/.credentials.json",
		"pipe:[1234]",
		"socket:[99]",
	])
		expect(cloudClaudeHomeArgument("/dev/fd/7", pointing(target))).toBe("/dev/fd/7");
	expect(cloudClaudeHomeArgument("/dev/fd/8", pointing("/company/a.txt"))).toBe("/dev/fd/8");
	expect(cloudClaudeHomeArgument("/dev/fd/x", pointing("/company/a.txt"))).toBe("/dev/fd/x");
	// Any other argument is ripgrep's own and passes as it is (Claude Code's deny rules judge the paths it names).
	expect(cloudClaudeHomeArgument("/slot/config/.credentials.json", pointing("/company/a"))).toBe(
		"/slot/config/.credentials.json",
	);
	expect(
		cloudClaudeRipgrepCommand(["-n", "/dev/fd/7"], (arg) =>
			cloudClaudeHomeArgument(arg, pointing("/proc/1/environ")),
		),
	).toBe("exec rg '-n' '/dev/fd/7'");
});

describe.skipIf(process.platform !== "linux")("with real descriptors", () => {
	it("reads where an open descriptor leads, and leaves one whose file is gone", () => {
		const folder = mkdtempSync("/tmp/claude-bridge-");
		const file = join(folder, "a.txt");
		const fd = openSync(file, "w");
		const gone = openSync(join(folder, "b.txt"), "w");
		unlinkSync(join(folder, "b.txt"));
		try {
			expect(cloudClaudeHomeArgument(`/dev/fd/${fd}`)).toBe(file);
			expect(cloudClaudeHomeArgument(`/dev/fd/${gone}`)).toBe(`/dev/fd/${gone}`);
			const proc = openSync("/proc/self/status", "r");
			expect(cloudClaudeHomeArgument(`/dev/fd/${proc}`)).toBe(`/dev/fd/${proc}`);
			closeSync(proc);
		} finally {
			closeSync(fd);
			closeSync(gone);
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
