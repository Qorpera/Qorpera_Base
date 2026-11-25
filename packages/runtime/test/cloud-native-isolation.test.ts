import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_CHATGPT_PLAN_EGRESS_HOSTS, NATIVE_CODEX_EGRESS_HOSTS } from "@qorpera/runtime/cloud-native-egress";
import {
	CHATGPT_PLAN_TOKEN_ENVIRONMENT,
	NATIVE_CLAUDE_TERMINAL,
	NATIVE_ISOLATION_WORKSPACE,
	nativeIsolationEgressHosts,
	nativeIsolationInvocation,
	nativeTerminalCommand,
	rootOwnedProgram,
} from "@qorpera/runtime/cloud-native-isolation";
import { expect, it } from "vitest";

const scratch = "/run/qorpera/runs/abc/runtime";
const base = {
	configuration: { entryPoint: "/opt/qorpera-runner/qorpera-native-isolation-child.mjs" },
	command: "/opt/qorpera-runner/codex",
	args: ["app-server", "--strict-config"],
	scratchRoot: scratch,
	codexHome: "/run/qorpera/identity/codex",
	relayPath: `${scratch}/egress.sock`,
	fenceSocket: `${scratch}/fence.sock`,
};

it("gives a Codex login's run exactly the namespace it had before plan runs existed", () => {
	expect(nativeIsolationInvocation(base)).toEqual({
		args: [
			"--unshare-user",
			"--unshare-pid",
			"--unshare-net",
			"--unshare-ipc",
			"--unshare-uts",
			"--unshare-cgroup",
			"--disable-userns",
			"--assert-userns-disabled",
			"--die-with-parent",
			"--new-session",
			"--cap-drop",
			"ALL",
			"--clearenv",
			"--ro-bind",
			"/usr",
			"/usr",
			"--symlink",
			"usr/bin",
			"/bin",
			"--symlink",
			"usr/lib",
			"/lib",
			"--symlink",
			"usr/lib64",
			"/lib64",
			"--ro-bind",
			"/etc/ssl/certs",
			"/etc/ssl/certs",
			"--ro-bind",
			"/etc/ld.so.cache",
			"/etc/ld.so.cache",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--size",
			"67108864",
			"--tmpfs",
			"/tmp",
			"--ro-bind",
			base.command,
			base.command,
			"--ro-bind",
			base.configuration.entryPoint,
			"/qorpera/native-entry.mjs",
			...["workspace", "home", "config", "data", "cache"].flatMap((name) => [
				"--bind",
				`${scratch}/${name}`,
				`${scratch}/${name}`,
			]),
			"--bind",
			base.codexHome,
			base.codexHome,
			"--ro-bind",
			base.relayPath,
			base.relayPath,
			"--ro-bind",
			base.fenceSocket,
			base.fenceSocket,
			"--setenv",
			"HOME",
			`${scratch}/home`,
			"--setenv",
			"CODEX_HOME",
			base.codexHome,
			"--setenv",
			"XDG_CONFIG_HOME",
			`${scratch}/config`,
			"--setenv",
			"XDG_DATA_HOME",
			`${scratch}/data`,
			"--setenv",
			"XDG_CACHE_HOME",
			`${scratch}/cache`,
			"--setenv",
			"PATH",
			"/usr/bin:/bin",
			"--setenv",
			"LANG",
			"C.UTF-8",
			"--setenv",
			"TZ",
			"UTC",
			"--setenv",
			"NO_COLOR",
			"1",
			"--setenv",
			"QORPERA_NATIVE_RESULT_FENCE_SOCKET",
			base.fenceSocket,
			"--chdir",
			`${scratch}/workspace`,
			"--remount-ro",
			"/",
			"--",
			"/usr/bin/node",
			"/qorpera/native-entry.mjs",
			base.relayPath,
			base.command,
			...base.args,
		],
		environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
	});
	expect(nativeIsolationEgressHosts(undefined)).toBe(NATIVE_CODEX_EGRESS_HOSTS);
});

