import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CloudControlRpcEnded, CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import {
	CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS,
	CLOUD_PAIRED_REQUEST_TIMEOUT_MS,
	CLOUD_RUN_ROW_LONG_READ_MS,
	CLOUD_RUN_ROW_READ_MS,
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

async function admit(holdMs?: number, runRowMs?: number) {
	const fixture = nativeToolAuthorityFixture();
	const reader = {
		describeToolAuthority: vi.fn(async () => structuredClone(fixture.authority)),
		...(runRowMs === undefined ? {} : { runRowMs }),
	};
	const abort = new AbortController();
	const run = await CloudNativeToolRun.open(fixture.binding, reader, abort.signal, holdMs);
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

it("holds a run through a short control-plane outage that closes an unheld one at its window (WB-001, 28 Oct 2026)", async () => {
	const clock = fakeClock();
	const unheld = await admit();
	const held = await admit(120_000);
	// The control plane goes away 6 s after the last read and is back at 29 s, and a read sent meanwhile hangs (WB-001:
	// last good read 16:04:46.9Z, outage about 16:04:53 to 16:05:16Z). The refresh at 10 s is cut at 15 s, the next
	// read at 25.25 s, and the one from 25.75 s is still hanging when the unheld run's window ends at 30 s.
	for (const { reader, authority } of [unheld, held])
		reader.describeToolAuthority.mockImplementation(async () =>
			clock.now >= 6_000 && clock.now < 29_000 ? new Promise<never>(() => undefined) : structuredClone(authority),
		);
	await clock.tick(29_500);
	expect(unheld.run.signal.aborted).toBe(false);
	expect(held.run.signal.aborted).toBe(false);
	await clock.tick(1_000);
	expect(unheld.run.signal.aborted).toBe(true);
	expect(held.run.signal.aborted).toBe(false);
	// The held run's read from 25.75 s is cut at 45.75 s; the next, at 46.75 s, answers, and the run goes on.
	await clock.tick(120_000);
	expect(held.run.signal.aborted).toBe(false);
	expect(held.reader.describeToolAuthority.mock.calls.length).toBeGreaterThan(10);
});

it("still closes a held run when the hold ends with the control plane away", async () => {
	const clock = fakeClock();
	const { run, reader } = await admit(120_000);
	reader.describeToolAuthority.mockRejectedValue(new CloudRuntimeDiagnosticError("transport_unavailable"));
	await clock.tick(119_000);
	expect(run.signal.aborted).toBe(false);
	await clock.tick(1_500);
	expect(run.signal.aborted).toBe(true);
});

it("closes a held run at once on a refusal, and at a nearer end the cloud answers", async () => {
	const clock = fakeClock();
	const refused = await admit(120_000);
	refused.reader.describeToolAuthority.mockRejectedValue(
		new CloudControlRpcRefused("55000", "Company execution is paused"),
	);
	await clock.tick(10_500);
	expect(refused.run.signal.aborted).toBe(true);
	expect(refused.reader.describeToolAuthority).toHaveBeenCalledTimes(2);
	// An answer under the window (a lease or the run's deadline within it) is kept as answered, not held.
	const fixture = nativeToolAuthorityFixture();
	const reader = { describeToolAuthority: vi.fn(async () => ({ ...fixture.authority, validForMs: 2_000 })) };
	const run = await CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal, 120_000);
	runs.push(run);
	reader.describeToolAuthority.mockRejectedValue(new CloudRuntimeDiagnosticError("transport_unavailable"));
	await clock.tick(1_000);
	expect(run.signal.aborted).toBe(false);
	await clock.tick(1_100);
	expect(run.signal.aborted).toBe(true);
});

it.each([29_999, 1.5, Number.NaN, 2 ** 53])(
	"rejects a hold shorter than the window or not a whole number: %d",
	async (holdMs) => {
		const fixture = nativeToolAuthorityFixture();
		const reader = { describeToolAuthority: vi.fn(async () => structuredClone(fixture.authority)) };
		await expect(
			CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal, holdMs),
		).rejects.toThrow("Cloud tool authority hold is invalid");
		expect(reader.describeToolAuthority).not.toHaveBeenCalled();
	},
);

