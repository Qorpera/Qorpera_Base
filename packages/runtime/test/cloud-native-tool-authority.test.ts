import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import {
	CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS,
	type CloudNativeToolAuthorityReader,
	CloudNativeToolRun,
	cloudToolRequest,
	parseCloudNativeToolAuthority,
	parseCloudNativeToolBinding,
} from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function admit() {
	const fixture = nativeToolAuthorityFixture();
	const reader = { describeToolAuthority: vi.fn(async () => structuredClone(fixture.authority)) };
	const abort = new AbortController();
	const run = await CloudNativeToolRun.open(fixture.binding, reader, abort.signal);
	runs.push(run);
	return { ...fixture, reader, abort, run };
}

/** Fake timers and performance.now move together, in small steps, so a timer set late in a step still fires in the next. */
function fakeClock() {
	vi.useFakeTimers();
	const clock = {
		now: 0,
		async tick(ms: number) {
			for (let passed = 0; passed < ms; passed += 50) {
				clock.now += 50;
				await vi.advanceTimersByTimeAsync(50);
			}
		},
	};
	vi.spyOn(performance, "now").mockImplementation(() => clock.now);
	return clock;
}

/** An answer that arrives `ms` from now on the fake clock. */
function after<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

it("projects distinct cloud principals without credentials or model-selectable authority", async () => {
	const { run, binding, authority, reader } = await admit();
	expect(run.identity).toEqual(authority.identity);
	expect(run.identity.requesterUserId).not.toBe(run.identity.sponsorUserId);
	expect(Object.isFrozen(run.binding)).toBe(true);
	expect(Object.isFrozen(run.identity)).toBe(true);
	expect(JSON.stringify(run.identity)).not.toContain(binding.credentialCapsuleId);
	expect(JSON.stringify(run.identity)).not.toMatch(/token|secret|credential|capsule/i);
	expect(reader.describeToolAuthority).toHaveBeenCalledWith(binding, expect.any(AbortSignal));
});

it.each([
	{ companyId: randomUUID() },
	{ approved: true },
	{ model: 7 },
	{ model: "bad\nmodel" },
	{ runId: null },
	{ leaseId: "not-a-lease" },
	{ provider: "anthropic" },
	{ nativeHarness: "other" },
])("rejects forged or malformed host bindings: %j", (patch) => {
	const { binding } = nativeToolAuthorityFixture();
	expect(() => parseCloudNativeToolBinding({ ...binding, ...patch })).toThrow();
});

it.each([
	"runId",
	"jobId",
	"runnerId",
	"assignmentId",
	"leaseId",
	"computeIdentityId",
	"model",
	"provider",
	"nativeHarness",
])("rejects authority for another %s", (key) => {
	const { binding, authority } = nativeToolAuthorityFixture();
	expect(() =>
		parseCloudNativeToolAuthority(
			{ ...authority, identity: { ...authority.identity, [key]: randomUUID() } },
			binding,
		),
	).toThrow();
});

it.each([
	{ validForMs: 0 },
	{ validForMs: 30_001 },
	{ validForMs: 1.5 },
	{ approved: true },
	{ identity: {} },
	{ schema: "other" },
])("rejects malformed or overlong authority: %j", (patch) => {
	const { binding, authority } = nativeToolAuthorityFixture();
	expect(() => parseCloudNativeToolAuthority({ ...authority, ...patch }, binding)).toThrow();
});

it("rejects undeclared identity fields and non-integer versions", () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	for (const patch of [
		{ token: "PRIVATE_TOKEN" },
		{ staffVersion: 0 },
		{ sponsorVersion: 2.5 },
		{ requesterUserId: null },
	]) {
		expect(() =>
			parseCloudNativeToolAuthority({ ...authority, identity: { ...authority.identity, ...patch } }, binding),
		).toThrow();
	}
});

