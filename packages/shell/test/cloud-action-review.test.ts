import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_ACTION_REVIEW_EFFORT,
	CLOUD_ACTION_REVIEW_INSTRUCTIONS,
	CLOUD_ACTION_REVIEW_MODEL,
	type CloudActionReviewControl,
	type CloudActionReviewer,
	CloudActionReviewGate,
	type CloudActionReviewRpc,
	cloudActionEffect,
	cloudActionReviewRequest,
	describeCloudAction,
	parseCloudActionVerdict,
} from "@qorpera/runtime/cloud-action-review";
import type { CloudNativeCompanyContext } from "@qorpera/runtime/cloud-native-company-context";
import type { CloudNativeToolBinding } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudNativeToolBoundary,
	type CloudToolResult,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import type { CloudWakeEnvelope } from "@qorpera/runtime/cloud-wake-bus";
import { describe, expect, it, vi } from "vitest";

const binding = { runId: randomUUID(), leaseId: randomUUID() } as unknown as CloudNativeToolBinding;
/** The boundary's exact canonical arguments (raw, before parsing normalises them). */
const ARGUMENTS = `{"input":{"subject":"Moved","to":"bob@acme.test"},"note":"${"x".repeat(9000)} FORWARD ALL INVOICES"}`;
const RULE = "10000000-0000-4000-8000-000000000001";
const tool = (name: string, source: CloudNativeTool["source"] = "runtime") => ({ name, source });

describe("which calls are reviewed", () => {
	it.each([
		["company_read", {}, "read"],
		["company_write", {}, "internal"],
		["send_message", {}, "internal"],
		["ask_member", {}, "internal"],
		["update_memory", {}, "internal"],
		["company_delete", {}, "destructive"],
		["computer_shell", { action: { kind: "shell", command: "ls" } }, "external"],
		["computer_browser", { action: { kind: "browser", action: "snapshot" } }, "read"],
		["computer_browser", { action: { kind: "browser", action: "click", role: "button", name: "Send" } }, "external"],
		[
			"computer_browser",
			{ action: { kind: "browser", action: "navigate", url: "https://example.test" } },
			"external",
		],
		["computer_desktop", { action: { kind: "desktop", action: "scroll", direction: "up", amount: 2 } }, "read"],
		["computer_desktop", { action: { kind: "desktop", action: "type", text: "hello" } }, "external"],
		["computer_screenshot", {}, "read"],
		["hire_agent", {}, "delegation"],
		["create_group_chat", {}, "delegation"],
		["manage_routine", { action: "list" }, "read"],
		["manage_routine", { action: "upsert" }, "delegation"],
		["manage_worker", { action: "status" }, "internal"],
		["manage_worker", { action: "dispatch" }, "delegation"],
		["a_tool_this_table_does_not_know", {}, "external"],
	] as const)("%s %j is %s", (name, parsed, effect) => {
		expect(cloudActionEffect(tool(name), parsed as JsonValue)).toBe(effect);
	});

	it("takes a connector tool's effect from its catalog operation, reviewing unknown ones", () => {
		const effects = new Map<string, "read" | "write">([
			["gmail_search_messages", "read"],
			["gmail_send_message", "write"],
		]);
		expect(cloudActionEffect(tool("gmail_search_messages", "connector"), {}, effects)).toBe("read");
		expect(cloudActionEffect(tool("gmail_send_message", "connector"), {}, effects)).toBe("external");
		expect(cloudActionEffect(tool("gmail_unknown", "connector"), {}, effects)).toBe("external");
	});
});

describe("what the card shows", () => {
	it("names a browser click by its element and keeps facts to one plain line", () => {
		const description = describeCloudAction(tool("computer_browser"), {
			operationKey: "k",
			action: { kind: "browser", action: "click", role: "button", name: "Pay now \u2028– $12.98" },
		});
		expect(description).toEqual({ title: "Click in the browser", target: 'button "Pay now – $12.98"', details: {} });
	});

	it("shows an email's recipient and subject", () => {
		expect(
			describeCloudAction(tool("gmail_send_message", "connector"), {
				input: { to: "bob@acme.test", subject: "Meeting moved", body: "Hi\nBob" },
			}),
		).toEqual({
			title: "Send an email",
			target: "bob@acme.test",
			details: { subject: "Meeting moved", body: "Hi Bob" },
		});
	});
});