it("keeps a model request's fence asking while a slow database answers, for as long as the lease holds (5 Oct 2026)", async () => {
	const clock = fakeClock();
	const { run, reader, authority } = await admit();
	// The database answers the fence's reads only at 40 s, past the 30 s authority read at the start; the run's refresh
	// keeps renewing it. The first attempt (37 s, as long as the database may run it: R1) is cut at 30 s, where the
	// authority read at its start ends; the second (from 30.25 s) gets the answer.
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
	expect(fence).toHaveBeenCalledTimes(2);
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
	// 24 s; given 10 s again, every attempt would be cut and the fence would never land. In the database each attempt
	// is one statement under the long entry point's 25 s budget (20260930109500), which a cancelled attempt does not
	// grow: 12 s fits it, and so does a delay outside the statement (a connection pool wait). (The fence's own first
	// attempt waits 37 s since R1; a 10 s one shows the doubling.)
	let busyUntil = 0;
	const fence = vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () => {
		busyUntil = Math.max(clock.now, busyUntil) + 12_000;
		return after(busyUntil - clock.now, structuredClone(authority));
	});
	let settled = false;
	const fenced = run.assertActiveWith(fence, run.signal, 10_000).finally(() => {
		settled = true;
	});
	for (let second = 0; second < 50 && !settled; second += 1) await clock.tick(1_000);
	await expect(fenced).resolves.toBe(true);
	expect(fence).toHaveBeenCalledTimes(2);
	expect(clock.now).toBeGreaterThanOrEqual(24_000);
	expect(clock.now).toBeLessThan(30_000);
	expect(run.signal.aborted).toBe(false);
});

/** A read of the run's row through `retry` (or the fence's `assertActiveWith`) whose calls fail as `fail(call)` says
 * (undefined answers), with the times its calls began. Its first copy is sent before it returns, so at the clock's
 * time: the transport sends it a microtask later, after the next tick would have moved the clock. */
async function rowRead(
	run: CloudNativeToolRun,
	authority: unknown,
	clock: { now: number },
	fail: (call: number) => { at: number; error: unknown } | "hang" | undefined,
	fence?: boolean,
) {
	const starts: number[] = [];
	const read = vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () => {
		starts.push(clock.now);
		const failure = fail(starts.length);
		if (failure === "hang") return new Promise<never>(() => undefined);
		if (!failure) return structuredClone(authority);
		await after(failure.at, undefined);
		throw failure.error;
	});
	let settled = false;
	const sent: Promise<unknown> = fence
		? run.assertActiveWith(read, run.signal, CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS, CLOUD_RUN_ROW_LONG_READ_MS)
		: run.retry(read, run.signal, CLOUD_RUN_ROW_READ_MS, CLOUD_RUN_ROW_READ_MS);
	const result = sent.finally(() => {
		settled = true;
	});
	result.catch(() => undefined);
	await Promise.resolve();
	return { starts, read, result, settled: () => settled };
}

it("sends a read of the run's row again only once the copy it replaces may have ended (R1, 28 Oct 2026)", async () => {
	const clock = fakeClock();
	const { run, authority } = await admit(120_000);
	// A copy cut at its deadline has had all the time the database may give it: the next follows after the pause.
	const hanging = await rowRead(run, authority, clock, (call) => (call <= 2 ? "hang" : undefined));
	for (let second = 0; second < 90 && !hanging.settled(); second += 1) await clock.tick(1_000);
	await expect(hanging.result).resolves.toMatchObject({ started: hanging.starts[2] });
	expect(hanging.starts).toEqual([0, 20_250, 60_750]);
	// A copy whose answer was lost after 1 s (a reset connection, a proxy's 502: nothing says its statement ended) may
	// still wait for the row: the next is sent 20 s after it was, not 250 ms after the loss.
	const lost = await rowRead(run, authority, clock, (call) =>
		call === 1 ? { at: 1_000, error: new CloudRuntimeDiagnosticError("transport_unavailable") } : undefined,
	);
	const begun = clock.now;
	for (let second = 0; second < 30 && !lost.settled(); second += 1) await clock.tick(1_000);
	await expect(lost.result).resolves.toBeDefined();
	expect(lost.starts.map((start) => start - begun)).toEqual([0, CLOUD_RUN_ROW_READ_MS]);
	// The fence waits out its 37 s, here after a copy its transport cut at 1 s.
	const fence = await rowRead(
		run,
		authority,
		clock,
		(call) => (call === 1 ? { at: 1_000, error: new CloudRuntimeDiagnosticError("timeout") } : undefined),
		true,
	);
	const fenceBegun = clock.now;
	for (let second = 0; second < 60 && !fence.settled(); second += 1) await clock.tick(1_000);
	await expect(fence.result).resolves.toBe(true);
	expect(fence.starts.map((start) => start - fenceBegun)).toEqual([0, CLOUD_RUN_ROW_LONG_READ_MS]);
	expect(run.signal.aborted).toBe(false);
});