it("binds a plan run's token directory read-only at its own path, and reaches OpenAI's API alone", () => {
	const directory = "/run/qorpera/identity/chatgpt-plan";
	const plan = nativeIsolationInvocation({ ...base, chatGptPlan: { directory } });
	const codex = nativeIsolationInvocation(base);
	// The one difference: the directory, bound read-only as a directory so a renamed-in token shows.
	const bind = plan.args.indexOf(directory);
	expect(plan.args.slice(bind - 1, bind + 2)).toEqual(["--ro-bind", directory, directory]);
	expect([...plan.args.slice(0, bind - 1), ...plan.args.slice(bind + 2)]).toEqual(codex.args);
	expect(plan.environment).toEqual(codex.environment);
	expect(nativeIsolationEgressHosts({ directory })).toBe(NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
});

it("gives the fallback's token to bwrap's environment, never to an argument, and keeps it out of a cleared one", () => {
	const accessToken = "plan.access-token_1";
	const fallback = nativeIsolationInvocation({ ...base, chatGptPlan: { accessToken } });
	const codex = nativeIsolationInvocation(base);
	expect(fallback.args.some((argument) => argument.includes(accessToken))).toBe(false);
	// No --clearenv, so the namespace inherits bwrap's environment: exactly PATH, LANG and the token.
	expect(fallback.args).toEqual(codex.args.filter((argument) => argument !== "--clearenv"));
	expect(fallback.environment).toEqual({
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		[CHATGPT_PLAN_TOKEN_ENVIRONMENT]: accessToken,
	});
	expect(nativeIsolationEgressHosts({ accessToken })).toBe(NATIVE_CHATGPT_PLAN_EGRESS_HOSTS);
	for (const bad of ["", "two words", "line\nbreak", "x".repeat(16_385)])
		expect(() => nativeIsolationInvocation({ ...base, chatGptPlan: { accessToken: bad } })).toThrow(
			"Invalid ChatGPT plan access token",
		);
});

it("lets a Claude read reach Anthropic's API alone, with its own switches, and draws the reset screen in a terminal", () => {
	const claude = {
		configuration: base.configuration,
		command: "/opt/qorpera-harnesses/native-claude/claude",
		args: ["/limit-reset"],
		scratchRoot: scratch,
		codexHome: "/run/qorpera/read/claude",
		relayPath: `${scratch}/egress.sock`,
		harness: "claude-code" as const,
	};
	const environment = (read?: "usage" | "screen") => {
		const args = nativeIsolationInvocation({ ...claude, ...(read ? { claudeRead: read } : {}) }).args;
		const set: Record<string, string> = {};
		for (let index = args.indexOf("--setenv"); index >= 0; index = args.indexOf("--setenv", index + 3))
			set[args[index + 1]!] = args[index + 2]!;
		return set;
	};
	expect(environment()).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
	expect(environment("usage")).toMatchObject({ DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	expect(environment("usage")).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
	expect(environment("screen")).toMatchObject({
		CLAUDE_CODE_SANDBOXED: "1",
		TERM: "xterm-256color",
		COLUMNS: String(NATIVE_CLAUDE_TERMINAL.cols),
		LINES: String(NATIVE_CLAUDE_TERMINAL.rows),
	});
	expect(environment("screen")).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
	expect(nativeIsolationEgressHosts(undefined, "claude-code")).toEqual(["platform.claude.com", "api.anthropic.com"]);
	for (const read of ["usage", "screen"] as const)
		expect(nativeIsolationEgressHosts(undefined, "claude-code", read)).toEqual(["api.anthropic.com"]);
	expect(() => nativeIsolationInvocation({ ...base, claudeRead: "usage" })).toThrow("A Claude read runs Claude Code");
	expect(nativeTerminalCommand("/usr/lib/cargo/bin/coreutils/stty", "/usr/bin/bwrap", ["--x", "it's"])).toEqual([
		"-q",
		"-e",
		"-c",
		`'/usr/lib/cargo/bin/coreutils/stty' rows ${NATIVE_CLAUDE_TERMINAL.rows} cols ${NATIVE_CLAUDE_TERMINAL.cols} && exec '/usr/bin/bwrap' '--x' 'it'\\''s'`,
		"/dev/null",
	]);
});

it("bind-mounts workspace to a fixed virtual path when workspaceMount is configured", () => {
	const mounted = nativeIsolationInvocation({ ...base, workspaceMount: NATIVE_ISOLATION_WORKSPACE });
	const bindIdx = mounted.args.indexOf(`${scratch}/workspace`);
	expect(bindIdx).toBeGreaterThan(0);
	expect(mounted.args.slice(bindIdx - 1, bindIdx + 2)).toEqual([
		"--bind",
		`${scratch}/workspace`,
		NATIVE_ISOLATION_WORKSPACE,
	]);
	const chdirIdx = mounted.args.indexOf("--chdir");
	expect(mounted.args[chdirIdx + 1]).toBe(NATIVE_ISOLATION_WORKSPACE);
	for (const bad of ["/", "/usr", "/tmp", "workspace", "/work space", "/workspace/.."])
		expect(() => nativeIsolationInvocation({ ...base, workspaceMount: bad })).toThrow(
			"Invalid native isolation workspace mount",
		);
});

it.runIf(process.platform === "linux")(
	"runs the root-owned file a program's name leads to, a symlink to a hard-linked binary too",
	async () => {
		expect(await rootOwnedProgram("/usr/bin/stty")).toBe(await realpath("/usr/bin/stty"));
		expect(await rootOwnedProgram("/usr/bin/script")).toBe(await realpath("/usr/bin/script"));
		await expect(rootOwnedProgram("usr/bin/stty")).rejects.toThrow(
			"Native isolation requires physical absolute artifacts",
		);
		const folder = await mkdtemp(join(tmpdir(), "qorpera-program-"));
		try {
			await writeFile(join(folder, "stty"), "", { mode: 0o755 });
			await symlink(join(folder, "stty"), join(folder, "link"));
			for (const path of [join(folder, "stty"), join(folder, "link")])
				await expect(rootOwnedProgram(path)).rejects.toThrow("Unsafe native isolation artifact ownership");
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	},
);
