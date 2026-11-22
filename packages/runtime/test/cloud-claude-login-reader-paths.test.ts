import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ClaudeLoginReader } from "@qorpera/runtime/cloud-claude-login-reader";
import { NATIVE_EGRESS_SOCKET_NAME, NATIVE_SOCKET_PATH_BYTES } from "@qorpera/runtime/cloud-native-egress";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	launched: [] as string[],
	isolatedClosedStdin: false,
	directScreenClosedStdin: false,
}));

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn((command: string, args?: readonly string[], options?: Record<string, unknown>) => {
			if (state.directScreenClosedStdin && command === "/usr/bin/script") {
				const script = [
					'const fs = require("node:fs");',
					"fs.closeSync(0);",
					'process.stdout.write("\\x1b[2J\\x1b[H" + [',
					'  "\\u276f /limit-reset full",',
					'  "\\u2500\\u2500\\u2500\\u2500",',
					'  "  Use a full reset?",',
					'  "",',
					'  "  Refills your 5-hour and weekly limits now \\u00b7 your weekly reset day stays Nov 20, 10:51am",',
					'  "  3 full resets left \\u00b7 use by Dec 1, 10:51am",',
					'  "",',
					'  "  \\u276f Yes, use my full reset",',
					'  "    No, keep it",',
					'  "",',
					'  "  Enter to confirm \\u00b7 Esc to cancel",',
					'].join("\\r\\n"));',
					"setTimeout(() => process.exit(0), 2000);",
				].join("\n");
				return actual.spawn(process.execPath, ["-e", script], options as never);
			}
			return actual.spawn(command, args ?? [], options as never);
		}),
	};
});

vi.mock("@qorpera/runtime/cloud-native-isolation", async (original) => ({
	...(await original<typeof import("@qorpera/runtime/cloud-native-isolation")>()),
	launchIsolatedNativeProcess: vi.fn(async (options: { scratchRoot: string }) => {
		state.launched.push(options.scratchRoot);
		if (!state.isolatedClosedStdin) throw new Error("Stopped before the launch");
		const child = spawn(
			process.execPath,
			[
				"-e",
				'require("node:fs").closeSync(0); process.stdout.write("READY\\n"); setTimeout(() => process.exit(0), 2000);',
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.stdout.once("data", () => resolve());
		});
		return {
			child,
			close: async () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			},
		};
	}),
}));

const VAULT_ROOT = "/run/qorpera-model-login-helper";
const roots: string[] = [];
afterEach(async () => {
	state.launched.splice(0);
	state.isolatedClosedStdin = false;
	state.directScreenClosedStdin = false;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("keeps the relay's socket of every isolated read within a socket path's length under the vault helper's root", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-claude-paths-"));
	roots.push(root);
	const reader = new ClaudeLoginReader({
		claudePath: "/opt/qorpera-model-login-helper/claude",
		temporaryRoot: root,
		isolation: { entryPoint: "/opt/qorpera-model-login-helper/qorpera-native-isolation-child.mjs" },
	});
	const credentials = Buffer.from('{"claudeAiOauth":{}}').toString("base64");
	expect(
		await reader.readClaudeLogin({ credentials, usage: true, resets: true }, AbortSignal.timeout(10_000)),
	).toEqual({
		usage: null,
		resets: null,
	});
	await expect(reader.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(10_000))).rejects.toThrow(
		"Stopped before the launch",
	);
	expect(state.launched).toHaveLength(3);
	for (const scratch of state.launched) {
		const socket = join(VAULT_ROOT, relative(root, scratch), NATIVE_EGRESS_SOCKET_NAME);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(NATIVE_SOCKET_PATH_BYTES);
	}
});

it("ignores EPIPE on stdin for both isolated and direct launches when the child closes fd 0 before writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-claude-epipe-"));
	roots.push(root);
	const credentials = Buffer.from('{"claudeAiOauth":{}}').toString("base64");

	state.isolatedClosedStdin = true;
	const isolatedReader = new ClaudeLoginReader({
		claudePath: "/opt/qorpera-model-login-helper/claude",
		temporaryRoot: root,
		isolation: { entryPoint: "/opt/qorpera-model-login-helper/qorpera-native-isolation-child.mjs" },
	});
	expect(
		await isolatedReader.readClaudeLogin({ credentials, usage: true, resets: false }, AbortSignal.timeout(10_000)),
	).toEqual({
		usage: null,
		resets: null,
	});
	state.isolatedClosedStdin = false;

	state.directScreenClosedStdin = true;
	const directReader = new ClaudeLoginReader({
		claudePath: process.execPath,
		temporaryRoot: root,
		timings: { screenMs: 5_000, claimMs: 2_500, settleMs: 100 },
	});
	expect(await directReader.useClaudeReset({ credentials, kind: "full" }, AbortSignal.timeout(10_000))).toEqual({
		outcome: "unconfirmed",
	});
});
