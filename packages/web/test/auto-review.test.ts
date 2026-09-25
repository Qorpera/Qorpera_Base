// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesView } from "../src/app/views/settings-rules.ts";
import { CloudApi } from "../src/cloud/api.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type ActionReviewCard,
	actionReviewCard,
	answersActionReview,
	createWebReviewRules,
	type HostedReviewRule,
	type WebReviewRules,
} from "../src/cloud/review-rules.ts";
import { renderActionReviewCard } from "../src/ui/authorization-card.ts";
import { id, settle, timestamp } from "./fixtures.ts";

const data = {
	schema: "qorpera.action-review/v1",
	reviewId: id(700).toUpperCase(),
	title: "Send an email",
	summary: "The company asks first before emailing outside the company.",
	target: "bob@acme.test",
	details: { subject: "Meeting moved", count: 3 },
	tool: "gmail_send_message",
	arguments: '{"input":{"to":"bob@acme.test"}}',
	builtIn: "money",
	rules: [
		{ id: id(701), scope: "company", when: "sending any email outside the company", outcome: "ask_first" },
		{ id: id(702), scope: "member", when: "paying for anything", outcome: "ask_first" },
		{ id: id(703), scope: "robot", when: "x", outcome: "ask_first" },
	],
	approverScope: "owners_admins",
	approverName: "Jonas",
	requesterUserId: id(1),
	alwaysAllow: true,
	proposedRule: "renewing our domains",
} as const;

describe("approval card facts", () => {
	it("reads a review card and ignores other approvals and malformed rules", () => {
		const card = actionReviewCard(structuredClone(data) as never)!;
		expect(card).toMatchObject({
			reviewId: id(700),
			title: "Send an email",
			target: "bob@acme.test",
			details: [["subject", "Meeting moved"]],
			tool: "gmail_send_message",
			approverScope: "owners_admins",
			alwaysAllow: true,
			proposedRule: "renewing our domains",
		});
		expect(card.rules.map((rule) => rule.id)).toEqual([id(701), id(702)]);
		expect(actionReviewCard({ operation: "send_invoice", summary: "Legacy" })).toBeUndefined();
		expect(actionReviewCard({ ...data, approverScope: "anyone" } as never)).toBeUndefined();
	});

	it("says who answers, as the kernel checks it", () => {
		const company = actionReviewCard(structuredClone(data) as never)!;
		expect(answersActionReview(company, id(1), "owner")).toBe(true);
		expect(answersActionReview(company, id(1), "admin")).toBe(true);
		expect(answersActionReview(company, id(1), "contributor")).toBe(false);
		const personal = { ...company, approverScope: "member" as const, approverUserId: id(2) };
		expect(answersActionReview(personal, id(2), "viewer")).toBe(true);
		expect(answersActionReview(personal, id(1), "owner")).toBe(false);
	});
});