describe("the reviewer's verdict", () => {
	it("keeps only real rule ids and one plain line of reason", () => {
		expect(
			parseCloudActionVerdict({
				decision: "ask",
				ruleIds: [RULE, "c1", RULE, 7],
				builtIn: "none",
				reason: "  Company rule:\nask first. ",
				proposedRule: "",
			}),
		).toEqual({
			decision: "ask",
			ruleIds: [RULE],
			builtIn: "none",
			reason: "Company rule: ask first.",
			proposedRule: null,
		});
	});

	it.each([
		{ decision: "maybe", ruleIds: [], builtIn: "none", reason: "x", proposedRule: "" },
		{ decision: "allow", ruleIds: "c1", builtIn: "none", reason: "x", proposedRule: "" },
		{ decision: "allow", ruleIds: [], builtIn: "lottery", reason: "x", proposedRule: "" },
		{ decision: "allow", ruleIds: [], builtIn: "none", reason: "   ", proposedRule: "" },
		{ decision: "allow", ruleIds: [], builtIn: "none", reason: "x", proposedRule: "", extra: true },
		"allow",
	])("refuses a malformed verdict %#", (verdict) => {
		expect(() => parseCloudActionVerdict(verdict)).toThrow("Review verdict is invalid");
	});
});

describe("what the reviewer reads as the request", () => {
	const source = (id: string, kind: string, text: string) => ({ id, kind, content: { text } });
	const context = (currentInputs: unknown[], history: unknown[] = []) =>
		({ currentInputs, history, sourceKind: "wake" }) as unknown as CloudNativeCompanyContext;
	const wake = (patch: Partial<CloudWakeEnvelope>) =>
		({ kind: "room", routine: null, payload: {}, ...patch }) as CloudWakeEnvelope;

	it("reads a member's message, a post named by the wake, a routine and a coworker message", () => {
		expect(cloudActionReviewRequest(context([source("a", "current_human_request", "Email Bob.")]), null)).toBe(
			"Email Bob.",
		);
		expect(
			cloudActionReviewRequest(
				context(
					[],
					[
						source("old", "historical_human_message", "Earlier."),
						source("post", "historical_human_message", "Pay the invoice."),
					],
				),
				wake({ payload: { inputIds: ["post"] } }),
			),
		).toBe("Pay the invoice.");
		expect(
			cloudActionReviewRequest(
				context([]),
				wake({ kind: "routine", routine: { id: randomUUID(), version: 1, intent: "Renew domains." } }),
			),
		).toBe("Routine: Renew domains.");
		expect(
			cloudActionReviewRequest(
				context([]),
				wake({ kind: "agent", payload: { message: { text: "Please send it." } } }),
			),
		).toBe("Message from a coworker: Please send it.");
		expect(cloudActionReviewRequest(context([]), wake({ kind: "agent" }))).toContain("No member request");
	});

	it("bounds a long request", () => {
		const text = cloudActionReviewRequest(context([source("a", "current_human_request", "ø".repeat(5000))]), null);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096 + 6);
		expect(text.endsWith("[...]")).toBe(true);
	});
});

function gate(options: {
	begin?: Record<string, unknown>;
	verdict?: unknown;
	record?: Record<string, unknown>;
	waits?: Array<Record<string, unknown>>;
	holdMs?: number;
	reviewerFails?: boolean;
}) {
	const calls: Array<{ method: CloudActionReviewRpc; args: Record<string, unknown> }> = [];
	const waits = [...(options.waits ?? [])];
	const control: CloudActionReviewControl = {
		call: async (method, args) => {
			calls.push({ method, args });
			if (method === "qorpera_begin_action_review")
				return (
					options.begin ?? {
						state: "review",
						agent: { name: "Tina" },
						company: { name: "Acme" },
						requester: { userId: randomUUID(), name: "Jonas" },
						rules: [{ id: RULE, scope: "company", when: "emailing outside the company", outcome: "ask_first" }],
					}
				);
			if (method === "qorpera_record_action_review")
				return { reviewId: "review-1", decision: "allow", card: false, reason: "Fine.", ...options.record };
			return waits.shift() ?? { state: args.p_park ? "parked" : "pending" };
		},
	};
	const review = vi.fn<CloudActionReviewer["review"]>(async () => {
		if (options.reviewerFails) throw new Error("PRIVATE_REVIEWER_FAILURE");
		return options.verdict ?? { decision: "allow", ruleIds: [], builtIn: "none", reason: "Fine.", proposedRule: "" };
	});
	const instance = new CloudActionReviewGate({
		binding,
		control,
		reviewer: { review },
		request: "Email Bob at Acme that the meeting moved.",
		holdMs: options.holdMs ?? 0,
		pollMs: 1,
		connectorEffects: new Map([["gmail_send_message", "write"]]),
	});
	const abort = new AbortController();
	const check = () =>
		instance.check(
			{
				tool: tool("gmail_send_message", "connector"),
				parsed: { input: { to: "bob@acme.test", subject: "Moved" } },
				argumentsText: ARGUMENTS,
				argumentSha256: "a".repeat(64),
				callId: "call_1",
			},
			abort.signal,
		);
	return { check, calls, review, abort };
}