it("asks a read of the run's row again at once when the database answered that the copy ended, and never a refusal", async () => {
	const clock = fakeClock();
	const { run, authority } = await admit(120_000);
	// A lock wait the database gave up (55P03 from a PostgREST body), or PostgREST's own pool wait: F1's 250 ms.
	const ended = await rowRead(run, authority, clock, (call) =>
		call === 1 ? { at: 3_000, error: new CloudControlRpcEnded() } : undefined,
	);
	for (let second = 0; second < 10 && !ended.settled(); second += 1) await clock.tick(500);
	await expect(ended.result).resolves.toBeDefined();
	expect(ended.starts).toEqual([0, 3_250]);
	// A refusal is never asked again.
	const refused = await rowRead(run, authority, clock, () => ({
		at: 100,
		error: new CloudControlRpcRefused("55000", "Company execution is paused"),
	}));
	for (let second = 0; second < 4 && !refused.settled(); second += 1) await clock.tick(500);
	await expect(refused.result).rejects.toBeInstanceOf(CloudControlRpcRefused);
	expect(refused.read).toHaveBeenCalledOnce();
});

/** A held run opened at the clock's time whose reader takes the run's row (`runRowMs`) or not. Its checks after the
 * opening one answer as `answer(call)` says (from 1): after `at` ms, failing with `error` when it has one, or never
 * ("hang"); `starts` has the times they began, from the opening. */
async function checkedRun(
	clock: { now: number },
	runRowMs: number | undefined,
	answer: (call: number) => { at: number; error?: unknown } | "hang" | undefined,
) {
	const { run, reader, authority } = await admit(120_000, runRowMs);
	const opened = clock.now;
	const starts: number[] = [];
	reader.describeToolAuthority.mockImplementation(async () => {
		starts.push(clock.now - opened);
		const planned = answer(starts.length);
		if (planned === "hang") return new Promise<never>(() => undefined);
		if (planned) await after(planned.at, undefined);
		if (planned?.error !== undefined) throw planned.error;
		return structuredClone(authority);
	});
	return { run, starts };
}

it("waits out a lost copy of the run's own check when its reader takes the run's row (R2, 31 Oct 2026)", async () => {
	const clock = fakeClock();
	// The refresh at 10 s loses its answer after 1 s (a reset connection, a proxy's 502: nothing says its statement
	// ended): the copy may still wait for the row, so the check is asked again 20 s after it was sent, not after the
	// pause. One that never answers is cut only after those 20 s, its attempt's length, and asked again after the pause.
	for (const { planned, next } of [
		{ planned: { at: 1_000, error: new CloudRuntimeDiagnosticError("transport_unavailable") }, next: 30_000 },
		{ planned: "hang" as const, next: 30_250 },
	]) {
		const checked = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, (call) => (call === 1 ? planned : undefined));
		await clock.tick(35_000);
		expect(checked.starts.slice(0, 2)).toEqual([10_000, next]);
		expect(checked.run.signal.aborted).toBe(false);
		checked.run.close();
	}
	// A copy the database answered ended (a lock wait it gave up, 55P03) is asked again after the pause.
	const ended = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, (call) =>
		call === 1 ? { at: 3_000, error: new CloudControlRpcEnded() } : undefined,
	);
	await clock.tick(15_000);
	expect(ended.starts.slice(0, 2)).toEqual([10_000, 13_250]);
	expect(ended.run.signal.aborted).toBe(false);
});

it("asks the run's own check again after the pause, as before, when its reader does not take the run's row", async () => {
	const clock = fakeClock();
	const lost = await checkedRun(clock, undefined, (call) =>
		call === 1 ? { at: 1_000, error: new CloudRuntimeDiagnosticError("transport_unavailable") } : undefined,
	);
	await clock.tick(12_000);
	expect(lost.starts.slice(0, 2)).toEqual([10_000, 11_250]);
	lost.run.close();
	const cut = await checkedRun(clock, undefined, (call) => (call === 1 ? "hang" : undefined));
	await clock.tick(16_000);
	expect(cut.starts.slice(0, 2)).toEqual([10_000, 15_250]);
	expect(cut.run.signal.aborted).toBe(false);
});