describe("the approval card", () => {
	const card = actionReviewCard(structuredClone(data) as never)! as ActionReviewCard;
	const names = (userId: string) => (userId === id(1) ? "Jonas" : "Anna");

	it("gives the member it waits for Deny, Allow once and Always allow with the rule to edit", () => {
		const answer = vi.fn();
		const el = renderActionReviewCard(card, timestamp, undefined, { answer, memberName: names });
		expect(el.dataset.decisionState).toBe("pending");
		expect(el.textContent).toContain("Company rule: sending any email outside the company");
		expect(el.textContent).toContain("Personal rule: paying for anything");
		expect(el.textContent).toContain("It moves money.");
		expect(el.querySelector(".review-call")?.textContent).toBe(
			'gmail_send_message({"input":{"to":"bob@acme.test"}})',
		);
		const buttons = [...el.querySelectorAll<HTMLButtonElement>(".review-answer > .decision-actions button")];
		expect(buttons.map((button) => button.textContent)).toEqual(["Deny", "Always allow…", "Allow once"]);
		buttons[2]!.click();
		expect(answer).toHaveBeenLastCalledWith("allow_once");
		buttons[0]!.click();
		expect(answer).toHaveBeenLastCalledWith("deny");
		const always = el.querySelector<HTMLElement>(".review-always")!;
		expect(always.hidden).toBe(true);
		buttons[1]!.click();
		expect(always.hidden).toBe(false);
		const input = always.querySelector<HTMLInputElement>("input")!;
		expect(input.value).toBe("renewing our domains");
		input.value = "  renewing our domains for up to $20 ";
		always.querySelector<HTMLButtonElement>("button")!.click();
		expect(answer).toHaveBeenLastCalledWith("always_allow", "renewing our domains for up to $20");
	});

	it("shows everyone else who it waits for, with no controls", () => {
		const el = renderActionReviewCard(card, timestamp, undefined, { memberName: names });
		expect(el.querySelector("button")).toBeNull();
		expect(el.querySelector(".review-waiting")?.textContent).toBe("Waiting for an owner or admin to approve.");
		const personal = renderActionReviewCard(
			{ ...card, approverScope: "member", approverUserId: id(2), approverName: "Anna" },
			timestamp,
			undefined,
			{ memberName: names },
		);
		expect(personal.querySelector(".review-waiting")?.textContent).toBe("Waiting for Anna to approve.");
	});

	it("shows the answer once given", () => {
		const allowed = renderActionReviewCard(
			card,
			timestamp,
			{ entry: { data: { decision: "approved", answer: { answer: "always_allow" }, answeredBy: id(1) } } },
			{ answer: vi.fn(), memberName: names },
		);
		expect(allowed.dataset.decisionState).toBe("approved");
		expect(allowed.querySelector("button")).toBeNull();
		expect(allowed.querySelector(".review-outcome")?.textContent).toBe("Always allowed by Jonas.");
		const declined = renderActionReviewCard(
			card,
			timestamp,
			{ decision: "declined", answer: { answer: "deny" }, answeredBy: id(2) },
			{ memberName: names },
		);
		expect(declined.querySelector(".review-outcome")?.textContent).toBe("Declined by Anna.");
	});
});

function rule(n: number, scope: HostedReviewRule["scope"], when: string): HostedReviewRule {
	return {
		id: id(n),
		scope,
		memberUserId: scope === "member" ? id(1) : null,
		when,
		outcome: "ask_first",
		createdVia: "settings",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

describe("the rules client", () => {
	it("calls the kernel's rule RPCs for its company", async () => {
		const rpc = vi.fn<Cloud["rpc"]>(async (name) =>
			name === "qorpera_list_review_rules"
				? { schema: "qorpera.review-rules/v1", canManageCompanyRules: true, rules: [rule(801, "company", "x")] }
				: name === "qorpera_save_review_rule"
					? rule(802, "member", "y")
					: { id: id(801), archived: true },
		);
		const client = createWebReviewRules({ rpc }, id(10));
		expect(await client.list()).toMatchObject({ canManageCompanyRules: true, rules: [{ id: id(801) }] });
		await client.save({ id: id(802), scope: "member", when: "y", outcome: "allow_automatically" });
		await client.archive(id(801));
		expect(rpc.mock.calls).toEqual([
			["qorpera_list_review_rules", { p_profile_id: id(10) }],
			[
				"qorpera_save_review_rule",
				{
					p_profile_id: id(10),
					p_rule_id: id(802),
					p_scope: "member",
					p_when: "y",
					p_outcome: "allow_automatically",
				},
			],
			["qorpera_archive_review_rule", { p_profile_id: id(10), p_rule_id: id(801) }],
		]);
	});

	it("answers an approval card with the member's account", async () => {
		const rpc = vi.fn<Cloud["rpc"]>(async () => ({
			reviewId: id(700),
			answer: "always_allow",
			inputId: id(701),
			savedRuleId: id(702),
			woke: true,
		}));
		const api = new CloudApi({ rpc } as unknown as Cloud);
		const receipt = await api.answerActionReview(id(700), id(703), "always_allow", "renewing our domains", {
			sponsorBindingId: id(81),
			sponsorVersion: 2,
		});
		expect(receipt).toEqual({
			reviewId: id(700),
			answer: "always_allow",
			inputId: id(701),
			savedRuleId: id(702),
			woke: true,
		});
		expect(rpc).toHaveBeenCalledWith("qorpera_answer_action_review", {
			p_review_id: id(700),
			p_client_input_id: id(703),
			p_answer: "always_allow",
			p_rule_text: "renewing our domains",
			p_sponsor_binding_id: id(81),
			p_sponsor_version: 2,
		});
	});
});

let view: RulesView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
});

