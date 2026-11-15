import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLAUDE_BOX_CONFIGURATION,
	CLAUDE_BOX_DENY,
	CLAUDE_BOX_HOME_FOLDERS,
	CLAUDE_BOX_PATHS,
	CLAUDE_CODE_MINIMUM_VERSION,
	CLAUDE_CODE_PIN,
	claudeBoxArguments,
	claudeBoxEnvironment,
	claudeBoxInvocation,
	claudeBoxMountOptions,
	claudeBoxSettings,
} from "@qorpera/runtime/cloud-claude-box";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const scratch = "/var/lib/qorpera-native-provider/runs/abc";
const base = {
	configuration: CLAUDE_BOX_CONFIGURATION,
	scratchRoot: scratch,
	relayPath: `${scratch}/egress.sock`,
	shellSocket: `${scratch}/shell.sock`,
	owner: { uid: 997, gid: 996 },
};

/** The pairs of `--flag a b` in the box's part of the command. */
function pairs(args: readonly string[], flag: string): [string, string][] {
	const found: [string, string][] = [];
	for (let i = 0; i < args.length; i += 1) if (args[i] === flag) found.push([args[i + 1], args[i + 2]]);
	return found;
}

function versionAtLeast(version: string, minimum: string): boolean {
	const a = version.split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
	return true;
}