it("closes a run whose reader takes the run's row at once on a refusal, and at its hold's end with every copy lost", async () => {
	const clock = fakeClock();
	const refused = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, (call) =>
		call === 1 ? { at: 100, error: new CloudControlRpcRefused("55000", "Company execution is paused") } : undefined,
	);
	await clock.tick(10_500);
	expect(refused.run.signal.aborted).toBe(true);
	expect(refused.starts).toEqual([10_000]);
	// Every check after the opening loses its answer after 1 s: one copy at a time, each sent 20 s after the one before,
	// and the run still closes when its hold, 120 s from the opening read, ends.
	const away = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, () => ({
		at: 1_000,
		error: new CloudRuntimeDiagnosticError("transport_unavailable"),
	}));
	await clock.tick(119_000);
	expect(away.run.signal.aborted).toBe(false);
	await clock.tick(1_500);
	expect(away.run.signal.aborted).toBe(true);
	expect(away.starts).toEqual([10_000, 30_000, 50_000, 70_000, 90_000, 110_000]);
});

it("gives each of the run's own checks as long as the database may run it when its reader takes the run's row (R2)", async () => {
	const clock = fakeClock();
	// The opening read answers after 12 s, within the 20 s the database may run it: it lands. Cut at 5 s and waited out
	// to 20 s, the opening's 30 s would end before another attempt answered.
	const fixture = nativeToolAuthorityFixture();
	const reader = {
		describeToolAuthority: vi.fn(() => after(12_000, structuredClone(fixture.authority))),
		runRowMs: CLOUD_RUN_ROW_READ_MS,
	};
	const opened = CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal, 120_000);
	await clock.tick(12_000);
	runs.push(await opened);
	expect(reader.describeToolAuthority).toHaveBeenCalledOnce();
	// The refresh at 10 s answers after 12 s: it lands at 22 s, and the next goes out 10 s later. Cut at 5 s, it would be
	// asked again at 30 s and 50 s and land only at 62 s, with every tool step's check queued behind it.
	const slow = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, (call) => (call === 1 ? { at: 12_000 } : undefined));
	await clock.tick(33_000);
	expect(slow.starts.slice(0, 2)).toEqual([10_000, 32_000]);
	expect(slow.run.signal.aborted).toBe(false);
	slow.run.close();
	// A check sent with another read of the run (its 10 s) waits as long too.
	const paired = await checkedRun(clock, CLOUD_RUN_ROW_READ_MS, (call) => (call === 1 ? { at: 15_000 } : undefined));
	const from = clock.now;
	let landed: number | undefined;
	const check = paired.run.assertActive(paired.run.signal, CLOUD_PAIRED_REQUEST_TIMEOUT_MS).then(() => {
		landed = clock.now - from;
	});
	await clock.tick(21_000);
	await check;
	// Within a clock step; cut at 10 s, it would be waited out and land only at 20 s.
	expect(landed).toBeGreaterThanOrEqual(15_000);
	expect(landed).toBeLessThanOrEqual(15_050);
	expect(paired.starts.filter((at) => at < 15_000)).toHaveLength(1);
});

it("gives up an opening at once when waiting out its reader's lost copy would pass the 30 s window (R2)", async () => {
	const clock = fakeClock();
	// Each read of the row loses its answer after 1 s. The copy sent at 0 is waited out to 20 s; waiting out the one sent
	// at 20 s would pass the window (30 s), which nothing extends before the first authority: the opening fails at 21 s,
	// not after sleeping to 40 s.
	const fixture = nativeToolAuthorityFixture();
	const starts: number[] = [];
	const reader = {
		describeToolAuthority: vi.fn(async () => {
			starts.push(clock.now);
			await after(1_000, undefined);
			throw new CloudRuntimeDiagnosticError("transport_unavailable");
		}),
		runRowMs: CLOUD_RUN_ROW_READ_MS,
	};
	let failed: number | undefined;
	const opened = CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal).catch(
		(error: unknown) => {
			failed = clock.now;
			throw error;
		},
	);
	const rejected = expect(opened).rejects.toThrow("Cloud tool authority unavailable");
	await clock.tick(41_000);
	await rejected;
	// From the first read.
	const first = starts[0] ?? Number.NaN;
	expect(starts.map((at) => at - first)).toEqual([0, 20_000]);
	expect((failed ?? Number.NaN) - first).toBe(21_000);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 1.5, Number.NaN, 300_001])(
	"rejects a reader's run row wait that is not a whole number up to 300 s: %d",
	async (runRowMs) => {
		const fixture = nativeToolAuthorityFixture();
		const reader = { describeToolAuthority: vi.fn(async () => structuredClone(fixture.authority)), runRowMs };
		await expect(CloudNativeToolRun.open(fixture.binding, reader, new AbortController().signal)).rejects.toThrow(
			"Cloud tool authority reader is invalid",
		);
		expect(reader.describeToolAuthority).not.toHaveBeenCalled();
	},
);

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
