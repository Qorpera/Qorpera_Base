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

function connections(): NativeExecutionConnections {
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
		connections: [80, 81].map((n) => ({
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
function selector(): HTMLSelectElement {
	return document.querySelector<HTMLSelectElement>('[aria-label="Model account for this conversation"]')!;
}
function choose(value: string): void {
	selector().value = value;
	selector().dispatchEvent(new Event("change"));
}
function setup(room = false) {
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
	const listConnections = vi.fn(async () => connections());
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
	return { ...f, company, native, listConnections, listSessionTurnProvenance, view, sendMessage, read, cancel };
}
function refresh(): void {
	[...document.querySelectorAll<HTMLButtonElement>("button")]
		.find((button) => button.textContent === "Refresh model accounts")!
		.click();
}

describe("conversation execution account", () => {
	it("keeps team-room text and explicit account choice without single-agent run or turn history", async () => {
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
		const send = f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
		expect(send.disabled).toBe(true);
		expect(f.view.el.querySelector(".messages")!.textContent).toContain("Earlier room message");
		expect(f.view.el.textContent).toContain("Multiple agents can respond in this room");
		expect(f.view.el.textContent).toContain("Company-wide execution pause is available in Settings → Company");
		expect(f.view.el.querySelector(".session-run")).toBeNull();
		expect(f.view.el.textContent).not.toContain("Execution history");
		choose(id(90));
		await settle();
		expect(send.disabled).toBe(false);
		send.click();
		await settle();
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello team", expect.any(AbortSignal));
		expect(f.listConnections).toHaveBeenCalledTimes(3);
		expect(f.listSessionTurnProvenance).not.toHaveBeenCalled();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.cancel).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
	});

	it("rejects picker, pasted and dropped images in team rooms without losing the text draft", async () => {
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
		expect(f.view.el.textContent).toContain("Images are not supported in team rooms. Use Company File.");
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

	it("requires explicit own-account choice and never enables a sponsor automatically", async () => {
		const f = setup();
		await settle();
		expect(selector().value).toBe("");
		expect(f.company.conversation(session.sessionId).get().executionSponsor).toBeUndefined();
		const input = f.view.el.querySelector("textarea")!;
		input.value = "Hello";
		input.dispatchEvent(new Event("input"));
		await settle();
		expect(f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
		choose(id(90));
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor?.connectionId).toBe(id(90));
		expect(f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
	});

	it("refuses another member's account and connections lacking an active binding", async () => {
		const f = setup();
		await settle();
		const other = connections();
		f.listConnections.mockResolvedValue({
			...other,
			computeIdentity: { ...other.computeIdentity!, ownerUserId: userB.id },
		});
		refresh();
		await settle();
		expect([...selector().options].filter((option) => option.value).every((option) => option.disabled)).toBe(true);
		choose(id(90));
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor).toBeUndefined();
		f.listConnections.mockResolvedValue({
			...other,
			connections: [{ ...other.connections[0]!, sponsorBindingId: undefined, sponsorVersion: undefined }],
		});
		refresh();
		await settle();
		expect(selector().options[1]!.disabled).toBe(true);
		expect(f.view.el.textContent).toContain("Settings → Connections");
	});

	it("locks an uncertain retry to its original sponsor across refreshes and attempted selection", async () => {
		const f = setup();
		await settle();
		choose(id(90));
		await settle();
		const selected = f.company.conversation(session.sessionId).get().executionSponsor!;
		f.company.conversation(session.sessionId).set({
			retrySend: {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Hello",
				files: [],
				executionSponsor: selected,
			},
		});
		await settle();
		expect(selector().disabled).toBe(true);
		choose(id(91));
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor).toEqual(selected);
		refresh();
		await settle();
		expect(selector().value).toBe(id(90));
		expect(selector().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("Retry keeps the original model account");
	});

	it("does not silently adopt a changed sponsor version on refresh", async () => {
		const f = setup();
		await settle();
		choose(id(90));
		await settle();
		const observed = connections();
		f.listConnections.mockResolvedValue({
			...observed,
			connections: observed.connections.map((c) => ({ ...c, sponsorVersion: 2 })),
		});
		refresh();
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor?.sponsorVersion).toBe(1);
		const input = f.view.el.querySelector("textarea")!;
		input.value = "Hello";
		input.dispatchEvent(new Event("input"));
		await settle();
		expect(f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
		choose("");
		choose(id(90));
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor?.sponsorVersion).toBe(2);
	});

	it("explicitly releases a failed attempt for a new account choice while preserving the draft and files", async () => {
		const f = setup();
		await settle();
		choose(id(90));
		await settle();
		const selected = f.company.conversation(session.sessionId).get().executionSponsor!;
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
		expect(selector().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("The earlier message may already have been accepted");
		[...f.view.el.querySelectorAll<HTMLButtonElement>("button")]
			.find((b) => b.textContent === "Start a new message request")!
			.click();
		await settle();
		const state = f.company.conversation(session.sessionId).get();
		expect(state.retrySend).toBeUndefined();
		expect(state.draft).toBe("Keep this draft");
		expect(state.attachments?.[0]).toBe(image);
		expect(selector().disabled).toBe(false);
		choose(id(91));
		await settle();
		expect(f.company.conversation(session.sessionId).get().executionSponsor?.connectionId).toBe(id(91));
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
	});

	it("requires current account authority for an edited draft after an uncertain send", async () => {
		const f = setup();
		await settle();
		choose(id(90));
		await settle();
		const selected = f.company.conversation(session.sessionId).get().executionSponsor!;
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
		const send = f.view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
		expect(send.disabled).toBe(false);
		const input = f.view.el.querySelector("textarea")!;
		input.value = "Changed message";
		input.dispatchEvent(new Event("input"));
		await settle();
		expect(send.disabled).toBe(true);
	});

	it("refreshes accounts when returning from account settings", async () => {
		const f = setup();
		await settle();
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(f.listConnections).toHaveBeenCalledTimes(2);
		expect(selector().value).toBe("");
	});

	it("renders cloud provenance and clears account data on access loss or disposal", async () => {
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
		expect(f.view.el.textContent).toContain("openai · Account A · completed");
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
