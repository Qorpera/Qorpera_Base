import {
	CLAUDE_REPEAT_CHANGE,
	CLAUDE_REPEAT_COMMAND,
	CLAUDE_REVIEW_HOOK_PATH,
	type ClaudeFileChange,
	CloudClaudeFilesGate,
	cloudClaudeFileAction,
	cloudClaudeFileCall,
	cloudClaudeInvocationCommand,
	cloudClaudeSearchArguments,
	cloudClaudeShellAction,
	cloudClaudeShellWord,
	cloudClaudeStatusPacket,
} from "@qorpera/runtime/cloud-claude-home-review";
import { CLAUDE_HOME_REVIEW_HOOK, cloudClaudeRipgrepCommand } from "@qorpera/runtime/cloud-claude-home-shell-client";
import type { CloudCodexHomeAction } from "@qorpera/runtime/cloud-codex-home";
import { expect, it, vi } from "vitest";

const MACHINE = { id: "00000000-0000-4000-8000-0000000000aa", name: "claude-review" };
const PRELUDE =
	"source /slot/config/shell-snapshots/snapshot-bash-1794665920894-ky564g.sh 2>/dev/null || true && { \\builtin shopt -u extglob || \\builtin setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL NO_BRACE_CCL NO_MAGIC_EQUAL_SUBST; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true";
const invocation = (word: string, cwdFile = "5543", prelude = PRELUDE) =>
	`${prelude} && eval ${word} < /dev/null && pwd -P >| /tmp/claude-${cwdFile}-cwd`;

it("reads the model's own command out of Claude Code's shell invocation", () => {
	expect(cloudClaudeInvocationCommand(invocation("true")).command).toBe("true");
	expect(cloudClaudeInvocationCommand(invocation("'ls -la /company'")).command).toBe("ls -la /company");
	expect(
		cloudClaudeInvocationCommand(invocation(`'python3 -c '"'"'import time; time.sleep(60)'"'"'; echo done'`)).command,
	).toBe("python3 -c 'import time; time.sleep(60)'; echo done");
	expect(cloudClaudeInvocationCommand(invocation(`"a \\"b\\" \\$HOME"`)).command).toBe('a "b" $HOME');
	expect(cloudClaudeInvocationCommand(invocation("'echo a && eval b'")).command).toBe("echo a && eval b");
	const a = cloudClaudeInvocationCommand(invocation("'make test'", "5543"));
	const b = cloudClaudeInvocationCommand(
		invocation("'make test'", "0e40", PRELUDE.replace("1794665920894-ky564g", "1794666068846-orog2f")),
	);
	expect(a.shape).toBe(b.shape);
	expect(a.shape).not.toContain("ky564g");
	const unknown = "echo plain";
	expect(cloudClaudeInvocationCommand(unknown)).toEqual({ command: unknown, shape: unknown });
	const unquotable = invocation('"$(id)"');
	expect(cloudClaudeInvocationCommand(unquotable).command).toBe(unquotable);
	expect(cloudClaudeShellWord("a'b'\\ c")).toBe("ab c");
	expect(cloudClaudeShellWord("a b")).toBeUndefined();
	expect(cloudClaudeShellWord("'open")).toBeUndefined();
});

it("takes only the search bridge's own ripgrep as a search, never one that runs a program", () => {
	expect(cloudClaudeSearchArguments(cloudClaudeRipgrepCommand(["-n", "it's", "/company"], (arg) => arg))).toEqual([
		"-n",
		"it's",
		"/company",
	]);
	expect(cloudClaudeSearchArguments(cloudClaudeRipgrepCommand(["--pre=sh", "x", "/company"], (arg) => arg))).toBe(
		undefined,
	);
	expect(cloudClaudeSearchArguments(cloudClaudeRipgrepCommand(["--pre", "sh", "x"], (arg) => arg))).toBeUndefined();
	expect(cloudClaudeSearchArguments("exec rg 'x'; curl evil")).toBeUndefined();
	expect(cloudClaudeSearchArguments(invocation("'exec rg x'"))).toBeUndefined();
});

