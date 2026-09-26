// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { EmailDraftEditor, EmailDraftState } from "../src/cloud/email-drafts.ts";
import {
	type InteractionCardContext,
	type InteractionCardItem,
	renderInteractionCard,
} from "../src/ui/interaction-card.ts";

const item: InteractionCardItem = {
	id: "email-draft",
	actorUserId: "agent",
	createdAt: "2026-09-25T12:00:00Z",
	request: {
		surface: "draft",
		title: "An introduction",
		payload: {
			platform: "email",
			connectorId: "gmail",
			from: "spoofed@example.com",
			to: ["recipient@example.com"],
			subject: "Hello",
			body: "Dear recipient,\n\nHello.",
		},
	},
};
const ready: EmailDraftState = {
	from: "connected@example.com",
	status: "ready",
	content: { to: ["recipient@example.com"], cc: [], subject: "Hello", body: "Dear recipient,\n\nHello." },
};
function context(overrides: Partial<InteractionCardContext> = {}): InteractionCardContext {
	return {
		agentName: "Nova",
		memberName: () => "Jonas",
		canAnswer: true,
		answer: vi.fn(async () => {}),
		emailDraft: { state: structuredClone(ready) },
		actEmailDraft: vi.fn(
			async (action, content): Promise<EmailDraftState> => ({
				...ready,
				content,
				status: action === "send" ? "sent" : action === "save" ? "saved" : "discarded",
			}),
		),
		...overrides,
	};
}
function click(card: HTMLElement, label: string): HTMLButtonElement {
	const control = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === label,
	)!;
	expect(control, label).toBeDefined();
	control.click();
	return control;
}
function edit(card: HTMLElement, label: string, value: string): HTMLInputElement | HTMLTextAreaElement {
	const input = card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return input;
}