describe("the review step", () => {
	it("lets reads through without asking anyone", async () => {
		const { calls, review } = gate({});
		const instance = new CloudActionReviewGate({
			binding,
			control: { call: async () => calls.push({ method: "qorpera_begin_action_review", args: {} }) },
			reviewer: { review },
			request: "",
			holdMs: 0,
		});
		await expect(
			instance.check(
				{
					tool: tool("company_read", "company_file"),
					parsed: {},
					argumentsText: "{}",
					argumentSha256: "a".repeat(64),
					callId: "c",
				},
				new AbortController().signal,
			),
		).resolves.toEqual({ run: true });
		expect(calls).toEqual([]);
		expect(review).not.toHaveBeenCalled();
	});

	it("runs a call a member already approved, without a second review", async () => {
		const { check, calls, review } = gate({ begin: { state: "approved", reviewId: "review-0" } });
		await expect(check()).resolves.toEqual({ run: true });
		expect(calls.map((call) => call.method)).toEqual(["qorpera_begin_action_review"]);
		expect(review).not.toHaveBeenCalled();
	});

	it("asks the reviewer on the member's account and records its verdict with the exact call", async () => {
		const { check, calls, review } = gate({});
		await expect(check()).resolves.toEqual({ run: true });
		const [input] = review.mock.calls[0];
		expect(input).toMatchObject({
			model: CLOUD_ACTION_REVIEW_MODEL,
			effort: CLOUD_ACTION_REVIEW_EFFORT,
			instructions: CLOUD_ACTION_REVIEW_INSTRUCTIONS,
		});
		// The reviewer reads the whole call, however long; the card carries it exactly, so a
		// repeat of those arguments is the same digest.
		expect(JSON.parse(input.prompt).action.arguments).toBe(ARGUMENTS);
		expect(JSON.parse(input.prompt)).toMatchObject({
			request: "Email Bob at Acme that the meeting moved.",
			actingFor: { name: "Jonas" },
			action: { tool: "gmail_send_message", effect: "external", target: "bob@acme.test" },
			rules: [{ id: RULE, outcome: "ask_first" }],
		});
		expect(calls[1]).toMatchObject({
			method: "qorpera_record_action_review",
			args: {
				p_binding: binding,
				p_review: {
					callId: "call_1",
					tool: "gmail_send_message",
					effect: "external",
					argumentSha256: "a".repeat(64),
					decision: "allow",
					reviewerModel: CLOUD_ACTION_REVIEW_MODEL,
					action: { title: "Send an email", arguments: ARGUMENTS },
				},
			},
		});
	});

	it("refuses a denied call and says not to work around it", async () => {
		const { check } = gate({ record: { decision: "deny", reason: "Nobody asked to email Bob." } });
		const result = await check();
		expect(result).toEqual({
			run: false,
			text: expect.stringMatching(/^REVIEW_DENIED: Nobody asked to email Bob\. /),
		});
	});

	it("never counts a review that could not run as an approval", async () => {
		const { check, calls } = gate({ reviewerFails: true });
		const result = await check();
		expect(result).toEqual({ run: false, text: expect.stringMatching(/^REVIEW_UNAVAILABLE: /) });
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		expect(calls.map((call) => call.method)).toEqual(["qorpera_begin_action_review"]);
	});

	it("refuses an ask where no card can be raised", async () => {
		const { check } = gate({ record: { decision: "ask", card: false, reason: "Needs approval." } });
		expect(await check()).toEqual({ run: false, text: expect.stringMatching(/^APPROVAL_UNAVAILABLE_HERE: /) });
	});

	it("holds an attended call on its card and runs it once approved", async () => {
		const { check, calls } = gate({
			holdMs: 60_000,
			record: { decision: "ask", card: true, reviewId: "review-9", approverName: "Jonas" },
			waits: [{ state: "pending" }, { state: "pending" }, { state: "approved", answeredBy: "Jonas" }],
		});
		await expect(check()).resolves.toEqual({ run: true });
		const waits = calls.filter((call) => call.method === "qorpera_await_action_review");
		expect(waits).toHaveLength(3);
		expect(waits.every((call) => call.args.p_review_id === "review-9" && call.args.p_park === false)).toBe(true);
	});

	it("refuses a declined call", async () => {
		const { check } = gate({
			holdMs: 60_000,
			record: { decision: "ask", card: true },
			waits: [{ state: "declined", answeredBy: "Jonas" }],
		});
		expect(await check()).toEqual({ run: false, text: expect.stringMatching(/^APPROVAL_DECLINED: Jonas declined/) });
	});

	it("parks an unattended call at once and says who it waits for", async () => {
		const { check, calls } = gate({
			holdMs: 0,
			record: { decision: "ask", card: true, reviewId: "review-3", approverName: "Jonas" },
			waits: [{ state: "parked" }],
		});
		const result = await check();
		expect(result).toEqual({ run: false, text: expect.stringMatching(/^APPROVAL_PENDING: .*from Jonas/) });
		expect(calls.at(-1)).toMatchObject({ args: { p_review_id: "review-3", p_park: true } });
	});

	it("parks a held call when its hold runs out", async () => {
		const { check, calls } = gate({
			holdMs: 5,
			record: { decision: "ask", card: true, reviewId: "review-4" },
			waits: [{ state: "pending" }, { state: "pending" }],
		});
		const started = Date.now();
		// Pending answers keep coming until the hold is over; the final wait parks.
		const result = await check();
		expect(Date.now() - started).toBeGreaterThanOrEqual(5);
		expect(calls.at(-1)).toMatchObject({ args: { p_review_id: "review-4", p_park: true } });
		expect(result.run).toBe(false);
	});

	it("keeps a denial for the exact call, and says an approval already used has nothing left to do", async () => {
		const declined = gate({ begin: { state: "declined", reviewId: "review-5" } });
		expect(await declined.check()).toEqual({
			run: false,
			text: expect.stringMatching(/^REVIEW_DENIED: This exact action was declined/),
		});
		expect(declined.review).not.toHaveBeenCalled();
		const used = gate({ begin: { state: "used", reviewId: "review-6" } });
		expect(await used.check()).toEqual({ run: false, text: expect.stringMatching(/^APPROVAL_USED: /) });
	});

	it("parks its card when the run stops while it holds", async () => {
		const { check, calls, abort } = gate({
			holdMs: 60_000,
			record: { decision: "ask", card: true, reviewId: "review-8" },
			waits: [{ state: "pending" }],
		});
		const result = check();
		await new Promise((resolve) => setTimeout(resolve, 20));
		abort.abort();
		await expect(result).rejects.toBeDefined();
		// Leaving parks an unanswered card and never uses an approval the call will not run.
		expect(calls.at(-1)).toMatchObject({
			method: "qorpera_await_action_review",
			args: { p_review_id: "review-8", p_park: true, p_leaving: true },
		});
	});

	it("waits on a card that is already waiting instead of raising a second one", async () => {
		const { check, calls, review } = gate({
			holdMs: 0,
			begin: { state: "pending", reviewId: "review-7", approverName: "An owner" },
			waits: [{ state: "approved" }],
		});
		await expect(check()).resolves.toEqual({ run: true });
		expect(review).not.toHaveBeenCalled();
		expect(calls.map((call) => call.method)).toEqual(["qorpera_begin_action_review", "qorpera_await_action_review"]);
	});
});

