// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTH_LOCK_TIMEOUT_MS,
	type Cloud,
	CloudRpcError,
	connectionLost,
	createCloud,
	DATABASE_ANSWER_MS,
	describeError,
} from "../src/cloud/client.ts";

const clouds: Cloud[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const cloud of clouds.splice(0)) await cloud.supabase.auth.dispose();
});

function silentCloud(): { cloud: Cloud; asked: string[] } {
	const asked: string[] = [];
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return new Promise<Response>((_, reject) => {
			if (init?.signal?.aborted) reject(init.signal.reason);
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	});
	const cloud = createCloud({
		projectUrl: "https://silent.example.invalid",
		publishableKey: "sb_publishable_fixture123",
		objectGatewayUrl: "https://objects.example.invalid",
	});
	clouds.push(cloud);
	return { cloud, asked };
}

describe("a cloud that never answers", () => {
	it("gives up on a database call after twenty seconds, as a lost connection", async () => {
		vi.useFakeTimers();
		const { cloud, asked } = silentCloud();
		let outcome: unknown;
		void cloud.rpc("qorpera_list_hosted_profiles").then(
			() => {
				outcome = "answered";
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(DATABASE_ANSWER_MS - 1);
		expect(asked).toEqual(["https://silent.example.invalid/rest/v1/rpc/qorpera_list_hosted_profiles"]);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toBeInstanceOf(CloudRpcError);
		expect(connectionLost(outcome)).toBe(true);
		expect(describeError(outcome)).toBe("Qorpera can't be reached right now. Check your connection and try again.");
	});

	it("leaves calls outside the database alone, as they may rightly take long", async () => {
		vi.useFakeTimers();
		const { cloud, asked } = silentCloud();
		let settled = false;
		void cloud.supabase.functions.invoke("member-company-gateway/v1/slow").finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(3 * DATABASE_ANSWER_MS);
		expect(asked.some((url) => url.includes("/functions/v1/member-company-gateway/v1/slow"))).toBe(true);
		expect(settled).toBe(false);
	});

	it("keeps a call the app itself cancels a cancel, never a lost connection", async () => {
		const { cloud } = silentCloud();
		const stop = new AbortController();
		const call = cloud.supabase.rpc("qorpera_list_hosted_profiles").abortSignal(stop.signal);
		stop.abort();
		const { error } = await call;
		expect(error).not.toBeNull();
		expect(connectionLost(new CloudRpcError("qorpera_list_hosted_profiles", error!, 0))).toBe(false);
	});

	it("times out a database response that stalls mid-body after headers arrive", async () => {
		vi.useFakeTimers();
		let canceled = false;
		vi.stubGlobal("fetch", () => {
			const body = new ReadableStream<Uint8Array>({
				cancel() {
					canceled = true;
				},
			});
			return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		});
		const cloud = createCloud({
			projectUrl: "https://stall.example.invalid",
			publishableKey: "sb_publishable_fixture123",
			objectGatewayUrl: "https://objects.example.invalid",
		});
		clouds.push(cloud);
		let outcome: unknown;
		void cloud.rpc("qorpera_list_hosted_profiles").then(
			() => {
				outcome = "answered";
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(DATABASE_ANSWER_MS - 1);
		expect(outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(canceled).toBe(true);
		expect(outcome).toBeInstanceOf(CloudRpcError);
		expect(connectionLost(outcome)).toBe(true);
	});

	it("aborts a database response streaming mid-body when the caller signal aborts", async () => {
		let canceled = false;
		let streamingStarted!: () => void;
		const streaming = new Promise<void>((resolve) => {
			streamingStarted = resolve;
		});
		vi.stubGlobal("fetch", () => {
			const body = new ReadableStream<Uint8Array>({
				pull() {
					streamingStarted();
					return new Promise(() => {});
				},
				cancel() {
					canceled = true;
				},
			});
			return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		});
		const cloud = createCloud({
			projectUrl: "https://abort-body.example.invalid",
			publishableKey: "sb_publishable_fixture123",
			objectGatewayUrl: "https://objects.example.invalid",
		});
		clouds.push(cloud);
		const stop = new AbortController();
		const pending = cloud.rpc("qorpera_list_hosted_profiles", {}, stop.signal);
		await streaming;
		stop.abort(new DOMException("Cancelled", "AbortError"));
		await expect(pending).rejects.toBeInstanceOf(CloudRpcError);
		expect(canceled).toBe(true);
	});

	it("keeps a steadily streaming database response alive past DATABASE_ANSWER_MS while timing out if it later stalls", async () => {
		vi.useFakeTimers();
		const encoder = new TextEncoder();
		let attempt = 0;
		let stalledCanceled = false;
		vi.stubGlobal("fetch", () => {
			attempt++;
			if (attempt === 1) {
				return new Promise<Response>((resolve) => {
					setTimeout(() => {
						const body = new ReadableStream<Uint8Array>({
							start(ctrl) {
								setTimeout(() => ctrl.enqueue(encoder.encode('{"ok":')), 15_000);
								setTimeout(() => {
									ctrl.enqueue(encoder.encode("true}"));
									ctrl.close();
								}, 30_000);
							},
						});
						resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
					}, 15_000);
				});
			}
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					setTimeout(() => ctrl.enqueue(encoder.encode('{"partial":')), 15_000);
				},
				cancel() {
					stalledCanceled = true;
				},
			});
			return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		});
		const cloud = createCloud({
			projectUrl: "https://stream.example.invalid",
			publishableKey: "sb_publishable_fixture123",
			objectGatewayUrl: "https://objects.example.invalid",
		});
		clouds.push(cloud);

		const slow = cloud.rpc("qorpera_list_hosted_profiles");
		await vi.advanceTimersByTimeAsync(45_000);
		await expect(slow).resolves.toEqual({ ok: true });

		let stalledOutcome: unknown;
		void cloud.rpc("qorpera_list_hosted_profiles").then(
			() => {
				stalledOutcome = "answered";
			},
			(error: unknown) => {
				stalledOutcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(15_000 + DATABASE_ANSWER_MS - 1);
		expect(stalledOutcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(stalledCanceled).toBe(true);
		expect(stalledOutcome).toBeInstanceOf(CloudRpcError);
		expect(connectionLost(stalledOutcome)).toBe(true);
	});

	it("bounds stalled /auth/v1/ fetches so token refresh cannot hold auth locks indefinitely", async () => {
		vi.useFakeTimers();
		const { cloud, asked } = silentCloud();
		let settled = false;
		void cloud.supabase.auth.getUser("stale-access-token").finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(DATABASE_ANSWER_MS - 1);
		expect(asked).toContain("https://silent.example.invalid/auth/v1/user");
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true);
	});

	it("rejects cloud.rpc promptly when caller signal aborts while auth getSession is stalled", async () => {
		const { cloud, asked } = silentCloud();
		vi.spyOn(cloud.supabase.auth, "getSession").mockImplementation(() => new Promise(() => {}));
		const stop = new AbortController();
		const pending = cloud.rpc("qorpera_list_hosted_profiles", {}, stop.signal);
		await Promise.resolve();
		stop.abort(new DOMException("Company parked", "AbortError"));
		const error = await pending.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(CloudRpcError);
		expect(connectionLost(error)).toBe(false);
		expect(asked).toEqual([]);
	});

	it("bounds cross-tab auth lock acquisition and classifies lock acquire timeouts as connectionLost", () => {
		expect(AUTH_LOCK_TIMEOUT_MS).toBeGreaterThan(DATABASE_ANSWER_MS);
		const lockTimeout = Object.assign(new Error("lock timed out"), { isAcquireTimeout: true });
		expect(connectionLost(lockTimeout)).toBe(true);
		const wrapped = new CloudRpcError(
			"qorpera_list_hosted_profiles",
			{
				message:
					'Error: Acquiring an exclusive Navigator LockManager lock "lock:qorpera-web-auth/v1" timed out waiting 25000ms',
			},
			0,
		);
		expect(connectionLost(wrapped)).toBe(true);
	});
});