it("pins the Claude Code the artifact names, never older than 2.1.311", () => {
	const artifact = JSON.parse(
		readFileSync(join(root, "deploy/first-node/native-claude/linux-x64-artifact.json"), "utf8"),
	) as {
		schema: string;
		source: { package: string; version: string; integrity: string };
		artifact: { file: string; bytes: number; sha256: string; modified: boolean };
		minimumVersion: string;
	};
	expect(artifact.schema).toBe("qorpera.native-claude-artifact/v1");
	expect(artifact.source.package).toBe(CLAUDE_CODE_PIN.package);
	expect(artifact.source.version).toBe(CLAUDE_CODE_PIN.version);
	expect(artifact.source.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
	expect(artifact.artifact).toMatchObject({
		file: "claude",
		bytes: CLAUDE_CODE_PIN.bytes,
		sha256: CLAUDE_CODE_PIN.sha256,
		modified: false,
	});
	expect(artifact.minimumVersion).toBe(CLAUDE_CODE_MINIMUM_VERSION);
	expect(CLAUDE_CODE_MINIMUM_VERSION).toBe("2.1.311");
	expect(versionAtLeast(CLAUDE_CODE_PIN.version, CLAUDE_CODE_MINIMUM_VERSION)).toBe(true);
});

it("writes A5's settings: bypass, no sandbox, deny rules on the box's own folders only", () => {
	expect(JSON.parse(claudeBoxSettings())).toEqual({
		permissions: {
			defaultMode: "bypassPermissions",
			deny: ["Read(//slot/**)", "Edit(//slot/**)", "Write(//slot/**)", "Read(//opt/claude/**)"],
		},
		sandbox: { enabled: false },
		attribution: { commit: "", pr: "" },
	});
	// Claude Code applies Read rules to the paths a Bash command names: a rule on a path the home also has would
	// refuse the agent's own commands there (P4 3.6).
	for (const rule of CLAUDE_BOX_DENY) expect(rule).toMatch(/^(Read|Edit|Write)\(\/\/(slot|opt\/claude)\/\*\*\)$/);
	expect(JSON.parse(claudeBoxSettings({ noDenyRules: true })).permissions.deny).toBeUndefined();
});

it("starts Claude Code in print mode with settings from the box alone", () => {
	expect(claudeBoxArguments()).toEqual([
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"bypassPermissions",
		"--settings",
		"/opt/qorpera/settings.json",
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--tools",
		"Bash,Read,Edit,Write,NotebookEdit,Grep,Glob,TaskStop",
	]);
	expect(claudeBoxArguments({ tools: ["Bash", "Read"] }).slice(-2)).toEqual(["--tools", "Bash,Read"]);
	// The list only narrows: nothing outside the eight, nothing twice, never empty (an empty list would mean "no
	// restriction" to nobody, and "all" to a careless reader).
	for (const tools of [[], ["Bash", "Bash"], ["Bash", "WebFetch"], ["Task"], ["default"]])
		expect(() => claudeBoxArguments({ tools: tools as never })).toThrow("Invalid Claude tools");
	expect(claudeBoxArguments({ model: "claude-opus-5-5" }).slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
	expect(() => claudeBoxArguments({ model: "x --settings /tmp/evil" })).toThrow("Invalid Claude model");
});

it("hands a token in on descriptor 3 only, and keeps HOME and the config folder in the box", () => {
	const token = claudeBoxEnvironment({ login: "token" });
	expect(token.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe("3");
	expect(token.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	expect(token.HOME).toBe("/slot/home");
	expect(token.CLAUDE_CONFIG_DIR).toBe("/slot/config");
	expect(token.CLAUDE_CODE_SHELL_PREFIX).toBe("/opt/qorpera/home-shell");
	// Grep and Glob run the home's ripgrep through the bridge first on PATH.
	expect(token.USE_BUILTIN_RIPGREP).toBe("0");
	expect(token.PATH).toBe("/opt/qorpera/bin:/usr/bin:/bin");
	expect(token.NODE_EXTRA_CA_CERTS).toBeUndefined();
	const folder = claudeBoxEnvironment({ login: "folder" });
	expect(folder.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
	for (const environment of [token, folder])
		for (const folderOfHome of CLAUDE_BOX_HOME_FOLDERS) {
			expect(environment.HOME.startsWith(folderOfHome)).toBe(false);
			expect(environment.CLAUDE_CONFIG_DIR.startsWith(folderOfHome)).toBe(false);
		}
});

it("mounts the home with links resolved there, nothing on it runnable, every file shown as the box's account", () => {
	expect(claudeBoxMountOptions({ uid: 997, gid: 996 })).toBe(
		"passive,nosuid,nodev,noexec,follow_symlinks,uid=997,gid=996",
	);
	expect(claudeBoxMountOptions({ uid: 997, gid: 996 }, { noFollowSymlinks: true })).toBe(
		"passive,nosuid,nodev,noexec,uid=997,gid=996",
	);
	expect(() => claudeBoxMountOptions({ uid: 0, gid: 0 })).toThrow("Invalid box account");
});

it("makes the mount in the run's own namespace and starts the box without a capability", () => {
	const { command, args } = claudeBoxInvocation({ ...base, login: "token" });
	expect(command).toBe("/opt/qorpera-runner/qorpera-claude-box-ns");
	const split = args.indexOf("/usr/bin/bwrap");
	expect(args.slice(0, split)).toEqual([
		"--user",
		"--map-current-user",
		"--keep-caps",
		"--mount",
		"--pid",
		"--fork",
		"--kill-child",
		"--mount-proc",
		"--",
		"/bin/bash",
		"/opt/qorpera-runner/qorpera-claude-box-stage.sh",
		`${scratch}/mnt`,
		"/usr/bin/sshfs",
		"passive,nosuid,nodev,noexec,follow_symlinks,uid=997,gid=996",
		"--",
	]);
	const box = args.slice(split + 1);
	for (const flag of ["--unshare-user", "--unshare-net", "--disable-userns", "--die-with-parent", "--clearenv"])
		expect(box).toContain(flag);
	expect(box.slice(box.indexOf("--cap-drop"), box.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
	const binds = pairs(box, "--bind");
	expect(binds).toEqual([
		[`${scratch}/slot-config`, "/slot/config"],
		[`${scratch}/slot-home`, "/slot/home"],
		[`${scratch}/mnt/company`, "/company"],
		[`${scratch}/mnt/var/lib/qorpera-agent`, "/var/lib/qorpera-agent"],
		[`${scratch}/mnt/tmp`, "/tmp"],
	]);
	const readOnly = pairs(box, "--ro-bind");
	expect(readOnly).toContainEqual(["/opt/qorpera-harnesses/native-claude/claude", CLAUDE_BOX_PATHS.binary]);
	expect(readOnly).toContainEqual([`${scratch}/settings.json`, CLAUDE_BOX_PATHS.settings]);
	expect(readOnly).toContainEqual([`${scratch}/shell.sock`, CLAUDE_BOX_PATHS.shellSocket]);
	expect(readOnly).toContainEqual([`${scratch}/rg`, "/opt/qorpera/bin/rg"]);
	// The run host's own /etc never enters the box whole.
	expect(readOnly.filter(([, inside]) => inside.startsWith("/etc")).map(([, inside]) => inside)).toEqual([
		"/etc/ssl/certs",
		"/etc/ld.so.cache",
		"/etc/passwd",
		"/etc/group",
	]);
	expect(box.slice(-17)).toEqual([
		"/usr/bin/node",
		"/opt/qorpera/native-entry.mjs",
		`${scratch}/egress.sock`,
		"/opt/claude/claude",
		...claudeBoxArguments(),
	]);
	const environment = pairs(box, "--setenv");
	expect(Object.fromEntries(environment)).toEqual(claudeBoxEnvironment({ login: "token" }));
});

it("mounts a login folder as Claude Code's config folder and never a token's variable with it", () => {
	const { args } = claudeBoxInvocation({ ...base, login: { folder: "/var/lib/qorpera-claude-logins/m1" } });
	const box = args.slice(args.indexOf("/usr/bin/bwrap") + 1);
	expect(pairs(box, "--bind")[0]).toEqual(["/var/lib/qorpera-claude-logins/m1", "/slot/config"]);
	expect(Object.fromEntries(pairs(box, "--setenv")).CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
});