it("rechecks the cloud instead of trusting an admitted description", async () => {
	const { run, reader } = await admit();
	await run.assertActive(run.signal);
	await run.assertActive(run.signal);
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(3);
	reader.describeToolAuthority.mockRejectedValueOnce(new Error("PRIVATE_REVOKED_DIAGNOSTIC"));
	await expect(run.assertActive(run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(run.signal.aborted).toBe(true);
	await expect(run.assertActive(run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(4);
});

it.each([
	"companyId",
	"environmentId",
	"staffAgentId",
	"requesterUserId",
	"sponsorUserId",
	"sessionId",
	"providerConnectionId",
	"audienceUserId",
	"runtimeBundleId",
])("stops instead of changing the admitted %s mid-turn", async (key) => {
	const { run, reader, authority } = await admit();
	reader.describeToolAuthority.mockResolvedValueOnce({
		...authority,
		identity: { ...authority.identity, [key]: randomUUID() },
	});
	await expect(run.assertActive(run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(run.signal.aborted).toBe(true);
});

it("binds private runs to the exact requesting member and runtime bundle", () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	const privateIdentity = {
		...authority.identity,
		audienceKind: "member_private" as const,
		audienceUserId: authority.identity.requesterUserId,
	};
	expect(parseCloudNativeToolAuthority({ ...authority, identity: privateIdentity }, binding).identity).toEqual(
		privateIdentity,
	);
	for (const patch of [
		{ audienceUserId: authority.identity.sponsorUserId },
		{ audienceKind: "company", audienceUserId: authority.identity.requesterUserId },
		{ runtimeBundleSha256: "z".repeat(64) },
	])
		expect(() =>
			parseCloudNativeToolAuthority({ ...authority, identity: { ...privateIdentity, ...patch } }, binding),
		).toThrow();
});

it("bounds an uncooperative authority transport before admission, asking again within the authority window", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<CloudNativeToolAuthorityReader["describeToolAuthority"]>(
		async () => new Promise<never>(() => undefined),
	);
	const opened = CloudNativeToolRun.open(binding, { describeToolAuthority: request }, new AbortController().signal);
	const rejected = expect(opened).rejects.toThrow("Cloud tool authority unavailable");
	// The first attempt waits 5 s, and each one cut at its deadline gives the next twice as long, pausing 250 ms doubling
	// to 2 s, all within the 30 s window from the first: attempts start at 0, 5.25 and 15.75 s, and the third, given
	// 20 s, is cut at the window's end (30 s).
	for (let step = 0; step < 130; step += 1) {
		now += 250;
		await vi.advanceTimersByTimeAsync(250);
	}
	await rejected;
	expect(request).toHaveBeenCalledTimes(3);
	expect(request.mock.calls.every((call) => call[1].aborted)).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("ends every attempt at admission within the 30 s window, a late one too", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const { binding } = nativeToolAuthorityFixture();
	// Fast failures until 29 s; the attempt after that (at 29.75 s) never answers: it is cut at 30 s, not at 34.75 s.
	const request = vi.fn<CloudNativeToolAuthorityReader["describeToolAuthority"]>(async () => {
		if (now < 29_000) throw new CloudRuntimeDiagnosticError("transport_unavailable");
		return new Promise<never>(() => undefined);
	});
	const opened = CloudNativeToolRun.open(binding, { describeToolAuthority: request }, new AbortController().signal);
	let settled = false;
	const rejected = expect(
		opened.finally(() => {
			settled = true;
		}),
	).rejects.toThrow("Cloud tool authority unavailable");
	for (let step = 0; step < 121 && !settled; step += 1) {
		now += 250;
		await vi.advanceTimersByTimeAsync(250);
	}
	await rejected;
	expect(now).toBeLessThanOrEqual(30_250);
	expect(vi.getTimerCount()).toBe(0);
});

it("asks a lost or late authority read again and keeps the run (control calls, 4 Oct 2026)", async () => {
	vi.useFakeTimers();
	const { run, reader, authority } = await admit();
	// A gateway error, then a read slower than its 5 s, then the answer: the run never closes.
	reader.describeToolAuthority
		.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("transport_unavailable"))
		.mockImplementationOnce(async () => new Promise<never>(() => undefined))
		.mockResolvedValueOnce(structuredClone(authority));
	const check = run.assertActive(run.signal);
	await vi.advanceTimersByTimeAsync(250);
	await vi.advanceTimersByTimeAsync(5_000);
	await vi.advanceTimersByTimeAsync(500);
	await expect(check).resolves.toBeUndefined();
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(4);
	expect(run.signal.aborted).toBe(false);
});

it("closes at once on a refusal, and asks no more once the authority would lapse", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const fixture = nativeToolAuthorityFixture();
	const reader = { describeToolAuthority: vi.fn(async () => ({ ...fixture.authority, validForMs: 2000 })) };
	const run = await CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal);
	runs.push(run);
	// Transient failures are asked again only while the authority read at 0 holds (2 s).
	reader.describeToolAuthority.mockRejectedValue(new CloudRuntimeDiagnosticError("transport_unavailable"));
	const check = run.assertActive(run.signal);
	const rejected = expect(check).rejects.toThrow("Cloud tool authority unavailable");
	for (let step = 0; step < 12; step += 1) {
		now += 250;
		await vi.advanceTimersByTimeAsync(250);
	}
	await rejected;
	expect(run.signal.aborted).toBe(true);
	expect(reader.describeToolAuthority.mock.calls.length).toBeLessThan(10);
	// A refused read is never asked again.
	const second = await admit();
	second.reader.describeToolAuthority.mockRejectedValueOnce(
		new CloudControlRpcRefused("55000", "Company execution is paused"),
	);
	await expect(second.run.assertActive(second.run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(second.reader.describeToolAuthority).toHaveBeenCalledTimes(2);
	expect(second.run.signal.aborted).toBe(true);
});

it("keeps a model request's fence asking while a slow database answers, for as long as the lease holds (5 Oct 2026)", async () => {
	const clock = fakeClock();
	const { run, reader, authority } = await admit();
	// The database answers the fence's reads only at 40 s, past the 30 s authority read at the start; the run's refresh
	// keeps renewing it. Attempts are cut at 10 s and then 20 s; the third (from 30.75 s) gets the answer.
	const fence = vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () =>
		after(Math.max(0, 40_000 - clock.now), structuredClone(authority)),
	);
	let settled = false;
	const fenced = run.assertActiveWith(fence, run.signal, CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS).finally(() => {
		settled = true;
	});
	for (let second = 0; second < 50 && !settled; second += 1) await clock.tick(1_000);
	await expect(fenced).resolves.toBe(true);
	expect(clock.now).toBeGreaterThanOrEqual(40_000);
	expect(fence).toHaveBeenCalledTimes(3);
	expect(reader.describeToolAuthority.mock.calls.length).toBeGreaterThanOrEqual(4);
	expect(run.signal.aborted).toBe(false);
	// Its answer renewed the authority as a refresh does: the run goes on.
	await clock.tick(25_000);
	expect(run.signal.aborted).toBe(false);
});

it("gives a fence read slower than one attempt twice as long next, so it lands behind the one it cut (6 Oct 2026)", async () => {
	const clock = fakeClock();
	const { run, authority } = await admit();
	// Every fence read takes 12 s, and the database runs them one after another: the first attempt's read goes on
	// after it is cut at 10 s, and the second (from 10.25 s) waits for it before its own 12 s. Given 20 s, it lands at
	// 24 s; given 10 s again, every attempt would be cut and the fence would never land. This models a delay outside
	// the statement (a connection pool wait): in the database each attempt is one statement under the native host
	// entry's 8 s budget, which a cancelled attempt does not grow.
	let busyUntil = 0;
	const fence = vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () => {
		busyUntil = Math.max(clock.now, busyUntil) + 12_000;
		return after(busyUntil - clock.now, structuredClone(authority));
	});
	let settled = false;
	const fenced = run.assertActiveWith(fence, run.signal, CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS).finally(() => {
		settled = true;
	});
	for (let second = 0; second < 50 && !settled; second += 1) await clock.tick(1_000);
	await expect(fenced).resolves.toBe(true);
	expect(fence).toHaveBeenCalledTimes(2);
	expect(clock.now).toBeGreaterThanOrEqual(24_000);
	expect(clock.now).toBeLessThan(30_000);
	expect(run.signal.aborted).toBe(false);
});

it("never lets an older fence answer shorten the authority a later refresh read, but still closes on a changed identity", async () => {
	const clock = fakeClock();
	const { run, reader, authority } = await admit();
	await clock.tick(5_000);
	// A fence read starts at 5 s and sees 8 s left (a lease near its end); the refresh at 10 s reads 30 s. The fence's
	// answer arrives at 12 s: applied, it would end the run at 13 s.
	let answer: ((value: unknown) => void) | undefined;
	const fence = vi.fn<(signal: AbortSignal) => Promise<unknown>>(
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
	);
	const fenced = run.assertActiveWith(fence, run.signal, CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS);
	await clock.tick(7_000);
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(2);
	answer?.({ ...structuredClone(authority), validForMs: 8_000 });
	await expect(fenced).resolves.toBe(true);
	await clock.tick(3_000);
	expect(run.signal.aborted).toBe(false);
	// The identity is checked before the order: an older answer with another identity still closes the run (the same
	// timeline, from 15 s).
	const second = await admit();
	await clock.tick(5_000);
	const stale = second.run.assertActiveWith(
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
		second.run.signal,
		CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS,
	);
	const rejected = expect(stale).rejects.toThrow("Cloud tool authority unavailable");
	await clock.tick(7_000);
	expect(second.reader.describeToolAuthority).toHaveBeenCalledTimes(2);
	answer?.({ ...structuredClone(second.authority), identity: { ...second.authority.identity, sessionId: null } });
	await rejected;
	expect(second.run.signal.aborted).toBe(true);
});

it("stops a model request's fence at once when the run's authority is lost meanwhile", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const { run, reader } = await admit();
	now = 1_000;
	await vi.advanceTimersByTimeAsync(1_000);
	// The fence's read hangs from 1 s; the refresh at 10 s is refused: the run stops, and with it the fence's attempt.
	const fence = vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () => new Promise<never>(() => undefined));
	const fenced = run.assertActiveWith(fence, run.signal, CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS);
	const rejected = expect(fenced).rejects.toThrow("Cloud tool authority unavailable");
	reader.describeToolAuthority.mockRejectedValue(new CloudControlRpcRefused("55000", "Company execution is paused"));
	for (let step = 0; step < 200; step += 1) {
		now += 50;
		await vi.advanceTimersByTimeAsync(50);
	}
	await rejected;
	expect(run.signal.aborted).toBe(true);
	expect(fence).toHaveBeenCalledTimes(1);
	expect(now).toBeLessThan(12_000);
});

