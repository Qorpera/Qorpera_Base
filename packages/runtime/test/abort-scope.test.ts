import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withAbortScopes } from "../src/abort-scope.ts";
import { CloudBankSyncUpkeep } from "../src/cloud-bank-sync.ts";
import { CloudConnectorTokenRevocationUpkeep } from "../src/cloud-connector-token-revocation.ts";
import { CloudDigitalPostSyncUpkeep } from "../src/cloud-digital-post-sync.ts";
import { CloudEventVerificationUpkeep } from "../src/cloud-event-verification.ts";
import { CloudRuntimeObservability } from "../src/cloud-runtime-observability.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

describe("abort scopes and daemon upkeep hygiene", () => {
	it("forwards multi-parent aborts and timeouts in withAbortScopes without AbortSignal.any or listener leaks", async () => {
		const watch = watchAbortSignalAny();
		try {
			const p1 = new AbortController();
			const p2 = new AbortController();

			expect(await withAbortScopes([p1.signal, undefined, p2.signal], async () => "ok", 500)).toBe("ok");
			expect(getEventListeners(p1.signal, "abort")).toHaveLength(0);
			expect(getEventListeners(p2.signal, "abort")).toHaveLength(0);

			const reason = new Error("parent-two-aborted");
			await expect(
				withAbortScopes(
					[p1.signal, p2.signal],
					async (signal) => {
						queueMicrotask(() => p2.abort(reason));
						return await new Promise<never>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					},
					5_000,
				),
			).rejects.toBe(reason);
			expect(getEventListeners(p1.signal, "abort")).toHaveLength(0);
			expect(getEventListeners(p2.signal, "abort")).toHaveLength(0);

			const p3 = new AbortController();
			await expect(
				withAbortScopes([p2.signal, p3.signal], async (signal) => {
					expect(signal.aborted).toBe(true);
					expect(signal.reason).toBe(reason);
					expect(getEventListeners(p3.signal, "abort")).toHaveLength(0);
					throw signal.reason;
				}),
			).rejects.toBe(reason);
			expect(getEventListeners(p3.signal, "abort")).toHaveLength(0);

			const timeoutError = await withAbortScopes(
				[p1.signal],
				async (signal) =>
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				40,
			).catch((error: unknown) => error);
			expect(timeoutError).toBeInstanceOf(DOMException);
			expect((timeoutError as DOMException).name).toBe("TimeoutError");
			expect(getEventListeners(p1.signal, "abort")).toHaveLength(0);
			expect(watch.made()).toBe(0);
		} finally {
			watch.restore();
		}
	});

	it("scopes single-company broker upkeep loops so AbortSignal.any never accumulates on closing signals", async () => {
		const watch = watchAbortSignalAny();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const digitalPost = new CloudDigitalPostSyncUpkeep({
			syncs: {
				pass: async (signal) => {
					AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
					return "idle";
				},
			},
		});
		const bank = new CloudBankSyncUpkeep({
			syncs: {
				pass: async (signal) => {
					AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
					return "idle";
				},
			},
		});
		const revocations = new CloudConnectorTokenRevocationUpkeep({
			revocations: {
				pass: async (signal) => {
					AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
					return { completed: 0, failed: 0 };
				},
			},
		});
		let verificationPasses = 0;
		const verifications = new CloudEventVerificationUpkeep({
			verifications: {
				pass: async (signal) => {
					verificationPasses++;
					AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
					return { verified: 0, refused: 0, retried: 0, duplicate: 0, stale: 0, failed: 0 };
				},
			},
			firstPassMs: 1,
			passEveryMs: 5,
		});
		try {
			for (let round = 0; round < 6; round++) {
				await digitalPost.pass();
				await bank.pass();
				await revocations.pass();
			}
			verifications.start();
			await vi.waitFor(() => expect(verificationPasses).toBeGreaterThanOrEqual(4));
			await verifications.close();
			expect(watch.made()).toBeGreaterThanOrEqual(22);
			expect(watch.most()).toBe(1);
		} finally {
			watch.restore();
			await Promise.all([digitalPost.close(), bank.close(), revocations.close(), verifications.close()]);
			vi.restoreAllMocks();
		}
	});

	it("exports runtime observations without AbortSignal.any or aborting settled batch signals", async () => {
		const watch = watchAbortSignalAny();
		const seenSignals: AbortSignal[] = [];
		let published = 0;
		const metrics = new CloudRuntimeObservability({
			assignmentId: randomUUID(),
			batchDelayMs: 0,
			publish: async (batch, signal) => {
				seenSignals.push(signal);
				published += batch.length;
				return 0;
			},
		});
		try {
			for (let i = 0; i < 6; i++) {
				const span = metrics.start("company_read");
				span.finish("succeeded");
				await vi.waitFor(() => expect(published).toBeGreaterThanOrEqual((i + 1) * 2));
			}
			expect(seenSignals.length).toBeGreaterThanOrEqual(6);
			expect(seenSignals.every((signal) => !signal.aborted)).toBe(true);
			expect(watch.made()).toBe(0);
		} finally {
			watch.restore();
			await metrics.close();
		}
	});
});