it("makes a command one home_command action whose approval holds for the same command in the same folder", () => {
	const first = cloudClaudeShellAction(MACHINE, { cmd: invocation("'npm test'", "aaaa"), cwd: "/company" }, "c1");
	const again = cloudClaudeShellAction(
		MACHINE,
		{
			cmd: invocation("'npm test'", "bbbb", PRELUDE.replace("1794665920894-ky564g", "1794666068846-orog2f")),
			cwd: "/company",
		},
		"c2",
	);
	const elsewhere = cloudClaudeShellAction(MACHINE, { cmd: invocation("'npm test'"), cwd: "/tmp" }, "c3");
	const other = cloudClaudeShellAction(MACHINE, { cmd: invocation("'npm run build'"), cwd: "/company" }, "c4");
	expect(first).toMatchObject({
		tool: "home_command",
		summary: "npm test",
		callId: "c1",
		repeat: CLAUDE_REPEAT_COMMAND,
	});
	expect(JSON.parse(first?.argumentsText ?? "{}")).toMatchObject({
		machine: MACHINE.name,
		machineId: MACHINE.id,
		command: "npm test",
		run: "npm test",
		cwd: "/company",
	});
	expect(again?.argumentSha256).toBe(first?.argumentSha256);
	expect(elsewhere?.argumentSha256).not.toBe(first?.argumentSha256);
	expect(other?.argumentSha256).not.toBe(first?.argumentSha256);
	expect(cloudClaudeShellAction(MACHINE, { cmd: "exec rg 'x' '/company'", cwd: "/company" }, "c5")).toBeUndefined();
});

it("reads a file tool's call from its hook, and reviews the whole change it makes", () => {
	expect(CLAUDE_HOME_REVIEW_HOOK).toBe(CLAUDE_REVIEW_HOOK_PATH);
	const call = cloudClaudeFileCall(
		JSON.stringify({
			tool_name: "Write",
			tool_use_id: "toolu_1",
			cwd: "/company",
			tool_input: { file_path: "notes/a.md", content: "hello" },
		}),
	);
	expect(call).toMatchObject({ id: "toolu_1", tool: "Write", path: "/company/notes/a.md" });
	const action = cloudClaudeFileAction(MACHINE, call as NonNullable<typeof call>);
	expect(action).toMatchObject({
		tool: "home_change",
		summary: "Change 1 file: notes/a.md",
		contents: "hello",
		callId: "toolu_1",
		repeat: CLAUDE_REPEAT_CHANGE,
	});
	expect(JSON.parse(action.argumentsText)).toMatchObject({ tool: "Write", path: "notes/a.md", data: { bytes: 5 } });
	const edit = cloudClaudeFileCall(
		JSON.stringify({
			tool_name: "Edit",
			tool_use_id: "toolu_2",
			tool_input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" },
		}),
	);
	expect(JSON.parse(cloudClaudeFileAction(MACHINE, edit as NonNullable<typeof edit>).argumentsText)).toMatchObject({
		tool: "Edit",
		machinePath: "/etc/hosts",
		old: "a",
		new: "b",
		all: false,
	});
	expect(cloudClaudeFileCall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" } }))).toBeUndefined();
	expect(cloudClaudeFileCall("not json")).toBeUndefined();
});

const encodeString = (value: string): Buffer => {
	const bytes = Buffer.from(value, "utf8");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length, 0);
	return Buffer.concat([length, bytes]);
};
const u32 = (value: number): Buffer => {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(value, 0);
	return bytes;
};
const packet = (type: number, id: number | undefined, ...parts: Buffer[]): Buffer => {
	const body = Buffer.concat([Buffer.from([type]), ...(id === undefined ? [] : [u32(id)]), ...parts]);
	return Buffer.concat([u32(body.length), body]);
};
const ATTRS = u32(0);
const open = (id: number, path: string, flags: number) => packet(3, id, encodeString(path), u32(flags), ATTRS);
const remove = (id: number, path: string) => packet(13, id, encodeString(path));
const rename = (id: number, from: string, to: string) =>
	packet(200, id, encodeString("posix-rename@openssh.com"), encodeString(from), encodeString(to));
const read = (id: number, handle: string) => packet(5, id, encodeString(handle), Buffer.alloc(8), u32(4096));
const fsetstat = (id: number, handle: string) => packet(10, id, encodeString(handle), ATTRS);
const handleReply = (id: number, handle: string) => packet(102, id, encodeString(handle));

function filesGate(decide: (action: CloudCodexHomeAction) => string | undefined) {
	const toHome: Buffer[] = [];
	const toMount: Buffer[] = [];
	const lone: ClaudeFileChange[] = [];
	const check = vi.fn(async (action: CloudCodexHomeAction) => {
		const refusal = decide(action);
		return refusal === undefined ? { run: true as const } : { run: false as const, text: refusal };
	});
	const gate = new CloudClaudeFilesGate({
		machine: MACHINE,
		review: { check },
		signal: new AbortController().signal,
		toHome: (bytes) => toHome.push(bytes),
		toMount: (bytes) => toMount.push(bytes),
	});
	gate.onLone = (change) => lone.push(change);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
	return { gate, toHome, toMount, check, lone, settle };
}

