// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	SessionTurnProvenance,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WebNativeSubscription } from "../src/cloud/native-subscription.ts";
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
function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const listConnections = vi.fn(async () => connections());
	const listSessionTurnProvenance = vi.fn(async (): Promise<readonly SessionTurnProvenance[]> => []);
	const native: WebNativeSubscription = {
		listConnections,
		listSessionTurnProvenance,
		requestSessionTurn: vi.fn(),
		createMemberSponsor: vi.fn(),
		revokeConnection: vi.fn(),
	};
	const sendMessage = vi.fn(async () => true);
	const view = new ConversationView(company, session.sessionId, { nativeSubscription: native, sendMessage });
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, native, listConnections, listSessionTurnProvenance, view, sendMessage };
}
function refresh(): void {
	[...document.querySelectorAll<HTMLButtonElement>("button")]
		.find((button) => button.textContent === "Refresh model accounts")!
		.click();
}

describe("conversation execution account", () => {
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