function rulesClient(canManage: boolean, rules: HostedReviewRule[] = []) {
	const client: WebReviewRules = {
		list: vi.fn(async () => ({ canManageCompanyRules: canManage, rules })),
		save: vi.fn(async (input) => ({ ...rule(900, input.scope, input.when), id: input.id, outcome: input.outcome })),
		archive: vi.fn(async () => undefined),
	};
	return client;
}

describe("Settings → Rules", () => {
	it("shows the company's rules locked to a member who does not manage them, and adds a rule of their own", async () => {
		const client = rulesClient(false, [
			rule(901, "company", "sending email outside the company"),
			rule(902, "member", "posting on LinkedIn"),
		]);
		view = new RulesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const [company, own] = [...view.el.querySelectorAll(".settings-rule-list")];
		expect(company?.textContent).toContain("sending email outside the company");
		expect(company?.textContent).toContain("Locked");
		expect(company?.querySelector("button")).toBeNull();
		expect(own?.querySelector("button")?.textContent).toBe("Remove");
		expect(view.el.textContent).toContain("Owners and admins write company rules.");
		expect(view.el.querySelector('select[aria-label="Applies to:"]')).toBeNull();
		const input = view.el.querySelector<HTMLInputElement>('input[aria-label="When an agent wants to:"]')!;
		input.value = "  reply to emails for me ";
		view.el.querySelector<HTMLSelectElement>('select[aria-label="It should:"]')!.value = "ask_first";
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Add rule")!.click();
		await settle();
		expect(client.save).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "member", when: "reply to emails for me", outcome: "ask_first" }),
		);
		expect(view.el.textContent).toContain("reply to emails for me");
		expect(input.value).toBe("");
	});

	it("lets an owner or admin write company rules and remove them", async () => {
		const client = rulesClient(true, [rule(903, "company", "deleting files")]);
		view = new RulesView(client, new AbortController().signal);
		await settle();
		view.el.querySelector<HTMLSelectElement>('select[aria-label="Applies to:"]')!.value = "company";
		view.el.querySelector<HTMLInputElement>('input[aria-label="When an agent wants to:"]')!.value = "hiring agents";
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Add rule")!.click();
		await settle();
		expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ scope: "company", when: "hiring agents" }));
		view.el.querySelector<HTMLButtonElement>(".settings-rule button")!.click();
		await settle();
		expect(client.archive).toHaveBeenCalledWith(id(903));
		expect(view.el.textContent).not.toContain("deleting files");
	});

	it("adds nothing for an empty rule, and says so when the cloud has no rules yet", async () => {
		const client = rulesClient(true);
		view = new RulesView(client, new AbortController().signal);
		await settle();
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Add rule")!.click();
		await settle();
		expect(client.save).not.toHaveBeenCalled();
		const missing: WebReviewRules = {
			...client,
			list: vi.fn(async () => {
				throw new CloudRpcError("qorpera_list_review_rules", { code: "PGRST202", message: "Could not find" }, 404);
			}),
		};
		view.dispose();
		view = new RulesView(missing, new AbortController().signal);
		await settle();
		expect(view.el.textContent).toContain("Rules are not available on this cloud yet.");
		expect(view.el.querySelector("input")).toBeNull();
	});

	it("shows a refusal and keeps the typed rule", async () => {
		const client = rulesClient(false);
		client.save = vi.fn(async () => {
			throw new CloudRpcError(
				"qorpera_save_review_rule",
				{ code: "22023", message: "A rule is one short sentence (1 to 280 characters)" },
				400,
			);
		});
		view = new RulesView(client, new AbortController().signal);
		await settle();
		const input = view.el.querySelector<HTMLInputElement>('input[aria-label="When an agent wants to:"]')!;
		input.value = "something";
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Add rule")!.click();
		await settle();
		expect(view.el.querySelector(".notice-danger")?.textContent).toContain("one short sentence");
		expect(input.value).toBe("something");
	});
});
