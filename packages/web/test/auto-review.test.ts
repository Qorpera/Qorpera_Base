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
import { renderActionReviewCard, renderAuthorizationCard } from "../src/ui/authorization-card.ts";
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
		// A lost answer is news only to whoever answers the card.
		const failed = renderActionReviewCard(card, timestamp, undefined, { memberName: names, answerFailed: true });
		expect(failed.querySelector(".review-failed")).toBeNull();
		const retry = renderActionReviewCard(card, timestamp, undefined, {
			answer: vi.fn(),
			memberName: names,
			answerFailed: true,
		});
		expect(retry.querySelector(".review-failed")?.textContent).toBe(
			"That answer did not reach the agent. Answer again.",
		);
	});

	it("offers nothing on an approval of an action it cannot read", () => {
		const el = renderAuthorizationCard(
			"authorization_request",
			{ entry: { data: { schema: "qorpera.action-review/v1", title: "Send an email" } } },
			timestamp,
			"Agent",
		);
		expect(el.querySelector("button")).toBeNull();
		expect(el.textContent).not.toContain("Only an owner or admin");
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

function typeRule(el: HTMLElement, text: string): HTMLInputElement {
	const input = el.querySelector<HTMLInputElement>('input[aria-label="When an agent wants to:"]')!;
	input.value = text;
	input.dispatchEvent(new Event("input"));
	return input;
}

const addButton = (el: HTMLElement) =>
	[...el.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add rule")!;

const tableRows = (el: HTMLElement) =>
	[...el.querySelectorAll<HTMLTableRowElement>(".settings-rule-table tbody tr")].map((row) =>
		[...row.cells].slice(0, 3).map((cell) => cell.textContent),
	);

describe("Settings → General → rules", () => {
	it("shows the company's rules locked to a member who does not manage them, and adds a rule of their own", async () => {
		const client = rulesClient(false, [
			rule(902, "member", "posting on LinkedIn"),
			rule(901, "company", "sending email outside the company"),
		]);
		view = new RulesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		// One table, the company's rules first, as Grok Bot lists them: Action, Behavior, and whom it applies to.
		expect([...view.el.querySelectorAll(".settings-rule-table th")].map((cell) => cell.textContent)).toEqual([
			"Action",
			"Behavior",
			"Applies to",
			"Edit or remove",
		]);
		expect(tableRows(view.el)).toEqual([
			["sending email outside the company", "Ask first", "Everyone in the company"],
			["posting on LinkedIn", "Ask first", "Only me"],
		]);
		const [company, own] = [...view.el.querySelectorAll<HTMLTableRowElement>(".settings-rule-table tbody tr")];
		expect(company?.querySelector("button")).toBeNull();
		expect(company?.querySelector(".settings-rule-locked")?.getAttribute("aria-label")).toBe("Locked");
		expect([...own!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
			"Edit the rule: posting on LinkedIn",
			"Remove the rule: posting on LinkedIn",
		]);
		expect(view.el.querySelector("h1, h2")).toBeNull();
		expect(view.el.textContent).toContain("Built-in safety checks always apply.");
		expect(view.el.querySelector('select[aria-label="Applies to:"]')).toBeNull();
		// Add rule waits for a rule to add.
		expect(addButton(view.el).disabled).toBe(true);
		const input = typeRule(view.el, "  reply to emails for me ");
		expect(addButton(view.el).disabled).toBe(false);
		view.el.querySelector<HTMLSelectElement>('select[aria-label="It should:"]')!.value = "ask_first";
		addButton(view.el).click();
		await settle();
		expect(client.save).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "member", when: "reply to emails for me", outcome: "ask_first" }),
		);
		expect(tableRows(view.el).at(-1)).toEqual(["reply to emails for me", "Ask first", "Only me"]);
		expect(input.value).toBe("");
		expect(addButton(view.el).disabled).toBe(true);
	});

	it("lets an owner or admin write company rules and remove them", async () => {
		const client = rulesClient(true, [rule(903, "company", "deleting files")]);
		view = new RulesView(client, new AbortController().signal, () => "owner");
		// The role shows Applies to before the list arrives, so the form does not move.
		expect(view.el.querySelector('select[aria-label="Applies to:"]')).not.toBeNull();
		await settle();
		view.el.querySelector<HTMLSelectElement>('select[aria-label="Applies to:"]')!.value = "company";
		typeRule(view.el, "hiring agents");
		addButton(view.el).click();
		await settle();
		expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ scope: "company", when: "hiring agents" }));
		expect(tableRows(view.el)).toEqual([
			["deleting files", "Ask first", "Everyone in the company"],
			["hiring agents", "Allow automatically", "Everyone in the company"],
		]);
		const remove = view.el.querySelector<HTMLButtonElement>('button[aria-label="Remove the rule: deleting files"]')!;
		remove.click();
		await settle();
		expect(client.archive).toHaveBeenCalledWith(id(903));
		expect(view.el.textContent).not.toContain("deleting files");
		expect(view.el.querySelector(".settings-rule-table")).not.toBeNull();
		view.el.querySelector<HTMLButtonElement>('button[aria-label="Remove the rule: hiring agents"]')!.click();
		await settle();
		// No rules: no table, only the form and the note.
		expect(view.el.querySelector(".settings-rule-table")).toBeNull();
	});

	it("edits a rule's sentence and behaviour in its row, and Escape leaves the edit, not Settings", async () => {
		const client = rulesClient(false, [rule(905, "member", "buying anything")]);
		view = new RulesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const closeSettings = vi.fn();
		document.addEventListener("keydown", closeSettings);
		try {
			view.el.querySelector<HTMLButtonElement>(".settings-rule-edit")!.click();
			const input = view.el.querySelector<HTMLInputElement>('.settings-rule-table input[aria-label="Action"]')!;
			expect(input.value).toBe("buying anything");
			expect(document.activeElement).toBe(input);
			input.value = "buying anything over $20";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(closeSettings).not.toHaveBeenCalled();
			expect(tableRows(view.el)).toEqual([["buying anything", "Ask first", "Only me"]]);
			expect(document.activeElement).toBe(view.el.querySelector(".settings-rule-edit"));
			expect(client.save).not.toHaveBeenCalled();

			view.el.querySelector<HTMLButtonElement>(".settings-rule-edit")!.click();
			const again = view.el.querySelector<HTMLInputElement>('.settings-rule-table input[aria-label="Action"]')!;
			again.value = "  buying anything over $20 ";
			view.el.querySelector<HTMLSelectElement>('.settings-rule-table select[aria-label="Behavior"]')!.value =
				"allow_automatically";
			again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await settle();
			// The same rule, rewritten: the kernel keeps its id and whom it applies to.
			expect(client.save).toHaveBeenCalledExactlyOnceWith({
				id: id(905),
				scope: "member",
				when: "buying anything over $20",
				outcome: "allow_automatically",
			});
			expect(tableRows(view.el)).toEqual([["buying anything over $20", "Allow automatically", "Only me"]]);
			expect(document.activeElement).toBe(view.el.querySelector(".settings-rule-edit"));
		} finally {
			document.removeEventListener("keydown", closeSettings);
		}
	});

	it("leaves the edit on Escape from its tick or cross too, never closing Settings", async () => {
		const client = rulesClient(false, [rule(907, "member", "buying anything")]);
		view = new RulesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const closeSettings = vi.fn();
		document.addEventListener("keydown", closeSettings);
		try {
			for (const label of ["Save", "Cancel"]) {
				view.el.querySelector<HTMLButtonElement>(".settings-rule-edit")!.click();
				const control = view.el.querySelector<HTMLButtonElement>(
					`.settings-rule-table button[aria-label="${label}"]`,
				)!;
				control.focus();
				control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				expect(closeSettings).not.toHaveBeenCalled();
				expect(view.el.querySelector(".settings-rule-table input")).toBeNull();
				expect(document.activeElement).toBe(view.el.querySelector(".settings-rule-edit"));
			}
			expect(client.save).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", closeSettings);
		}
	});

	it("never writes the version an edit started from over a newer one", async () => {
		let role = "member";
		const client = rulesClient(false, [rule(908, "member", "buying anything")]);
		view = new RulesView(client, new AbortController().signal, () => role);
		document.body.append(view.el);
		await settle();
		view.el.querySelector<HTMLButtonElement>(".settings-rule-edit")!.click();
		// A load while editing brings a newer sentence; the draft still holds the old one.
		vi.mocked(client.list).mockResolvedValue({
			canManageCompanyRules: false,
			rules: [{ ...rule(908, "member", "buying anything online"), outcome: "allow_automatically" }],
		});
		role = "contributor";
		view.update();
		await settle();
		expect(view.el.querySelector<HTMLInputElement>('.settings-rule-table input[aria-label="Action"]')!.value).toBe(
			"buying anything",
		);
		view.el.querySelector<HTMLButtonElement>('.settings-rule-table button[aria-label="Save"]')!.click();
		await settle();
		expect(client.save).not.toHaveBeenCalled();
		expect(tableRows(view.el)).toEqual([["buying anything online", "Allow automatically", "Only me"]]);
	});

	it("ends an edit whose rule a load took away, or the right to edit it, and keeps the keyboard in the view", async () => {
		let role = "owner";
		const client = rulesClient(true, [rule(909, "company", "hiring agents"), rule(910, "member", "posting")]);
		view = new RulesView(client, new AbortController().signal, () => role);
		document.body.append(view.el);
		await settle();
		// Demoted while editing a company rule: the edit ends and does not come back with the role.
		view.el.querySelector<HTMLButtonElement>('button[aria-label="Edit the rule: hiring agents"]')!.click();
		vi.mocked(client.list).mockResolvedValue({
			canManageCompanyRules: false,
			rules: [rule(909, "company", "hiring agents"), rule(910, "member", "posting")],
		});
		role = "member";
		view.update();
		await settle();
		expect(view.el.querySelector(".settings-rule-table input")).toBeNull();
		expect(view.el.querySelector(`tr[data-rule-id="${id(909)}"] .settings-rule-locked`)).not.toBeNull();
		expect(document.activeElement).toBe(view.el.querySelector('input[aria-label="When an agent wants to:"]'));
		vi.mocked(client.list).mockResolvedValue({
			canManageCompanyRules: true,
			rules: [rule(909, "company", "hiring agents"), rule(910, "member", "posting")],
		});
		role = "owner";
		view.update();
		await settle();
		expect(view.el.querySelector(".settings-rule-table input")).toBeNull();
		// The rule removed elsewhere while it is edited: the edit ends, the keyboard goes to the form.
		view.el.querySelector<HTMLButtonElement>('button[aria-label="Edit the rule: posting"]')!.click();
		vi.mocked(client.list).mockResolvedValue({
			canManageCompanyRules: true,
			rules: [rule(909, "company", "hiring agents")],
		});
		role = "admin";
		view.update();
		await settle();
		expect(view.el.querySelector(".settings-rule-table input")).toBeNull();
		expect(document.activeElement).toBe(view.el.querySelector('input[aria-label="When an agent wants to:"]'));
	});

	it("keeps an edit and its draft when the save is refused", async () => {
		const client = rulesClient(false, [rule(906, "member", "buying anything")]);
		client.save = vi.fn(async () => {
			throw new CloudRpcError(
				"qorpera_save_review_rule",
				{ code: "42501", message: "This rule cannot be changed here" },
				403,
			);
		});
		view = new RulesView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		view.el.querySelector<HTMLButtonElement>(".settings-rule-edit")!.click();
		const input = view.el.querySelector<HTMLInputElement>('.settings-rule-table input[aria-label="Action"]')!;
		input.value = "buying things";
		view.el.querySelector<HTMLButtonElement>('.settings-rule-table button[aria-label="Save"]')!.click();
		await settle();
		expect(view.el.querySelector(".notice-danger")?.textContent).toContain("cannot be changed here");
		expect(view.el.querySelector('.settings-rule-table input[aria-label="Action"]')).toBe(input);
		expect(input.value).toBe("buying things");
		expect(document.activeElement).toBe(input);
	});

	it("drops a list that a newer load or a change overtook", async () => {
		let role = "member";
		const loads: Array<(value: { canManageCompanyRules: boolean; rules: HostedReviewRule[] }) => void> = [];
		const client = rulesClient(false);
		vi.mocked(client.list).mockImplementation(() => new Promise((resolve) => loads.push(resolve)));
		view = new RulesView(client, new AbortController().signal, () => role);
		loads.shift()!({ canManageCompanyRules: false, rules: [] });
		await settle();
		// Two role changes in a row: only the latest load counts, whatever order they answer in.
		role = "admin";
		view.update();
		role = "owner";
		view.update();
		const [stale, latest] = [loads.shift()!, loads.shift()!];
		latest({ canManageCompanyRules: true, rules: [rule(904, "company", "hiring agents")] });
		await settle();
		stale({ canManageCompanyRules: false, rules: [] });
		await settle();
		expect(view.el.textContent).toContain("hiring agents");
		expect(view.el.querySelector('select[aria-label="Applies to:"]')).not.toBeNull();
		// A save while a load is on its way: the rule shows once, and the old load does not hide it.
		role = "member";
		view.update();
		typeRule(view.el, "posting");
		addButton(view.el).click();
		await settle();
		loads.shift()!({ canManageCompanyRules: false, rules: [] });
		await settle();
		expect(view.el.textContent).toContain("posting");
		expect(view.el.querySelectorAll(".settings-rule")).toHaveLength(2);
	});

	it("does not load again when the role arrives after a list loaded without it", async () => {
		let role: string | undefined;
		const client = rulesClient(true, [rule(911, "company", "hiring agents")]);
		view = new RulesView(client, new AbortController().signal, () => role);
		await settle();
		role = "owner";
		view.update();
		view.update();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(1);
		expect(view.el.querySelector('select[aria-label="Applies to:"]')).not.toBeNull();
		// A later change of role still loads again.
		role = "member";
		view.update();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("does not ask again for a list that failed until the role moves", async () => {
		let role = "member";
		for (const failure of [
			new CloudRpcError("qorpera_list_review_rules", { code: "PGRST202", message: "Could not find" }, 404),
			new Error("Network down"),
		]) {
			const client = rulesClient(false);
			vi.mocked(client.list).mockRejectedValue(failure);
			view?.dispose();
			view = new RulesView(client, new AbortController().signal, () => role);
			await settle();
			for (let change = 0; change < 5; change++) view.update();
			await settle();
			expect(client.list).toHaveBeenCalledTimes(1);
			role = role === "member" ? "admin" : "member";
			view.update();
			view.update();
			await settle();
			expect(client.list).toHaveBeenCalledTimes(2);
		}
	});

	it("adds nothing for an empty rule, and says so when the cloud has no rules yet", async () => {
		const client = rulesClient(true);
		view = new RulesView(client, new AbortController().signal);
		await settle();
		typeRule(view.el, "   ");
		expect(addButton(view.el).disabled).toBe(true);
		view.el
			.querySelector<HTMLInputElement>('input[aria-label="When an agent wants to:"]')!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
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
		const input = typeRule(view.el, "something");
		addButton(view.el).click();
		await settle();
		expect(view.el.querySelector(".notice-danger")?.textContent).toContain("one short sentence");
		expect(input.value).toBe("something");
		expect(addButton(view.el).disabled).toBe(false);
	});
});
