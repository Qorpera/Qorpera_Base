import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	GITHUB_WEBHOOK_MAX_BYTES,
	type GitHubDeliveryReceipt,
	type GitHubListenerAdapters,
	type GitHubListenerBinding,
	handleGitHubRoutineWebhook,
	type VerifiedGitHubDelivery,
	verifyGitHubWebhook,
} from "../src/github-routine-listener.ts";
import { compileRoutineTrigger, type GitHubRoutineListener, parseRoutinePolicy } from "../src/routine-policy.ts";

const secret = Buffer.from("test-only-webhook-secret-never-a-credential");
const payload = JSON.parse(
	readFileSync(new URL("./fixtures/github-pull-request.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const policy = parseRoutinePolicy(
	JSON.parse(readFileSync(new URL("./fixtures/routine-policy.json", import.meta.url), "utf8")),
);
const listener: GitHubRoutineListener = {
	id: "github-pr",
	kind: "listener",
	source: "github",
	timeZone: "UTC",
	connectionId: "80000000-0000-4000-8000-000000000002",
	installationId: "987654",
	repositoryId: "1296269",
	events: ["pull_request.opened", "pull_request.updated", "pull_request.merged", "pull_request.review_requested"],
	actors: { mode: "allowlist", ids: ["123456"] },
	delivery: { maxAgeSeconds: 86400, maxFutureSkewSeconds: 60, reordered: "drop-older" },
};
const binding: GitHubListenerBinding = {
	routineId: "80000000-0000-4000-8000-000000000001",
	version: 1,
	epoch: 1,
	activeSince: "2026-08-28T09:00:00.000Z",
	status: "active",
	suspended: false,
	trigger: listener,
	policy,
};
const now = "2026-08-28T10:01:00.000Z";
const receipt: GitHubDeliveryReceipt = {
	schema: "qorpera.github-delivery-receipt/v1",
	status: "admitted",
	occurrenceId: "80000000-0000-4000-8000-000000000003",
};

function request(value: unknown = payload, headers: Record<string, string> = {}): Request {
	const body = typeof value === "string" ? value : JSON.stringify(value);
	return new Request("https://hooks.example.test/github/opaque-route", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-github-event": "pull_request",
			"x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
			...headers,
		},
	});
}
function adapters() {
	return {
		resolveWebhookSecret: vi.fn(async () => secret),
		admit: vi.fn(async (_delivery: VerifiedGitHubDelivery) => receipt),
	};
}

