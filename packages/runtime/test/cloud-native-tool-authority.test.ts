import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	type CloudNativeToolAuthorityReader,
	CloudNativeToolRun,
	cloudToolRequest,
	parseCloudNativeToolAuthority,
	parseCloudNativeToolBinding,
} from "@qorpera/runtime/cloud-native-tool-authority";
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

it("carries the run's service tier, which only a fast mode bundle names", () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	for (const serviceTier of ["fast", "standard"])
		expect(
			parseCloudNativeToolAuthority({ ...authority, identity: { ...authority.identity, serviceTier } }, binding)
				.identity.serviceTier,
		).toBe(serviceTier);
	const { serviceTier: _named, ...older } = authority.identity;
	const parsed = parseCloudNativeToolAuthority({ ...authority, identity: older }, binding);
	expect(Object.hasOwn(parsed.identity, "serviceTier")).toBe(false);
	for (const serviceTier of ["priority", "default", null, true])
		expect(() =>
			parseCloudNativeToolAuthority({ ...authority, identity: { ...authority.identity, serviceTier } }, binding),
		).toThrow();
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

it("bounds an uncooperative authority transport before admission", async () => {
	vi.useFakeTimers();
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<CloudNativeToolAuthorityReader["describeToolAuthority"]>(
		async () => new Promise<never>(() => undefined),
	);
	const opened = CloudNativeToolRun.open(binding, { describeToolAuthority: request }, new AbortController().signal);
	const rejected = expect(opened).rejects.toThrow("Cloud tool authority unavailable");
	await vi.advanceTimersByTimeAsync(5000);
	await rejected;
	expect(request.mock.calls[0]?.[1].aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
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