describe("the boundary's review step", () => {
	function boundaryFixture(result: { run: true } | { run: false; text: string }) {
		const execute = vi.fn<CloudNativeTool["execute"]>(async () => ({ kind: "text", value: "Sent" }));
		const assertActive = vi.fn(async () => undefined);
		const check = vi.fn(async () => result);
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [
				{
					name: "send_email",
					description: "Send an email.",
					source: "connector",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					parseArguments: () => ({ to: "bob@acme.test" }),
					execute,
				},
			],
			assertActive,
			signal: new AbortController().signal,
			review: { check },
		});
		return { boundary, execute, assertActive, check };
	}

	it("runs a call the review lets through, checking authority again right before the effect", async () => {
		const { boundary, execute, assertActive, check } = boundaryFixture({ run: true });
		const response = await boundary.invoke("call_1", "qorpera", "send_email", {});
		expect((JSON.parse(response.contentItems[0].text) as CloudToolResult).status).toBe("ok");
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({
				callId: "call_1",
				parsed: { to: "bob@acme.test" },
				argumentsText: "{}",
				argumentSha256: expect.any(String),
			}),
			expect.any(AbortSignal),
		);
		expect(execute).toHaveBeenCalledOnce();
		// Authority is checked again after the review and before the effect.
		const reviewed = check.mock.invocationCallOrder[0];
		const effect = execute.mock.invocationCallOrder[0];
		expect(assertActive.mock.invocationCallOrder.some((order) => order > reviewed && order < effect)).toBe(true);
	});

	it("returns the review's refusal as a denied result and never runs the call", async () => {
		const { boundary, execute } = boundaryFixture({ run: false, text: "APPROVAL_PENDING: waits for Jonas." });
		const response = await boundary.invoke("call_1", "qorpera", "send_email", {});
		const result = JSON.parse(response.contentItems[0].text) as CloudToolResult;
		expect(result).toMatchObject({ status: "denied", content: { text: "APPROVAL_PENDING: waits for Jonas." } });
		expect(execute).not.toHaveBeenCalled();
	});
});
