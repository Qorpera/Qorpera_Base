import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudSyncHealthPath, DurableCloudSyncLoop } from "../src/cloud-sync-loop.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";

describe("durable cloud sync loop", () => {
	let root = "";
	let userData = "";

	afterEach(() => {
		for (const path of [root, userData]) {
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	it("persists retry backoff and resumes it after restart", async () => {
		root = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-root-"));
		userData = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-state-"));
		let now = Date.parse("2026-08-16T00:00:00.000Z");
		const failed = new DurableCloudSyncLoop({
			root,
			userData,
			profileId,
			channel: "trail",
			now: () => now,
			minimumRetryDelayMs: 1_000,
			sync: async () => {
				throw new Error("fetch failed");
			},
		});
		expect(await failed.syncNow()).toMatchObject({
			phase: "retrying",
			consecutiveFailures: 1,
			nextAttemptAt: "2026-08-16T00:00:01.000Z",
		});
		expect(existsSync(cloudSyncHealthPath(userData, root, profileId, "trail"))).toBe(true);

		let scheduledDelay = -1;
		let scheduled: (() => void) | undefined;
		const timer = setTimeout(() => undefined, 60_000);
		clearTimeout(timer);
		const sync = vi.fn(async () => undefined);
		const resumed = new DurableCloudSyncLoop({
			root,
			userData,
			profileId,
			channel: "trail",
			now: () => now,
			minimumRetryDelayMs: 1_000,
			steadyDelayMs: 10_000,
			sync,
			setTimer: (callback, delayMs) => {
				scheduled = callback;
				scheduledDelay = delayMs;
				return timer;
			},
			clearTimer: () => undefined,
		});
		resumed.start();
		expect(scheduledDelay).toBe(1_000);
		now += 1_000;
		scheduled?.();
		await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(resumed.health().phase).toBe("healthy"));
		expect(resumed.health()).toMatchObject({
			consecutiveFailures: 0,
			lastSuccessAt: "2026-08-16T00:00:01.000Z",
			nextAttemptAt: "2026-08-16T00:00:11.000Z",
		});
		resumed.stop();
	});

	it("stops retrying conflicts that need a person", async () => {
		root = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-root-"));
		userData = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-state-"));
		const loop = new DurableCloudSyncLoop({
			root,
			userData,
			profileId,
			channel: "staff",
			sync: async () => {
				throw new Error("Shared staff changed on this computer and in the cloud");
			},
		});
		expect(await loop.syncNow()).toMatchObject({
			phase: "attention",
			consecutiveFailures: 1,
		});
		expect(loop.health().nextAttemptAt).toBeUndefined();
	});

	it("coalesces concurrent triggers", async () => {
		root = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-root-"));
		userData = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-state-"));
		let finish: (() => void) | undefined;
		const sync = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const loop = new DurableCloudSyncLoop({ root, userData, profileId, channel: "trail", sync });
		const first = loop.syncNow();
		const second = loop.syncNow();
		expect(second).toBe(first);
		expect(sync).toHaveBeenCalledOnce();
		finish?.();
		await expect(first).resolves.toMatchObject({ phase: "healthy" });
	});

	it("runs one immediate follow-up when a realtime trigger arrives during synchronization", async () => {
		root = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-root-"));
		userData = mkdtempSync(join(tmpdir(), "qorpera-cloud-loop-state-"));
		const finishes: Array<() => void> = [];
		const sync = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishes.push(resolve);
				}),
		);
		const loop = new DurableCloudSyncLoop({ root, userData, profileId, channel: "trail", sync });
		const first = loop.syncNow();
		expect(loop.trigger()).toBe(first);
		expect(sync).toHaveBeenCalledOnce();

		finishes[0]?.();
		await expect(first).resolves.toMatchObject({ phase: "healthy" });
		await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
		finishes[1]?.();
		await vi.waitFor(() => expect(loop.health().phase).toBe("healthy"));
	});
});
