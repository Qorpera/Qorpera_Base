import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeProviderHost, type NativeProviderLoginRequest } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function fixture(backup: (request: NativeProviderLoginRequest) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-backup-order-"));
	roots.push(root);
	const request: NativeProviderLoginRequest = {
		loginId: randomUUID(),
		clientConnectionId: randomUUID(),
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: randomUUID(),
		provider: "openai",
		nativeHarness: "codex-cli",
		capability: randomBytes(32).toString("base64url"),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	const put = vi.fn(async () => undefined);
	const complete = vi.fn(async () => undefined);
	const host = new NativeProviderHost({
		computeIdentityId: request.computeIdentityId,
		masterKey: randomBytes(32).toString("base64url"),
		temporaryRoot: root,
		backupIdentityKey: backup,
		controlPlane: {
			describeLogin: async () => ({ ...request, profileId: randomUUID() }),
			completeLogin: complete,
			validateExecution: async () => {
				throw new Error("Unexpected execution");
			},
			sendMessage: async () => {
				throw new Error("Unexpected send");
			},
		},
		capsules: {
			put,
			get: async () => {
				throw new Error("Unexpected capsule read");
			},
		},
		harness: {
			async beginLogin(_harness, identityRoot) {
				await mkdir(join(identityRoot, "codex"), { mode: 0o700 });
				await writeFile(join(identityRoot, "codex", "auth.json"), '{"syntheticCredential":true}', { mode: 0o600 });
				return { prompt: Promise.resolve({}), completed: Promise.resolve({}), cancel: async () => undefined };
			},
			execute: async () => {
				throw new Error("Unexpected provider work");
			},
		},
	});
	return { host, request, put, complete };
}

describe("native login recovery backup ordering", () => {
	it("waits for confirmed backup before uploading or committing provider credentials", async () => {
		let confirm: () => void = () => {
			throw new Error("Backup has not started");
		};
		const pending = new Promise<void>((resolve) => {
			confirm = resolve;
		});
		const backup = vi.fn(async () => pending);
		const f = await fixture(backup);
		await f.host.beginLogin(f.request);
		await vi.waitFor(() => expect(backup).toHaveBeenCalledWith(f.request));
		expect(f.put).not.toHaveBeenCalled();
		expect(f.complete).not.toHaveBeenCalled();
		confirm();
		await vi.waitFor(async () => expect(await f.host.beginLogin(f.request)).toMatchObject({ status: "completed" }));
		expect(backup).toHaveBeenCalledTimes(1);
		expect(f.put).toHaveBeenCalledTimes(1);
		expect(f.complete).toHaveBeenCalledTimes(1);
	});

	it("does not publish credentials when backup fails, and reports only the failing stage", async () => {
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const f = await fixture(async () => {
			throw new Error("synthetic-private-backend-detail");
		});
		await f.host.beginLogin(f.request);
		await vi.waitFor(() =>
			expect(diagnostic).toHaveBeenCalledWith("Native provider login identity-key-backup stage failed"),
		);
		await expect(f.host.beginLogin(f.request)).rejects.toThrow("identity-key-backup stage failed");
		expect(f.put).not.toHaveBeenCalled();
		expect(f.complete).not.toHaveBeenCalled();
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private-backend-detail");
	});
});
