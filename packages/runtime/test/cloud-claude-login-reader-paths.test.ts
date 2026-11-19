import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ClaudeLoginReader } from "@qorpera/runtime/cloud-claude-login-reader";
import { NATIVE_EGRESS_SOCKET_NAME, NATIVE_SOCKET_PATH_BYTES } from "@qorpera/runtime/cloud-native-egress";
import { afterEach, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => [] as string[]);
vi.mock("@qorpera/runtime/cloud-native-isolation", async (original) => ({
	...(await original<typeof import("@qorpera/runtime/cloud-native-isolation")>()),
	launchIsolatedNativeProcess: vi.fn(async (options: { scratchRoot: string }) => {
		launched.push(options.scratchRoot);
		throw new Error("Stopped before the launch");
	}),
}));

const VAULT_ROOT = "/run/qorpera-model-login-helper";
const roots: string[] = [];
afterEach(async () => {
	launched.splice(0);
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
	expect(launched).toHaveLength(3);
	for (const scratch of launched) {
		const socket = join(VAULT_ROOT, relative(root, scratch), NATIVE_EGRESS_SOCKET_NAME);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(NATIVE_SOCKET_PATH_BYTES);
	}
});