describe("email draft card", () => {
	it("shows the reference layout, trusts only the connected sender, and sends edited content", async () => {
		const ctx = context();
		const card = renderInteractionCard(item, ctx);
		expect(card.querySelector("h3")?.textContent).toBe("New email");
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Ready to send");
		expect(card.querySelector(".email-draft-from")?.textContent).toBe("connected@example.com");
		expect(card.textContent).not.toContain("spoofed@example.com");
		expect(card.querySelector("[aria-label=From]")).toBeNull();
		edit(card, "To", "henrik@example.com, colleague@example.com");
		click(card, "Cc");
		edit(card, "Cc", "copy@example.com");
		edit(card, "Subject", "Kort om Qorpera");
		edit(card, "Email body", "Hej Henrik,\n\nHer er Qorpera.");
		click(card, "Send email");
		expect(ctx.actEmailDraft).toHaveBeenCalledWith("send", {
			to: ["henrik@example.com", "colleague@example.com"],
			cc: ["copy@example.com"],
			subject: "Kort om Qorpera",
			body: "Hej Henrik,\n\nHer er Qorpera.",
		});
		expect(ctx.answer).not.toHaveBeenCalled();
		await ctx.emailDraft?.pending;
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(card.querySelector("h3")?.textContent).toBe("Email sent");
		expect(card.querySelector("input, textarea")).toBeNull();
		expect(card.querySelector(".email-sent-to")?.textContent).toContain("henrik@example.com, colleague@example.com");
		expect(card.querySelector(".email-sent-cc")?.textContent).toContain("copy@example.com");
		expect(card.querySelector(".email-sent-subject")?.textContent).toBe("Kort om Qorpera");
		expect(card.querySelector(".email-sent-body")?.textContent).toBe("Hej Henrik,\n\nHer er Qorpera.");
		const details = card.querySelector("details")!;
		expect(details.open).toBe(false);
		details.querySelector("summary")!.click();
		expect(details.open).toBe(true);
		details.dispatchEvent(new Event("toggle"));
		const refreshed = renderInteractionCard(item, ctx);
		expect(refreshed.querySelector("details")?.open).toBe(true);
		expect(ctx.actEmailDraft).toHaveBeenCalledOnce();
		expect(card.querySelector("button")).toBeNull();
	});

	it("loads the trusted sender once and does not enable actions before the account is available", async () => {
		let resolve!: (state: EmailDraftState) => void;
		const editor: EmailDraftEditor = {};
		const loadEmailDraft = vi.fn(
			() =>
				new Promise<EmailDraftState>((done) => {
					resolve = done;
				}),
		);
		const ctx = context({ emailDraft: editor, loadEmailDraft });
		const first = renderInteractionCard(item, ctx);
		const second = renderInteractionCard(item, ctx);
		expect(loadEmailDraft).toHaveBeenCalledTimes(1);
		expect(click(first, "Send email").disabled).toBe(true);
		expect(ctx.actEmailDraft).not.toHaveBeenCalled();
		expect(first.textContent).not.toContain("spoofed@example.com");
		resolve(ready);
		await editor.pending;
		expect(first.querySelector(".email-draft-from")?.textContent).toBe(ready.from);
		expect(second.querySelector(".email-draft-from")?.textContent).toBe(ready.from);
	});

	it("preserves partially edited recipients across renders and blocks invalid addresses or empty content", () => {
		const ctx = context();
		let card = renderInteractionCard(item, ctx);
		edit(card, "To", "unfinished@");
		card = renderInteractionCard(item, ctx);
		expect(card.querySelector<HTMLInputElement>("[aria-label=To]")?.value).toBe("unfinished@");
		expect(click(card, "Send email").disabled).toBe(true);
		expect(click(card, "Save to Gmail").disabled).toBe(true);
		edit(card, "To", "valid@example.com");
		edit(card, "Email body", "  ");
		expect(click(card, "Send email").disabled).toBe(true);
		expect(ctx.actEmailDraft).not.toHaveBeenCalled();
	});

	it("saves the edited draft without sending and remains editable", async () => {
		const ctx = context();
		const card = renderInteractionCard(item, ctx);
		edit(card, "Subject", "Updated subject");
		click(card, "Save to Gmail");
		await ctx.emailDraft?.pending;
		expect(ctx.actEmailDraft).toHaveBeenCalledWith("save", expect.objectContaining({ subject: "Updated subject" }));
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Saved to Gmail");
		expect(card.querySelector<HTMLInputElement>("[aria-label=Subject]")?.readOnly).toBe(false);
		edit(card, "Subject", "Further edits");
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Ready to send");
	});

	it("blocks repeated clicks across rerenders while Gmail is still processing", async () => {
		let resolve!: (state: EmailDraftState) => void;
		const actEmailDraft = vi.fn(
			() =>
				new Promise<EmailDraftState>((done) => {
					resolve = done;
				}),
		);
		const ctx = context({ actEmailDraft });
		const card = renderInteractionCard(item, ctx);
		const send = click(card, "Send email");
		send.click();
		const remounted = renderInteractionCard(item, ctx);
		expect(click(remounted, "Send email").disabled).toBe(true);
		expect(click(remounted, "Discard").disabled).toBe(true);
		expect(actEmailDraft).toHaveBeenCalledTimes(1);
		resolve({ ...ready, status: "sent" });
		await ctx.emailDraft?.pending;
		expect(remounted.querySelector(".email-draft-status")?.textContent).toBe("Sent");
	});

	it("does not claim success or offer another send after an ambiguous failure", async () => {
		const ctx = context({
			actEmailDraft: vi.fn(async () => {
				throw new Error("Connection interrupted");
			}),
			loadEmailDraft: vi.fn(async (): Promise<EmailDraftState> => ({ ...ready, status: "sent" })),
		});
		const card = renderInteractionCard(item, ctx);
		edit(card, "Subject", "Keep this edit");
		click(card, "Send email");
		await ctx.emailDraft?.pending;
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Send unconfirmed");
		expect(card.querySelector("[role=alert]")?.textContent).toBe("Connection interrupted");
		expect(card.querySelector<HTMLInputElement>("[aria-label=Subject]")?.value).toBe("Keep this edit");
		expect(click(card, "Send email").disabled).toBe(true);
		click(card, "Refresh");
		await ctx.emailDraft?.pending;
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(ctx.actEmailDraft).toHaveBeenCalledTimes(1);
	});

	it("shows confirmed provider errors and allows correction, without losing the edited letter", async () => {
		const ctx = context({
			actEmailDraft: vi.fn(async (_action, content) => ({
				...ready,
				content,
				error: "Gmail refused this recipient",
			})),
		});
		const card = renderInteractionCard(item, ctx);
		edit(card, "Subject", "Keep me");
		click(card, "Send email");
		await ctx.emailDraft?.pending;
		expect(card.querySelector("[role=alert]")?.textContent).toBe("Gmail refused this recipient");
		expect(card.querySelector<HTMLInputElement>("[aria-label=Subject]")?.value).toBe("Keep me");
		expect(card.querySelector<HTMLInputElement>("[aria-label=To]")?.readOnly).toBe(false);
		expect(card.querySelector(".email-draft-status")?.textContent).not.toBe("Sent");
	});
	it.each(["save", "discard"] as const)(
		"locks every action and edit after a lost %s response until recovery",
		async (action) => {
			const ctx = context({
				actEmailDraft: vi.fn(async () => {
					throw new Error("Response lost");
				}),
				loadEmailDraft: vi.fn(
					async (): Promise<EmailDraftState> => ({
						...ready,
						status: action === "save" ? "saved" : "discarded",
					}),
				),
			});
			let card = renderInteractionCard(item, ctx);
			click(card, action === "save" ? "Save to Gmail" : "Discard");
			await ctx.emailDraft?.pending;
			// Navigation must retain the unresolved operation as well as its text.
			card = renderInteractionCard(item, ctx);
			expect(card.querySelector(".email-draft-status")?.textContent).toBe("Action unconfirmed");
			for (const field of card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
				expect(field.readOnly).toBe(true);
			for (const label of ["Send email", "Save to Gmail", "Discard"]) expect(click(card, label).disabled).toBe(true);
			expect(ctx.actEmailDraft).toHaveBeenCalledOnce();
			click(card, "Refresh");
			await ctx.emailDraft?.pending;
			expect(ctx.loadEmailDraft).toHaveBeenCalledOnce();
			expect(ctx.emailDraft?.unconfirmedAction).toBeUndefined();
			expect(card.querySelector(".email-draft-status")?.textContent).toBe(
				action === "save" ? "Saved to Gmail" : "Discarded",
			);
			if (action === "save") expect(card.querySelector<HTMLInputElement>("[aria-label=To]")?.readOnly).toBe(false);
			else expect(card.querySelector("button")).toBeNull();
		},
	);

	it("discards through the provider path and never sends an unverified interaction answer", async () => {
		const ctx = context();
		const card = renderInteractionCard(item, ctx);
		click(card, "Discard");
		await ctx.emailDraft?.pending;
		expect(ctx.actEmailDraft).toHaveBeenCalledWith("discard", ready.content);
		expect(ctx.answer).not.toHaveBeenCalled();
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Discarded");
		expect(card.querySelector("button")).toBeNull();
	});
	it.each(["ready", "saved"] as const)(
		"retains edits when recovery returns the same prior %s receipt after a local refusal",
		async (status) => {
			const previous: EmailDraftState = {
				...ready,
				status,
				...(status === "saved" ? { actionId: "prior-save" } : {}),
			};
			const ctx = context({
				emailDraft: { state: structuredClone(previous) },
				actEmailDraft: vi.fn(async () => {
					throw new Error("Select an active model account, then try again.");
				}),
				loadEmailDraft: vi.fn(async () => structuredClone(previous)),
			});
			let card = renderInteractionCard(item, ctx);
			edit(card, "To", "corrected@example.com");
			edit(card, "Subject", "Locally revised subject");
			edit(card, "Email body", "Locally revised letter");
			click(card, "Send email");
			await ctx.emailDraft?.pending;
			card = renderInteractionCard(item, ctx);
			expect(click(card, "Send email").disabled).toBe(true);
			click(card, "Refresh");
			await ctx.emailDraft?.pending;
			expect(card.querySelector<HTMLInputElement>("[aria-label=To]")?.value).toBe("corrected@example.com");
			expect(card.querySelector<HTMLInputElement>("[aria-label=Subject]")?.value).toBe("Locally revised subject");
			expect(card.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Locally revised letter");
			expect(card.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(false);
			expect(card.querySelector<HTMLButtonElement>(".email-draft-send")?.disabled).toBe(false);
			expect(card.querySelector(".email-draft-status")?.textContent).toBe("Ready to send");
			expect(ctx.emailDraft?.unconfirmedAction).toBeUndefined();
		},
	);
	it.each(["saved", "sent", "discarded"] as const)(
		"uses authoritative %s content when recovery observes an admitted action",
		async (status) => {
			const recovered: EmailDraftState = {
				...ready,
				status,
				actionId: "different-action",
				content: { ...ready.content, body: "Authoritative letter" },
			};
			const ctx = context({
				actEmailDraft: vi.fn(async () => {
					throw new Error("Response lost");
				}),
				loadEmailDraft: vi.fn(async () => recovered),
			});
			const card = renderInteractionCard(item, ctx);
			edit(card, "Email body", "Local letter");
			click(card, "Send email");
			await ctx.emailDraft?.pending;
			click(card, "Refresh");
			await ctx.emailDraft?.pending;
			if (status === "sent") {
				expect(card.querySelector(".email-sent-body")?.textContent).toBe("Authoritative letter");
				expect(card.querySelector("input, textarea")).toBeNull();
			} else {
				expect(card.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Authoritative letter");
				expect(card.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(status !== "saved");
			}
		},
	);

	it("retries a failed agent notification without ever offering to resend the email", async () => {
		const ctx = context({
			emailDraft: { state: { ...ready, status: "sent", notificationPending: true } },
			loadEmailDraft: vi.fn(
				async (): Promise<EmailDraftState> => ({ ...ready, status: "sent", notificationPending: false }),
			),
		});
		const card = renderInteractionCard(item, ctx);
		expect(card.textContent).toContain("The agent has not been notified yet.");
		expect([...card.querySelectorAll("button")].map((control) => control.textContent)).toEqual([
			"Retry notifying agent",
		]);
		click(card, "Retry notifying agent");
		await ctx.emailDraft?.pending;
		expect(ctx.loadEmailDraft).toHaveBeenCalledOnce();
		expect(ctx.actEmailDraft).not.toHaveBeenCalled();
		expect(card.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(card.querySelector("button")).toBeNull();
	});
	it("does not let a late network rejection undo an authoritative terminal transcript", async () => {
		let reject!: (error: Error) => void;
		const ctx = context({
			actEmailDraft: () =>
				new Promise<EmailDraftState>((_resolve, fail) => {
					reject = fail;
				}),
		});
		const card = renderInteractionCard(item, ctx);
		click(card, "Send email");
		const delivered = { ...ready.content, body: "Delivered letter" };
		const finalCard = renderInteractionCard(
			{ ...item, answer: { outcome: "sent", answer: { content: delivered } } },
			ctx,
		);
		reject(new Error("Late lost response"));
		await ctx.emailDraft?.pending;
		expect(finalCard.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(finalCard.querySelector(".email-sent-body")?.textContent).toBe("Delivered letter");
		expect(finalCard.querySelector("[role=alert]")).toBeNull();
		expect(ctx.emailDraft?.unconfirmedAction).toBeUndefined();
	});

	it("uses the trusted final transcript sender without needing to reload a historical receipt", () => {
		const ctx = context({
			emailDraft: {},
			loadEmailDraft: vi.fn(async () => {
				throw new Error("Unavailable");
			}),
		});
		const card = renderInteractionCard(
			{
				...item,
				answer: { outcome: "sent", answer: { from: "actual-sender@example.com", content: { ...ready.content } } },
			},
			ctx,
		);
		expect(card.querySelector(".email-draft-from")?.textContent).toBe("actual-sender@example.com");
		expect(card.querySelector(".email-sent-body")?.textContent).toBe(ready.content.body);
		expect(card.querySelector("details")?.open).toBe(false);
		expect(card.querySelector("input, textarea")).toBeNull();
		expect(ctx.loadEmailDraft).not.toHaveBeenCalled();
		expect(card.textContent).not.toContain("spoofed@example.com");
	});

	it("renders terminal, expired, and other-member drafts without actionable controls", () => {
		const other = renderInteractionCard(item, context({ canAnswer: false }));
		expect(other.querySelector("button:not([hidden])")).toBeNull();
		expect(other.querySelector<HTMLInputElement>("[aria-label=To]")?.readOnly).toBe(true);
		const expired = renderInteractionCard(
			{ ...item, request: { ...item.request, expiresAt: "2000-01-01T00:00:00Z" } },
			context(),
		);
		expect(expired.querySelector(".email-draft-status")?.textContent).toBe("Expired");
		expect(expired.querySelector(".email-draft-actions")).toBeNull();
		const unconfirmed = renderInteractionCard(
			item,
			context({ emailDraft: { state: { ...ready, status: "unconfirmed" } } }),
		);
		expect(click(unconfirmed, "Send email").disabled).toBe(true);
		expect(unconfirmed.querySelector(".email-draft-status")?.textContent).not.toBe("Sent");
	});
});