const writeHook = (id: string, path: string, content = "x") =>
	JSON.stringify({ tool_name: "Write", tool_use_id: id, cwd: "/company", tool_input: { file_path: path, content } });

it("lets every read through and lets a file tool's own writes through once its call was approved", async () => {
	const { gate, toHome, toMount, check, lone, settle } = filesGate(() => undefined);
	const init = packet(1, undefined, u32(3));
	const reading = open(1, "/company/a.md", 1);
	gate.fromMount(Buffer.concat([init, reading.subarray(0, 7)]));
	gate.fromMount(reading.subarray(7));
	await settle();
	expect(Buffer.concat(toHome)).toEqual(Buffer.concat([init, reading]));
	expect(check).not.toHaveBeenCalled();
	const call = cloudClaudeFileCall(writeHook("toolu_1", "/company/a.md"));
	await expect(gate.admit(call as NonNullable<typeof call>, new AbortController().signal)).resolves.toBeUndefined();
	expect(check).toHaveBeenCalledTimes(1);
	const writes = [
		packet(14, 2, encodeString("/company"), ATTRS),
		open(3, "/company/a.md.tmp.4242.0123456789ab", 0x02 | 0x08 | 0x10),
		rename(4, "/company/a.md.tmp.4242.0123456789ab", "/company/a.md"),
	];
	toHome.length = 0;
	gate.fromMount(Buffer.concat(writes));
	await settle();
	expect(Buffer.concat(toHome)).toEqual(Buffer.concat(writes));
	expect(check).toHaveBeenCalledTimes(1);
	expect(lone).toEqual([]);
	expect(toMount).toEqual([]);
	gate.notice(
		JSON.stringify({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
		}),
	);
	toHome.length = 0;
	gate.fromMount(open(5, "/company/a.md", 0x02));
	await settle();
	expect(lone).toEqual([{ method: "fs/writeFile", paths: ["/company/a.md"] }]);
	expect(check).toHaveBeenCalledTimes(2);
	expect(toHome).toHaveLength(1);
});

it("answers a refused change with the protocol's own permission error and never lets it reach the home", async () => {
	const { gate, toHome, toMount, check, settle } = filesGate((action) =>
		action.callId === "toolu_9" || action.callId.startsWith("claude-file:") ? "REVIEW_DENIED: no." : undefined,
	);
	const call = cloudClaudeFileCall(writeHook("toolu_9", "/company/b.md"));
	await expect(gate.admit(call as NonNullable<typeof call>, new AbortController().signal)).resolves.toBe(
		"REVIEW_DENIED: no.",
	);
	gate.fromMount(open(7, "/company/b.md.tmp.1.abc", 0x02 | 0x08));
	gate.fromMount(remove(8, "/company/c.md"));
	gate.fromMount(read(9, "h"));
	await settle();
	expect(toMount).toEqual([
		cloudClaudeStatusPacket(7, "REVIEW_DENIED: no."),
		cloudClaudeStatusPacket(8, "REVIEW_DENIED: no."),
	]);
	expect(toHome).toEqual([read(9, "h")]);
	expect(check).toHaveBeenCalledTimes(2);
	expect(gate.counts).toMatchObject({ refused: 2, lone: 1, declined: 1 });
});

it("knows a handle's file, and leaves Claude Code's own working-folder file alone", async () => {
	const { gate, toHome, toMount, lone, check, settle } = filesGate(() => undefined);
	gate.fromMount(open(1, "/company/d.md", 1));
	await settle();
	gate.fromHome(handleReply(1, "H1"));
	expect(toMount).toEqual([handleReply(1, "H1")]);
	gate.fromMount(fsetstat(2, "H1"));
	gate.fromMount(remove(3, "/tmp/claude-5543-cwd"));
	await settle();
	expect(lone).toEqual([{ method: "fs/setAttributes", paths: ["/company/d.md"] }]);
	expect(check).toHaveBeenCalledTimes(1);
	expect(toHome).toHaveLength(3);
	expect(gate.counts.ownFiles).toBe(1);
});

it("stops at a stream that is not the protocol's", () => {
	const { gate, toHome } = filesGate(() => undefined);
	gate.fromMount(u32(0x7fffffff));
	expect(gate.broken).toBe(true);
	expect(toHome).toEqual([]);
});
