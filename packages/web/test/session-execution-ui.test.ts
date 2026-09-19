// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	SessionTurnProvenance,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WebNativeSubscription } from "../src/cloud/native-subscription.ts";
import { AGENT_SEND_SCHEMA, projectTranscript, RUNNER_ENTRY_SCHEMA } from "../src/cloud/transcript.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function connections(count = 2): NativeExecutionConnections {
	return {
		computeIdentity: {
			computeIdentityId: id(80),
			ownershipKind: "member",
			ownerUserId: userA.id,
			displayName: "My compute",
			templateKey: "member",
			templateVersion: "1",
			capabilities: ["agent_turn"],
			policy: {},
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		connections: [80, 81].slice(0, count).map((n) => ({
			connectionId: id(n + 10),
			connectionVersion: 1,
			provider: n === 80 ? "openai" : "anthropic",
			nativeHarness: n === 80 ? "codex-cli" : "claude-code",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "subscription",
			consentVersion: "1",
			consentedAt: timestamp,
			connectionStatus: "active",
			sponsorBindingId: id(n + 20),
			sponsorVersion: 1,
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 1 },
		})),
	};
}
function withSponsorVersion(observed: NativeExecutionConnections, sponsorVersion: number): NativeExecutionConnections {
	return { ...observed, connections: observed.connections.map((c) => ({ ...c, sponsorVersion })) };
}
/** The picker exists only while the member has more than one usable account. */
function selector(): HTMLSelectElement | null {
	return document.querySelector<HTMLSelectElement>('[aria-label="Model account for this conversation"]');
}
function choose(value: string): void {
	selector()!.value = value;
	selector()!.dispatchEvent(new Event("change"));
}
function setup(room = false, observed: NativeExecutionConnections = connections()) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team,
		staff: [staff],
		sessions: [
			{
				...session,
				staffAgentId: room ? undefined : staff.id,
				executionScope: room ? { roomId: id(190) } : undefined,
			},
		],
		loading: false,
	});
	const listConnections = vi.fn(async () => structuredClone(observed));
	const listSessionTurnProvenance = vi.fn(async (): Promise<readonly SessionTurnProvenance[]> => []);
	const native: WebNativeSubscription = {
		onboardingAvailable: false,
		beginProviderLogin: vi.fn(),
		listConnections,
		listSessionTurnProvenance,
		requestSessionTurn: vi.fn(),
		createMemberSponsor: vi.fn(),
		revokeConnection: vi.fn(),
	};
	const sendMessage = vi.fn(async () => true);
	const read = vi.fn(async () => ({ sessionId: session.sessionId, staffAgentId: staff.id, run: null }));
	const cancel = vi.fn(async () => "cancelled" as const);
	const view = new ConversationView(company, session.sessionId, {
		nativeSubscription: native,
		sendMessage,
		runControl: room ? { read, cancel } : undefined,
	});
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const sponsor = () => company.conversation(session.sessionId).get().executionSponsor;
	const send = () => view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
	return {
		...f,
		company,
		native,
		listConnections,
		listSessionTurnProvenance,
		view,
		sendMessage,
		read,
		cancel,
		sponsor,
		send,
	};
}
/** Accounts are re-read when the member returns to the window; there is no refresh button. */
function refresh(): void {
	window.dispatchEvent(new Event("focus"));
}
function type(view: ConversationView, text: string): void {
	const input = view.el.querySelector("textarea")!;
	input.value = text;
	input.dispatchEvent(new Event("input"));
}
function buttonNamed(view: ConversationView, label: string): HTMLButtonElement | undefined {
	return [...view.el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
}
const CONNECT_HINT = "Connect a model account in Settings → Connections to send messages.";

describe("conversation execution account", () => {
	it("keeps group-chat text and the member's own account without single-agent run or turn history", async () => {
		const f = setup(true);
		await settle();
		const state = f.company.conversation(session.sessionId);
		state.set({
			draft: "Hello team",
			projection: {
				...state.get().projection,
				items: [
					{
						kind: "member",
						id: id(191),
						sequence: 1,
						authorUserId: userA.id,
						text: "Earlier room message",
						attachmentCount: 0,
						createdAt: timestamp,
					},
				],
			},
		});
		await settle();
		expect(f.view.el.querySelector(".messages")!.textContent).toContain("Earlier room message");
		expect(f.view.el.textContent).toContain("Multiple agents can respond in this group chat");
		expect(f.view.el.textContent).toContain("Company-wide execution pause is available in Settings → Company");
		expect(f.view.el.querySelector(".session-run")).toBeNull();
		expect(f.view.el.textContent).not.toContain("Execution history");
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.send().disabled).toBe(false);
		f.send().click();
		await settle();
		refresh();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello team", expect.any(AbortSignal));
		expect(f.listConnections).toHaveBeenCalledTimes(3);
		expect(f.listSessionTurnProvenance).not.toHaveBeenCalled();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.cancel).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
	});

	it("rejects picker, pasted and dropped images in group chats without losing the text draft", async () => {
		const f = setup(true);
		await settle();
		f.company.conversation(session.sessionId).set({ draft: "Keep team text" });
		await settle();
		const image = new File(["image"], "local.png", { type: "image/png" });
		const input = f.view.el.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", { value: [image] });
		input.dispatchEvent(new Event("change"));
		const shell = f.view.el.querySelector(".composer-shell")!;
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [image] } });
		shell.dispatchEvent(paste);
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(drop, "dataTransfer", { value: { files: [image] } });
		shell.dispatchEvent(drop);
		await settle();
		expect(paste.defaultPrevented).toBe(true);
		expect(drop.defaultPrevented).toBe(true);
		expect(f.company.conversation(session.sessionId).get().attachments ?? []).toEqual([]);
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Keep team text");
		expect(f.view.el.querySelector<HTMLButtonElement>(".composer-more")!.hidden).toBe(true);
		expect(f.view.el.textContent).toContain("Images are not supported in group chats. Use Company File.");
		expect(f.sendMessage).not.toHaveBeenCalled();
	});
	it("does not attribute a room agent reply to the room title or its human creator", async () => {
		const f = setup(true);
		await settle();
		const execution = { kind: "run" as const, id: id(193), claimantId: id(194), runnerAssignmentId: id(195) };
		f.company.conversation(session.sessionId).set({
			projection: projectTranscript([
				{
					sessionId: session.sessionId,
					eventId: id(192),
					sequence: 1,
					eventType: "message",
					actorUserId: userA.id,
					eventHash: "a".repeat(64),
					createdAt: timestamp,
					execution,
					body: {
						schema: RUNNER_ENTRY_SCHEMA,
						entry: {
							type: "message",
							id: id(192),
							execution,
							message: { role: "assistant", content: [{ type: "text", text: "Room response" }] },
							delivery: { schema: AGENT_SEND_SCHEMA, phase: "final" },
						},
					},
				},
			]),
		});
		await settle();
		const reply = f.view.el.querySelector<HTMLElement>(".from-agent")!;
		expect(reply.querySelector(".message-author")!.textContent).toBe("Agent reply · speaker unavailable");
		expect(reply.getAttribute("aria-label")).toMatch(/^Agent reply · /);
		expect(reply.title).toMatch(/^Agent reply · /);
		expect(reply.getAttribute("aria-label")).not.toContain(session.title);
		expect(reply.getAttribute("aria-label")).not.toContain(f.company.memberName(userA.id));
		expect(reply.textContent).toContain("Room response");
	});

	it("chooses the member's single usable account for them and shows no account controls", async () => {
		const f = setup(false, connections(1));
		expect(f.sponsor()).toBeUndefined();
		await settle();
		expect(f.sponsor()).toMatchObject({ connectionId: id(90), sponsorBindingId: id(100), sponsorVersion: 1 });
		expect(selector()).toBeNull();
		expect(f.view.el.querySelector(".session-execution label")).toBeNull();
		expect(buttonNamed(f.view, "Refresh model accounts")).toBeUndefined();
		expect(f.view.el.textContent).not.toContain("Execution history");
		expect(f.view.el.textContent).not.toContain(CONNECT_HINT);
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(false);
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
	});

	it("shows a picker only with several usable accounts and keeps the member's choice across refreshes", async () => {
		const f = setup();
		await settle();
		expect(selector()!.value).toBe(id(90));
		expect(f.sponsor()?.connectionId).toBe(id(90));
		choose(id(91));
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		refresh();
		await settle();
		expect(selector()!.value).toBe(id(91));
		expect(f.sponsor()?.connectionId).toBe(id(91));
		// The chosen account went away: the remaining usable one takes over and the picker goes.
		f.listConnections.mockResolvedValue(connections(1));
		refresh();
		await settle();
		expect(selector()).toBeNull();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(false);
	});

	it("never chooses another member's account or a connection lacking an active binding", async () => {
		const mine = connections();
		const f = setup(false, { ...mine, computeIdentity: { ...mine.computeIdentity!, ownerUserId: userB.id } });
		await settle();
		type(f.view, "Hello");
		await settle();
		expect(f.sponsor()).toBeUndefined();
		expect(selector()).toBeNull();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain(CONNECT_HINT);
		f.listConnections.mockResolvedValue({
			...mine,
			connections: [{ ...mine.connections[0]!, sponsorBindingId: undefined, sponsorVersion: undefined }],
		});
		refresh();
		await settle();
		expect(f.sponsor()).toBeUndefined();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain(CONNECT_HINT);
		// Only the bound account is usable, so it is the one chosen, without a picker.
		f.listConnections.mockResolvedValue({
			...mine,
			connections: [
				{ ...mine.connections[0]!, sponsorBindingId: undefined, sponsorVersion: undefined },
				mine.connections[1]!,
			],
		});
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(selector()).toBeNull();
		expect(f.send().disabled).toBe(false);
		expect(f.view.el.textContent).not.toContain(CONNECT_HINT);
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
	});

	it("locks an uncertain retry to its original sponsor across refreshes", async () => {
		const f = setup();
		await settle();
		const selected = f.sponsor()!;
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: selected,
		};
		f.company.conversation(session.sessionId).set({ retrySend: retained });
		await settle();
		expect(selector()).toBeNull();
		f.listConnections.mockResolvedValue(withSponsorVersion(connections(), 2));
		refresh();
		await settle();
		expect(selector()).toBeNull();
		expect(f.sponsor()).toEqual(selected);
		expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
		expect(f.view.el.textContent).toContain("Retry keeps the original model account");
	});

	it("re-binds the same account at its new sponsor version on refresh, but not during a retry", async () => {
		const f = setup();
		await settle();
		choose(id(91));
		await settle();
		expect(f.sponsor()).toMatchObject({ connectionId: id(91), sponsorVersion: 1 });
		f.listConnections.mockResolvedValue(withSponsorVersion(connections(), 2));
		refresh();
		await settle();
		expect(f.sponsor()).toMatchObject({ connectionId: id(91), sponsorVersion: 2 });
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(false);
		f.company.conversation(session.sessionId).set({
			retrySend: {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Hello",
				files: [],
				executionSponsor: f.sponsor()!,
			},
		});
		f.listConnections.mockResolvedValue(withSponsorVersion(connections(), 3));
		refresh();
		await settle();
		expect(f.sponsor()).toMatchObject({ connectionId: id(91), sponsorVersion: 2 });
		expect(f.company.conversation(session.sessionId).get().retrySend?.executionSponsor.sponsorVersion).toBe(2);
	});

	it("explicitly releases a failed attempt for a new account choice while preserving the draft and files", async () => {
		const f = setup();
		await settle();
		const selected = f.sponsor()!;
		const image = new File(["image"], "local.png", { type: "image/png" });
		f.company.conversation(session.sessionId).set({ sending: true });
		await settle();
		f.company.conversation(session.sessionId).set({
			sending: false,
			draft: "Keep this draft",
			attachments: [image],
			retrySend: {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Keep this draft",
				files: [image],
				executionSponsor: selected,
			},
		});
		await settle();
		expect(selector()).toBeNull();
		expect(f.view.el.textContent).toContain("The earlier message may already have been accepted");
		buttonNamed(f.view, "Start a new message request")!.click();
		await settle();
		const state = f.company.conversation(session.sessionId).get();
		expect(state.retrySend).toBeUndefined();
		expect(state.draft).toBe("Keep this draft");
		expect(state.attachments?.[0]).toBe(image);
		expect(selector()!.disabled).toBe(false);
		choose(id(91));
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
	});

	it.each(["direct draft", "room draft", "direct image"])(
		"requires explicit abandonment for an edited %s even with a valid sponsor",
		async (change) => {
			const f = setup(change === "room draft");
			await settle();
			const state = f.company.conversation(session.sessionId);
			const selected = state.get().executionSponsor!;
			const retained = {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Original",
				files: [],
				executionSponsor: selected,
			};
			state.set({ draft: "Original", retrySend: retained });
			await settle();
			const send = f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
			expect(send.disabled).toBe(false);
			const files = change === "direct image" ? [new File(["new image"], "new.png", { type: "image/png" })] : [];
			const draft = change === "direct image" ? "Original" : "Edited";
			state.set({ draft, attachments: files });
			await settle();
			expect(send.disabled).toBe(true);
			send.click();
			expect(f.sendMessage).not.toHaveBeenCalled();
			expect(state.get().retrySend).toBe(retained);
			expect(selector()).toBeNull();
			[...f.view.el.querySelectorAll<HTMLButtonElement>("button")]
				.find((b) => b.textContent === "Start a new message request")!
				.click();
			await settle();
			expect(state.get()).toMatchObject({ draft, attachments: files, executionSponsor: selected });
			expect(state.get().retrySend).toBeUndefined();
			expect(send.disabled).toBe(false);
			expect(f.sendMessage).not.toHaveBeenCalled();
		},
	);
	it("requires current account authority for an edited draft after an uncertain send", async () => {
		const f = setup();
		await settle();
		const selected = f.sponsor()!;
		f.company.conversation(session.sessionId).set({
			draft: "Original",
			retrySend: {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Original",
				files: [],
				executionSponsor: selected,
			},
		});
		f.listConnections.mockRejectedValue(new Error("Unavailable"));
		refresh();
		await settle();
		expect(f.send().disabled).toBe(false);
		type(f.view, "Changed message");
		await settle();
		expect(f.send().disabled).toBe(true);
	});

	it("picks up a newly connected account when returning from account settings", async () => {
		const f = setup(false, { ...connections(), connections: [] });
		await settle();
		type(f.view, "Hello");
		await settle();
		expect(f.view.el.textContent).toContain(CONNECT_HINT);
		expect(f.send().disabled).toBe(true);
		f.listConnections.mockResolvedValue(connections(1));
		refresh();
		await settle();
		expect(f.listConnections).toHaveBeenCalledTimes(2);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).not.toContain(CONNECT_HINT);
		expect(f.send().disabled).toBe(false);
	});

	it("reads cloud provenance without showing it and clears account data on access loss or disposal", async () => {
		const f = setup();
		await settle();
		f.listSessionTurnProvenance.mockResolvedValue([
			{
				turnRequestId: id(180),
				inputId: id(181),
				requestedByUserId: userA.id,
				sponsorMode: "member_connection",
				sponsoredByName: "Account A",
				provider: "openai",
				workerClass: "managed_sandbox",
				status: "materialized",
				runStatus: "completed",
				createdAt: timestamp,
			},
		]);
		refresh();
		await settle();
		expect(f.listSessionTurnProvenance).toHaveBeenCalledTimes(2);
		expect(f.view.el.textContent).not.toContain("Account A");
		expect(f.view.el.textContent).not.toContain("Execution history");
		const pending = deferred<NativeExecutionConnections>();
		f.listConnections.mockReturnValueOnce(pending.promise);
		refresh();
		f.company.store.set({ accessLost: true });
		await settle();
		pending.resolve(connections());
		await settle();
		expect(f.view.el.querySelector(".session-execution")!.textContent).toBe("");
		f.view.dispose();
		window.dispatchEvent(new Event("online"));
		await settle();
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
		expect(f.listConnections).toHaveBeenCalledTimes(3);
	});
});
