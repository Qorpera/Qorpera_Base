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
