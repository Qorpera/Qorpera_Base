// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { EmailDraftState } from "../src/cloud/email-drafts.ts";
import type { SessionExecutionSponsor } from "../src/cloud/session-input.ts";
import type { TranscriptInteraction, TranscriptItem } from "../src/cloud/transcript.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

const ready: EmailDraftState = {
	from: "connected@example.com",
	status: "ready",
	content: { to: ["henrik@example.com"], cc: [], subject: "Introduction", body: "Hej Henrik,\n\nOm Qorpera." },
};
const draft: TranscriptInteraction = {
	kind: "interaction",
	id: id(600),
	sequence: 1,
	actorUserId: userA.id,
	createdAt: timestamp,
	request: {
		surface: "draft",
		title: "New email",
		payload: { platform: "email", connectorId: "gmail", ...ready.content },
	},
};
let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No external requests in this fixture")));
});

describe("email delivery notification recovery", () => {
	const sponsor: SessionExecutionSponsor = {
		connectionId: id(610),
		provider: "openai",
		nativeHarness: "codex-cli",
		sponsorBindingId: id(611),
		sponsorVersion: 1,
		computeIdentityId: id(612),
		workerClass: "managed_sandbox",
	};
	const receipt = {
		schema: "qorpera.email-draft-state/v1",
		companyId: profileA.profileId,
		...ready,
		status: "sent",
		actionId: id(613),
		messageId: "provider-message",
		notificationPending: true,
	};
	function controllerFixture() {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		vi.spyOn(company, "loadConversation").mockResolvedValue();
		vi.spyOn(company, "refreshActivity").mockResolvedValue();
		company.store.set({ team, sessions: [session], loading: false });
		company.conversation(session.sessionId).set({ executionSponsor: sponsor });
		vi.mocked(f.cloud.rpc).mockResolvedValue(receipt);
		const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue({ inputId: id(614), position: 1 });
		dispose = () => company.stop();
		return { ...f, company, answer };
	}

	it("notifies using the durable action UUID, canonical empty answer and currently selected sponsor", async () => {
		const f = controllerFixture();
		f.answer.mockRejectedValueOnce(new Error("Wake queue unavailable"));
		const failed = await f.company.loadEmailDraft(session.sessionId, draft.id);
		expect(failed).toMatchObject({ status: "sent", notificationPending: true, messageId: "provider-message" });
		expect(f.answer).toHaveBeenLastCalledWith(
			session.sessionId,
			receipt.actionId,
			draft.id,
			"sent",
			{},
			{
				sponsorBindingId: sponsor.sponsorBindingId,
				sponsorVersion: 1,
			},
		);
		// Retrying the notification follows the member's current model account.
		f.company
			.conversation(session.sessionId)
			.set({ executionSponsor: { ...sponsor, sponsorBindingId: id(615), sponsorVersion: 3 } });
		const recovered = await f.company.loadEmailDraft(session.sessionId, draft.id);
		expect(recovered).toMatchObject({ status: "sent", notificationPending: false });
		expect(f.answer).toHaveBeenLastCalledWith(
			session.sessionId,
			receipt.actionId,
			draft.id,
			"sent",
			{},
			{
				sponsorBindingId: id(615),
				sponsorVersion: 3,
			},
		);
		expect(f.answer).toHaveBeenCalledTimes(2);
		expect(vi.mocked(f.cloud.rpc).mock.calls.map(([name]) => name)).toEqual([
			"qorpera_get_email_draft",
			"qorpera_get_email_draft",
		]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves delivery when notification fails after a send and never calls the provider twice on recovery", async () => {
		vi.stubGlobal("crypto", webcrypto);
		const f = controllerFixture();
		let actionId = "";
		vi.mocked(f.cloud.rpc).mockImplementation(async (name, args) => {
			if (name === "qorpera_prepare_email_draft_action") {
				actionId = String(args?.p_client_action_id);
				return {
					...receipt,
					status: "sending",
					phase: "pending",
					actionId,
					brokerOrigin: "https://broker.example.com",
				};
			}
			return { ...receipt, actionId };
		});
		const provider = vi.fn(async () => new Response(JSON.stringify({ ...receipt, actionId })));
		vi.stubGlobal("fetch", provider);
		f.answer.mockRejectedValueOnce(new Error("Notification unavailable"));
		const sent = await f.company.actEmailDraft(session.sessionId, draft.id, "send", ready.content);
		expect(sent).toMatchObject({ status: "sent", notificationPending: true });
		expect(f.cloud.rpc).toHaveBeenCalledWith(
			"qorpera_prepare_email_draft_action",
			expect.objectContaining({
				p_sponsor_binding_id: sponsor.sponsorBindingId,
				p_sponsor_version: 1,
				p_action: "send",
				p_content: ready.content,
			}),
		);
		expect(f.answer).toHaveBeenLastCalledWith(
			session.sessionId,
			actionId,
			draft.id,
			"sent",
			{},
			{
				sponsorBindingId: sponsor.sponsorBindingId,
				sponsorVersion: 1,
			},
		);
		const restored = await f.company.loadEmailDraft(session.sessionId, draft.id);
		expect(restored).toMatchObject({ status: "sent", notificationPending: false });
		expect(provider).toHaveBeenCalledOnce();
		expect(f.answer).toHaveBeenCalledTimes(2);
		expect(f.answer.mock.calls[0]?.[1]).toBe(f.answer.mock.calls[1]?.[1]);
	});

	it("does not enqueue notifications as a viewer even with a model sponsor selected", async () => {
		const f = controllerFixture();
		f.company.store.set({
			team: { ...team, role: "viewer", capabilities: { ...team.capabilities, write: false, authorize: false } },
		});
		expect(await f.company.loadEmailDraft(session.sessionId, draft.id)).toMatchObject({
			status: "sent",
			notificationPending: true,
		});
		expect(f.answer).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves a discarded receipt until a sponsor is selected, then notifies without a provider action", async () => {
		const f = controllerFixture();
		vi.mocked(f.cloud.rpc).mockResolvedValue({ ...receipt, status: "discarded" });
		f.company.conversation(session.sessionId).set({ executionSponsor: undefined });
		expect(await f.company.loadEmailDraft(session.sessionId, draft.id)).toMatchObject({
			status: "discarded",
			notificationPending: true,
		});
		expect(f.answer).not.toHaveBeenCalled();
		f.company.conversation(session.sessionId).set({ executionSponsor: sponsor });
		expect(await f.company.loadEmailDraft(session.sessionId, draft.id)).toMatchObject({
			status: "discarded",
			notificationPending: false,
		});
		expect(f.answer).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			receipt.actionId,
			draft.id,
			"discarded",
			{},
			{
				sponsorBindingId: sponsor.sponsorBindingId,
				sponsorVersion: sponsor.sponsorVersion,
			},
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});
function setup(options: { reader?: boolean; item?: TranscriptInteraction; load?: Promise<EmailDraftState> } = {}) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	// This fixture publishes projected polling results directly; opening the view
	// must not replace them with the fixture API's empty event page.
	vi.spyOn(company, "loadConversation").mockResolvedValue();
	company.store.set({
		team: options.reader
			? { ...team, role: "viewer", capabilities: { ...team.capabilities, write: false, authorize: false } }
			: team,
		staff: [staff],
		sessions: [{ ...session, staffAgentId: staff.id }],
		loading: false,
	});
	vi.mocked(f.cloud.rpc).mockImplementation(async () => ({
		schema: "qorpera.email-draft-state/v1",
		companyId: profileA.profileId,
		...(await (options.load ?? Promise.resolve(ready))),
	}));
	const publish = (items: TranscriptItem[]) =>
		company
			.conversation(session.sessionId)
			.set({ loading: false, projection: { items, hiddenCount: 0, lastSequence: items.length } });
	publish([options.item ?? draft]);
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view, publish };
}
function body(view: ConversationView): HTMLTextAreaElement {
	return view.el.querySelector<HTMLTextAreaElement>(".email-draft-body")!;
}

describe("email drafts in a live conversation", () => {
	it("keeps the same editor, focus, caret and unsent text through polling and new messages", async () => {
		const f = setup();
		await settle();
		const card = f.view.el.querySelector(".email-draft-card");
		const field = body(f.view);
		field.value = "Unsent locally edited letter";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.focus();
		field.setSelectionRange(7, 14);
		f.publish([{ ...draft }]);
		f.view.update();
		expect(document.activeElement).toBe(field);
		f.publish([
			{ ...draft },
			{ kind: "agent", id: id(601), sequence: 2, text: "Another update", attachmentCount: 0, createdAt: timestamp },
		]);
		f.view.update();
		expect(f.view.el.querySelector(".email-draft-card")).toBe(card);
		expect(body(f.view)).toBe(field);
		expect(field.value).toBe("Unsent locally edited letter");
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([7, 14]);
		expect(f.cloud.rpc).toHaveBeenCalledTimes(1);
	});

	it("replaces stale local edits with the exact authoritative delivered transcript", async () => {
		const f = setup();
		await settle();
		body(f.view).value = "Unsaved local text";
		body(f.view).dispatchEvent(new Event("input", { bubbles: true }));
		const delivered = {
			...ready.content,
			to: ["changed@example.com"],
			subject: "Sent from another tab",
			body: "The actual sent letter",
		};
		f.publish([
			{
				...draft,
				answer: { outcome: "sent", pending: false, answer: { content: delivered }, answeredBy: userA.id },
			},
		]);
		f.view.update();
		expect(body(f.view).value).toBe(delivered.body);
		expect(f.view.el.querySelector<HTMLInputElement>(".email-draft-input[aria-label=To]")?.value).toBe(
			"changed@example.com",
		);
		expect(f.view.el.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(f.view.el.querySelector(".email-draft-actions")).toBeNull();
	});

	it("keeps a final receipt authoritative when an older sender read finishes afterward", async () => {
		const pending = deferred<EmailDraftState>();
		const f = setup({ load: pending.promise });
		const delivered = { ...ready.content, body: "The delivered letter" };
		f.publish([{ ...draft, answer: { outcome: "sent", answer: { content: delivered } } }]);
		f.view.update();
		pending.resolve(ready);
		await settle();
		expect(body(f.view).value).toBe(delivered.body);
		expect(f.view.el.querySelector(".email-draft-status")?.textContent).toBe("Sent");
		expect(f.view.el.querySelector(".email-draft-from")?.textContent).toBe(ready.from);
		expect(f.view.el.querySelector(".email-draft-actions")).toBeNull();
	});

	it("removes send/edit controls on a role downgrade but retains the letter", async () => {
		const f = setup();
		await settle();
		body(f.view).value = "Private draft";
		body(f.view).dispatchEvent(new Event("input", { bubbles: true }));
		f.company.store.set({
			team: { ...team, role: "viewer", capabilities: { ...team.capabilities, write: false, authorize: false } },
		});
		f.view.update();
		expect(body(f.view).value).toBe("Private draft");
		expect(body(f.view).readOnly).toBe(true);
		expect(f.view.el.querySelector(".email-draft-actions")).toBeNull();
		await expect(f.company.actEmailDraft(session.sessionId, draft.id, "send", ready.content)).rejects.toThrow();
		expect(f.cloud.rpc).toHaveBeenCalledTimes(1);
	});

	it("loads the trusted sender for a read-only thread viewer without enabling writes", async () => {
		const f = setup({ reader: true });
		await settle();
		expect(f.cloud.rpc).toHaveBeenCalledExactlyOnceWith("qorpera_get_email_draft", {
			p_session_id: session.sessionId,
			p_interaction_id: draft.id,
		});
		expect(f.view.el.querySelector(".email-draft-from")?.textContent).toBe(ready.from);
		expect(body(f.view).readOnly).toBe(true);
		expect(f.view.el.querySelector(".email-draft-actions")).toBeNull();
		expect(f.view.el.querySelector(".email-draft-status")?.textContent).not.toBe("Account unavailable");
	});

	it("disables a card that expires while unchanged transcript polling continues", async () => {
		vi.setSystemTime(new Date("2026-09-25T16:00:00Z"));
		const f = setup({ item: { ...draft, request: { ...draft.request, expiresAt: "2026-09-25T16:01:00Z" } } });
		await settle();
		expect(body(f.view).readOnly).toBe(false);
		vi.setSystemTime(new Date("2026-09-25T16:02:00Z"));
		f.view.update();
		expect(body(f.view).readOnly).toBe(true);
		expect(f.view.el.querySelector(".email-draft-status")?.textContent).toBe("Expired");
		expect(f.view.el.querySelector(".email-draft-actions")).toBeNull();
	});
});