it("retains the independent lease deadline while refresh is stalled", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const fixture = nativeToolAuthorityFixture();
	const reader = { describeToolAuthority: vi.fn(async () => ({ ...fixture.authority, validForMs: 2000 })) };
	const run = await CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal);
	runs.push(run);
	reader.describeToolAuthority.mockImplementationOnce(async () => new Promise<never>(() => undefined));
	now = 1000;
	await vi.advanceTimersByTimeAsync(1000);
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(2);
	expect(run.signal.aborted).toBe(false);
	now = 2000;
	await vi.advanceTimersByTimeAsync(1000);
	expect(run.signal.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("subtracts request time and rejects an authority response already expired on arrival", async () => {
	const fixture = nativeToolAuthorityFixture();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const reader = {
		describeToolAuthority: vi.fn(async () => {
			now = 101;
			return { ...fixture.authority, validForMs: 100 };
		}),
	};
	await expect(CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal)).rejects.toThrow(
		"Cloud tool authority unavailable",
	);
});

it("does not use the wall clock to extend a deadline", async () => {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const { run, reader } = await admit();
	vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
	now = 30_001;
	await expect(run.assertActive(run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(reader.describeToolAuthority).toHaveBeenCalledTimes(1);
	expect(run.signal.aborted).toBe(true);
});

it("does not revive when a late authority reply arrives after cancellation", async () => {
	const { run, reader, authority, abort } = await admit();
	let reply: ((value: typeof authority) => void) | undefined;
	reader.describeToolAuthority.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				reply = resolve;
			}),
	);
	const check = run.assertActive(run.signal);
	const rejected = expect(check).rejects.toThrow("Cloud tool authority unavailable");
	await vi.waitFor(() => expect(reply).toBeDefined());
	abort.abort();
	await rejected;
	reply?.(authority);
	await Promise.resolve();
	expect(run.signal.aborted).toBe(true);
});

it("does not call a transport after pre-cancellation", async () => {
	const abort = new AbortController();
	abort.abort();
	const operation = vi.fn(async () => "unexpected");
	await expect(cloudToolRequest(operation, abort.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(operation).not.toHaveBeenCalled();
});

it("holds another call's authority read to assertActive's checks, before and after it", async () => {
	const { run, authority, abort } = await admit();
	// The database lacks the call: nothing changes, and the run stays open.
	await expect(run.assertActiveWith(async () => undefined, abort.signal)).resolves.toBe(false);
	expect(run.signal.aborted).toBe(false);
	// Its answer: accepted like describe's own.
	const read = vi.fn(async () => structuredClone(authority) as unknown);
	await expect(run.assertActiveWith(read, abort.signal)).resolves.toBe(true);
	// Another identity closes the run.
	await expect(
		run.assertActiveWith(
			async () => ({ ...structuredClone(authority), identity: { ...authority.identity, sessionId: null } }),
			abort.signal,
		),
	).rejects.toThrow("Cloud tool authority unavailable");
	expect(run.signal.aborted).toBe(true);
	// A closed run sends nothing.
	await expect(run.assertActiveWith(read, abort.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(read).toHaveBeenCalledOnce();
});