describe("GitHub webhook verification and bounds", () => {
	it("verifies exact raw UTF-8 bytes, including non-ASCII", () => {
		const body = Buffer.from('{"title":"Æøå"}');
		const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		expect(verifyGitHubWebhook(body, signature, secret)).toBe(true);
		for (const invalid of [null, "sha1=123", `${signature},${signature}`, signature.toUpperCase()])
			expect(verifyGitHubWebhook(body, invalid, secret)).toBe(false);
		expect(verifyGitHubWebhook(Buffer.concat([body, Buffer.from(" ")]), signature, secret)).toBe(false);
		expect(verifyGitHubWebhook(body, signature, Buffer.from("different"))).toBe(false);
	});
	it("authenticates before parsing and never reflects a secret in errors", async () => {
		const control = adapters();
		expect(
			(
				await handleGitHubRoutineWebhook(
					request("not-json", { "x-hub-signature-256": `sha256=${"a".repeat(64)}` }),
					binding,
					control,
					now,
				)
			).status,
		).toBe(401);
		expect(control.admit).not.toHaveBeenCalled();
		control.resolveWebhookSecret.mockRejectedValueOnce(new Error(`Secret: ${secret}`));
		const response = await handleGitHubRoutineWebhook(request(), binding, control, now);
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
	});
	it("requires explicit adapters and ignores neither authorization nor a failed transaction", async () => {
		expect((await handleGitHubRoutineWebhook(request(), binding, undefined, now)).status).toBe(503);
		expect((await handleGitHubRoutineWebhook(request(), undefined, adapters(), now)).status).toBe(503);
		const control = adapters();
		control.admit.mockRejectedValueOnce(new Error("Step 3 ingress unavailable"));
		expect((await handleGitHubRoutineWebhook(request(), binding, control, now)).status).toBe(503);
	});
	it("bounds bytes even without content-length and rejects compressed bodies", async () => {
		const control = adapters();
		for (const req of [
			request("x".repeat(GITHUB_WEBHOOK_MAX_BYTES + 1)),
			request(payload, { "content-length": String(GITHUB_WEBHOOK_MAX_BYTES + 1) }),
		])
			expect((await handleGitHubRoutineWebhook(req, binding, control, now)).status).toBe(413);
		expect(
			(await handleGitHubRoutineWebhook(request(payload, { "content-encoding": "gzip" }), binding, control, now))
				.status,
		).toBe(415);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it("bounds JSON depth and node count before normalization", async () => {
		const control = adapters();
		const deeplyNested = `${"[".repeat(40)}1${"]".repeat(40)}`;
		expect((await handleGitHubRoutineWebhook(request(deeplyNested), binding, control, now)).status).toBe(413);
		expect(
			(
				await handleGitHubRoutineWebhook(
					request({ ...payload, extra: Array.from({ length: 17000 }, () => null) }),
					binding,
					control,
					now,
				)
			).status,
		).toBe(413);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it("cancels a slow body without waiting for a malicious cancellation hook", async () => {
		const controller = new AbortController();
		const stream = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => undefined) });
		const req = new Request(request(), { body: stream, signal: controller.signal, duplex: "half" } as RequestInit);
		const pending = handleGitHubRoutineWebhook(req, binding, adapters(), now);
		controller.abort();
		expect((await pending).status).toBeOneOf([408, 400]);
	});
	it("rejects malformed delivery identity and duplicated headers", async () => {
		const invalidHeaders: Record<string, string>[] = [
			{ "x-github-delivery": "not-an-id" },
			{ "x-github-event": "pull_request,push" },
			{ "x-hub-signature-256": `sha256=${"a".repeat(64)},sha256=${"a".repeat(64)}` },
		];
		for (const headers of invalidHeaders)
			expect(
				(await handleGitHubRoutineWebhook(request(payload, headers), binding, adapters(), now)).status,
			).toBeGreaterThanOrEqual(400);
	});
	it("bounds an adapter that ignores cancellation without reflecting its state", async () => {
		const controller = new AbortController();
		const control: GitHubListenerAdapters = {
			resolveWebhookSecret: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
			admit: async () => receipt,
		};
		const pending = handleGitHubRoutineWebhook(
			new Request(request(), { signal: controller.signal }),
			binding,
			control,
			now,
		);
		await vi.waitFor(() => expect(control.resolveWebhookSecret).toHaveBeenCalled());
		controller.abort();
		expect((await pending).status).toBe(408);
	});
});

describe("closed normalization, eligibility and durable admission boundary", () => {
	it.each([
		{ state: "open", merged: false },
		{ state: "closed", merged: false },
		{ state: "closed", merged: true },
	])("normalizes edits to a $state PR with merged=$merged", async ({ state, merged }) => {
		const control = adapters();
		// Capture normalization without claiming a successful authority/admission adapter.
		control.admit.mockRejectedValue(new Error("Fixture capture only; admission remains unavailable"));
		const response = await handleGitHubRoutineWebhook(
			request({
				...payload,
				action: "edited",
				changes: { title: { from: "Previous title" }, body: { from: "Previous description" } },
				pull_request: {
					...(payload.pull_request as Record<string, unknown>),
					state,
					merged,
					closed_at: state === "closed" ? "2026-08-28T09:30:00Z" : null,
					merged_at: merged ? "2026-08-28T09:30:00Z" : null,
				},
			}),
			binding,
			control,
			now,
		);
		expect(control.admit).toHaveBeenCalledTimes(1);
		expect(control.admit.mock.calls[0][0].event).toMatchObject({
			event: "pull_request.updated",
			action: "edited",
			trust: "external",
		});
		expect(response.status).toBe(503);
	});
	it.each([
		...["opened", "reopened", "synchronize", "review_requested"].flatMap((action) => [
			{ action, state: "closed", merged: false },
			{ action, state: "closed", merged: true },
		]),
		{ action: "closed", state: "open", merged: false },
		{ action: "closed", state: "open", merged: true },
		{ action: "edited", state: "open", merged: true },
	])("rejects inconsistent $action state=$state merged=$merged", async ({ action, state, merged }) => {
		const control = adapters();
		const response = await handleGitHubRoutineWebhook(
			request({
				...payload,
				action,
				pull_request: { ...(payload.pull_request as Record<string, unknown>), state, merged },
				requested_reviewer: action === "review_requested" ? { id: 42 } : undefined,
			}),
			binding,
			control,
			now,
		);
		expect(response.status).toBe(400);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it("continues to ignore a valid closure without a merge", async () => {
		const control = adapters();
		const response = await handleGitHubRoutineWebhook(
			request({
				...payload,
				action: "closed",
				pull_request: { ...(payload.pull_request as Record<string, unknown>), state: "closed", merged: false },
			}),
			binding,
			control,
			now,
		);
		expect(response.status).toBe(204);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it.each(
		[undefined, null, true, 1, {}, [], ["opened"], ["edited"], [["opened"]], [null]].map((action) => ({ action })),
	)("rejects a non-string action before admission: $action", async ({ action }) => {
		const control = adapters();
		expect((await handleGitHubRoutineWebhook(request({ ...payload, action }), binding, control, now)).status).toBe(
			400,
		);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it.each(["labeled", "assigned", "", "unknown-action"])(
		"still ignores unsupported string action %s",
		async (action) => {
			const control = adapters();
			expect((await handleGitHubRoutineWebhook(request({ ...payload, action }), binding, control, now)).status).toBe(
				204,
			);
			expect(control.admit).not.toHaveBeenCalled();
		},
	);
	it("compiles exactly one GitHub listener without a schedule", () => {
		expect(compileRoutineTrigger([listener], policy)).toEqual(listener);
		for (const changed of [
			{ ...listener, intervalMinutes: 5 },
			{ ...listener, actors: {} },
			{ ...listener, events: ["push"] },
			{ ...listener, timeZone: "auto" },
		])
			expect(() => compileRoutineTrigger([changed], policy)).toThrow();
	});
	it("drops untrusted content and binds numeric repository/installation/actor IDs", async () => {
		const control = adapters();
		expect((await handleGitHubRoutineWebhook(request(), binding, control, now)).status).toBe(202);
		const delivery = control.admit.mock.calls[0][0];
		expect(delivery.event).toMatchObject({
			trust: "external",
			event: "pull_request.opened",
			installationId: "987654",
			repositoryId: "1296269",
			senderId: "123456",
		});
		expect(JSON.stringify(delivery)).not.toContain("Ignore earlier");
		expect(JSON.stringify(delivery)).not.toContain("title");
		expect(Object.isFrozen(delivery.event)).toBe(true);
		expect(Object.isFrozen(delivery)).toBe(true);
	});
	it.each([
		{ installation: { id: 444 } },
		{ repository: { id: 444 } },
		{ sender: { id: 999, login: "fixture-member" } },
		{ sender: { id: 123456, login: "ghost" } },
	])("rejects mismatched eligibility data %o", async (change) => {
		const control = adapters();
		expect((await handleGitHubRoutineWebhook(request({ ...payload, ...change }), binding, control, now)).status).toBe(
			403,
		);
		expect(control.admit).not.toHaveBeenCalled();
	});
	it("cannot round an unsafe numeric identity or accept a forged base repository", async () => {
		const pr = payload.pull_request as Record<string, unknown>;
		expect(
			(
				await handleGitHubRoutineWebhook(
					request({ ...payload, sender: { id: Number.MAX_SAFE_INTEGER + 1 } }),
					binding,
					adapters(),
					now,
				)
			).status,
		).toBe(400);
		expect(
			(
				await handleGitHubRoutineWebhook(
					request({ ...payload, pull_request: { ...pr, base: { repo: { id: 444 } } } }),
					binding,
					adapters(),
					now,
				)
			).status,
		).toBe(403);
	});
	it("uses the signed body to deduplicate even if an unsigned GUID changes or JSON is reordered", async () => {
		const control = adapters();
		await handleGitHubRoutineWebhook(request(), binding, control, now);
		const reordered = Object.fromEntries(Object.entries(payload).reverse());
		await handleGitHubRoutineWebhook(
			request(reordered, { "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0959" }),
			binding,
			control,
			now,
		);
		const first = control.admit.mock.calls[0][0],
			second = control.admit.mock.calls[1][0];
		expect(first.eventKey).toBe(second.eventKey);
		expect(first.deliveryId).not.toBe(second.deliveryId);
		expect(first.bodySha256).not.toBe(second.bodySha256);
	});
	it("normalizes merge and review requests with separate target identities", async () => {
		const pr = payload.pull_request as Record<string, unknown>,
			control = adapters();
		await handleGitHubRoutineWebhook(
			request({ ...payload, action: "closed", pull_request: { ...pr, merged: true, state: "closed" } }),
			binding,
			control,
			now,
		);
		await handleGitHubRoutineWebhook(
			request({ ...payload, action: "review_requested", requested_reviewer: { id: 42 } }),
			binding,
			control,
			now,
		);
		expect(control.admit.mock.calls[0][0].event.event).toBe("pull_request.merged");
		expect(control.admit.mock.calls[1][0].event.reviewTarget).toBe("user:42");
	});
	it("retains durable ignore decisions instead of using a cached policy to discard deliveries", async () => {
		const control = adapters();
		control.admit.mockResolvedValue({ ...receipt, status: "ignored", occurrenceId: null });
		for (const b of [
			{ ...binding, status: "paused" as const },
			{ ...binding, suspended: true },
			{ ...binding, activeSince: "2026-08-28T10:00:00.000Z" },
			{ ...binding, policy: { ...policy, expiresAt: now } },
			{
				...binding,
				policy: { ...policy, quietWindows: [{ weekdays: ["friday" as const], start: "10:00", end: "11:00" }] },
			},
		])
			expect((await handleGitHubRoutineWebhook(request(), b, control, now)).status).toBe(202);
		expect((await handleGitHubRoutineWebhook(request(), binding, control, "2026-08-28T09:58:59.000Z")).status).toBe(
			202,
		);
		expect(control.admit).toHaveBeenCalledTimes(6);
	});
	it("returns a durable denial without accepting the wake", async () => {
		const control: GitHubListenerAdapters = {
			resolveWebhookSecret: async () => secret,
			admit: async () => ({ ...receipt, status: "denied", occurrenceId: null }),
		};
		expect((await handleGitHubRoutineWebhook(request(), binding, control, now)).status).toBe(403);
	});
});
