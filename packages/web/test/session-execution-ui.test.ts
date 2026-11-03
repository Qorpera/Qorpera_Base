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
	vi.useRealTimers();
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
			clientConnectionId: id(n + 110),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
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
/** Account selection is automatic; there must never be a conversation picker. */
function selector(): HTMLSelectElement | null {
	return document.querySelector<HTMLSelectElement>('[aria-label="Model account for this conversation"]');
}
function withUsage(remaining: readonly (number | undefined)[]): NativeExecutionConnections {
	const observed = connections();
	return {
		...observed,
		connections: observed.connections.map((connection, index) => ({
			...connection,
			providerAccountReference: `codex-cli:${"a".repeat(64)}`,
			...(remaining[index] === undefined
				? {}
				: {
						providerAccountUsage: {
							observedAt: new Date().toISOString(),
							windows: [
								{
									id: "primary" as const,
									label: "5 hours",
									usedPercent: 100 - remaining[index]!,
									resetAt: "2099-01-01T00:00:00.000Z",
								},
							],
						},
					}),
		})),
	};
}

function setup(
	room = false,
	observed: NativeExecutionConnections = connections(),
	selectSessionAccount?: WebNativeSubscription["selectSessionAccount"],
	refreshAccountMetadata?: WebNativeSubscription["refreshAccountMetadata"],
	chooseSessionAccount?: WebNativeSubscription["chooseSessionAccount"],
) {
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
		...(selectSessionAccount ? { selectSessionAccount } : {}),
		...(refreshAccountMetadata ? { refreshAccountMetadata } : {}),
		...(chooseSessionAccount ? { chooseSessionAccount } : {}),
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
const CONNECT_HINT = "Connect a model account in Settings → My connections to send messages.";

describe("room startup usage refresh", () => {
	it("selects a known eligible account and sends while the optional usage probe remains pending", async () => {
		const pending = deferred<void>();
		const hydrate = vi.fn(() => pending.promise);
		const select = vi.fn(async () => id(90));
		const f = setup(false, connections(), select, hydrate);
		await settle();
		expect(hydrate).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledOnce();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Send without waiting for usage");
		await settle();
		expect(f.send().disabled).toBe(false);
		f.send().click();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Send without waiting for usage",
			expect.any(AbortSignal),
		);
		expect(select.mock.calls.length).toBeGreaterThan(1);
		expect(hydrate).toHaveBeenCalledTimes(1);
	});
	it("keeps send disabled, without a status message, until authoritative selection resolves", async () => {
		const pending = deferred<string>();
		const select = vi.fn(() => pending.promise);
		const f = setup(false, connections(), select);
		await settle();
		type(f.view, "Keep my draft");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.querySelector(".session-execution")!.textContent).not.toContain("Checking model accounts");
		expect(f.view.el.querySelector(".session-execution [role='status']")).toBeNull();
		pending.resolve(id(90));
		await settle();
		expect(f.send().disabled).toBe(false);
	});
	it("keeps eligible accounts usable after a failed optional probe without rapidly retrying it", async () => {
		const hydrate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
		const select = vi.fn(async () => id(90));
		const f = setup(false, connections(), select, hydrate);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(false);
		expect(f.view.el.textContent).not.toContain("Model accounts are unavailable");
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(hydrate).toHaveBeenCalledOnce();
		expect(f.send().disabled).toBe(false);
	});
	it("polls and follows the cloud's account choice without overlapping a slow optional probe", async () => {
		vi.useFakeTimers();
		const pending = deferred<void>();
		const hydrate = vi.fn(() => pending.promise);
		const select = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 40]), select, hydrate);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		select.mockResolvedValue(id(91));
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.sponsor()?.connectionId).toBe(id(91));
		await vi.advanceTimersByTimeAsync(90_000);
		expect(hydrate).toHaveBeenCalledOnce();
		expect(select).toHaveBeenCalledTimes(5);
		// Successful hydration can discover that the second account is now exhausted.
		select.mockResolvedValue(id(90));
		f.listConnections.mockResolvedValue(withUsage([80, 0]));
		pending.resolve();
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(hydrate).toHaveBeenCalledOnce();
	});
	it("does not cancel a send when a newly due optional probe resolves during its account check", async () => {
		vi.useFakeTimers();
		const hydrate = vi.fn(async () => {});
		const select = vi.fn(async () => id(90));
		const observed = withUsage([80, 40]);
		observed.connections[0]!.providerAccountUsage!.windows[0]!.resetAt = new Date(Date.now() + 30_000).toISOString();
		const f = setup(true, observed, select, hydrate);
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		type(f.view, "Send after the metadata interval");
		await settle();
		// Pass the known reset without firing the background poll first.
		vi.setSystemTime(Date.now() + 60_000);
		f.send().click();
		await settle();
		expect(hydrate).toHaveBeenCalledTimes(2);
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Send after the metadata interval",
			expect.any(AbortSignal),
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.sendMessage).toHaveBeenCalledOnce();
	});
	it.each(["retry", "sending"] as const)("keeps account identity when a probe finishes during %s", async (mode) => {
		vi.useFakeTimers();
		const pending = deferred<void>();
		const hydrate = vi.fn(() => pending.promise);
		const select = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 40]), select, hydrate);
		await settle();
		const original = f.sponsor()!;
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: original,
		};
		f.company.conversation(session.sessionId).set({
			draft: "Hello",
			...(mode === "retry" ? { retrySend: retained } : { sending: true }),
		});
		select.mockResolvedValue(id(91));
		f.listConnections.mockResolvedValue(withUsage([0, 80]));
		pending.resolve();
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(select).toHaveBeenCalledOnce();
		expect(f.sponsor()).toBe(original);
		if (mode === "retry") expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
	});
	it.each(["disposed", "access lost"] as const)(
		"aborts the optional probe when %s and ignores its late result",
		async (mode) => {
			vi.useFakeTimers();
			const pending = deferred<void>();
			const hydrate = vi.fn<NonNullable<WebNativeSubscription["refreshAccountMetadata"]>>(() => pending.promise);
			const select = vi.fn(async () => id(90));
			const f = setup(true, withUsage([80, 40]), select, hydrate);
			await settle();
			const signal = hydrate.mock.calls[0]![0]!;
			expect(signal.aborted).toBe(false);
			if (mode === "disposed") f.view.dispose();
			else f.company.store.set({ accessLost: true });
			await settle();
			expect(signal.aborted).toBe(true);
			pending.resolve();
			await settle();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(select).toHaveBeenCalledOnce();
			expect(f.listConnections).toHaveBeenCalledOnce();
		},
	);
});

describe("conversation execution account", () => {
	it("does not select Claude even when its reported allowance exceeds Codex", async () => {
		const observed = withUsage([20, 100]);
		observed.connections[1]!.provider = "anthropic";
		observed.connections[1]!.nativeHarness = "claude-code";
		const f = setup(true, observed);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		f.listConnections.mockResolvedValue({ ...observed, connections: [observed.connections[1]!] });
		refresh();
		await settle();
		type(f.view, "Hello");
		expect(f.send().disabled).toBe(true);
	});

	it("polls the authoritative selection without window focus and waits on an exhausted account", async () => {
		vi.useFakeTimers();
		const select = vi.fn(async (): Promise<string | undefined> => id(90));
		const choose = vi.fn(async (_session: string, connection: string) => connection);
		const f = setup(true, withUsage([80, 40]), select, undefined, choose);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		// The cloud keeps the conversation's account at its limit (20260930059000).
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("This conversation's model account has reached its usage limit");
		expect(f.view.el.textContent).not.toContain("Your model accounts have reached");
		expect(f.view.el.textContent).not.toContain("Choose a login to continue.");
		// The member disconnected that account: the cloud gives the conversation no account until the member picks one.
		select.mockResolvedValue(undefined);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.textContent).toContain("Choose a login to continue.");
		expect(f.send().disabled).toBe(true);
		expect(choose).not.toHaveBeenCalled();
		select.mockResolvedValue(id(91));
		buttonNamed(f.view, "Use Model account 1")!.click();
		await settle();
		expect(choose).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(91), expect.any(AbortSignal));
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(select).toHaveBeenCalledTimes(4);
	});

	it("resumes sending at a known quota reset before the next regular poll", async () => {
		vi.useFakeTimers();
		const resetAt = Date.now() + 10_000;
		const observed = withUsage([0, 0]);
		observed.connections[0]!.usageLimitResetAt = new Date(resetAt).toISOString();
		observed.connections[0]!.providerAccountUsage!.windows[0]!.resetAt = new Date(resetAt).toISOString();
		const select = vi.fn(async () => (Date.now() >= resetAt ? id(90) : undefined));
		const f = setup(true, observed, select);
		await settle();
		type(f.view, "Waiting for reset");
		expect(f.send().disabled).toBe(true);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.send().disabled).toBe(false);
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("asks for usage once per opened thread and again only once a known reset has passed", async () => {
		vi.useFakeTimers();
		const hydrate = vi.fn(async () => {});
		const select = vi.fn(async () => id(90));
		const observed = withUsage([80, 40]);
		const resetAt = Date.now() + 200_000;
		observed.connections[0]!.providerAccountUsage!.windows[0]!.resetAt = new Date(resetAt).toISOString();
		const f = setup(true, observed, select, hydrate);
		await settle();
		expect(hydrate).toHaveBeenCalledOnce();
		type(f.view, "Hello");
		await settle();
		f.send().click();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledOnce();
		// An idle thread never asks on a clock: the account poll keeps running alone.
		await vi.advanceTimersByTimeAsync(150_000);
		expect(hydrate).toHaveBeenCalledOnce();
		expect(select.mock.calls.length).toBeGreaterThan(3);
		// The reset passes: one new observation, then quiet again.
		await vi.advanceTimersByTimeAsync(51_000);
		expect(hydrate).toHaveBeenCalledTimes(2);
		f.listConnections.mockResolvedValue(withUsage([80, 40]));
		await vi.advanceTimersByTimeAsync(300_000);
		expect(hydrate).toHaveBeenCalledTimes(2);
	});

	it.each(["retry", "sending"] as const)("never automatically switches an account during %s", async (mode) => {
		vi.useFakeTimers();
		const select = vi.fn(async () => id(90));
		const hydrate = vi.fn(async () => {});
		const f = setup(true, withUsage([80, 40]), select, hydrate);
		await settle();
		const original = f.sponsor()!;
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: original,
		};
		f.company.conversation(session.sessionId).set({
			draft: "Hello",
			...(mode === "retry" ? { retrySend: retained } : { sending: true }),
		});
		select.mockResolvedValue(id(91));
		f.listConnections.mockResolvedValue(withUsage([0, 80]));
		await vi.advanceTimersByTimeAsync(90_000);
		expect(select).toHaveBeenCalledOnce();
		expect(hydrate).toHaveBeenCalledOnce();
		expect(f.sponsor()).toBe(original);
		if (mode === "retry") expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
	});

	it.each(["disposed", "access lost"] as const)("stops scheduled account checks when %s", async (mode) => {
		vi.useFakeTimers();
		const select = vi.fn(async () => id(90));
		const hydrate = vi.fn(async () => {});
		const f = setup(true, withUsage([80, 40]), select, hydrate);
		await settle();
		if (mode === "disposed") f.view.dispose();
		else f.company.store.set({ accessLost: true });
		await settle();
		const reads = f.listConnections.mock.calls.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(f.listConnections).toHaveBeenCalledTimes(reads);
		expect(select).toHaveBeenCalledOnce();
		expect(hydrate).toHaveBeenCalledOnce();
	});

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
		expect(f.view.el.textContent).not.toContain("Multiple agents can respond in this group chat");
		expect(f.view.el.textContent).not.toContain("Company-wide execution pause is available in Settings → Company");
		expect(f.view.el.querySelector(".session-run")).toBeNull();
		expect(f.view.el.textContent).not.toContain("Execution history");
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.send().disabled).toBe(false);
		f.send().click();
		await settle();
		refresh();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello team", expect.any(AbortSignal));
		expect(f.listConnections).toHaveBeenCalledTimes(4);
		expect(f.listSessionTurnProvenance).not.toHaveBeenCalled();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.cancel).not.toHaveBeenCalled();
		expect(f.native.requestSessionTurn).not.toHaveBeenCalled();
		expect(f.native.createMemberSponsor).not.toHaveBeenCalled();
	});

	it("takes picked, pasted and dropped images in group chats once the cloud does", async () => {
		const f = setup(true);
		// The cloud that places group chats in the sidebar also takes their images (20260928030000).
		f.company.store.set({ sidebar: { sections: [], placements: {}, pinned: [], hidden: [], groupChats: true } });
		await settle();
		const image = new File(["image"], "local.png", { type: "image/png" });
		const input = f.view.el.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", { value: [image] });
		input.dispatchEvent(new Event("change"));
		const shell = f.view.el.querySelector(".composer-shell")!;
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: { files: [image] } });
		shell.dispatchEvent(paste);
		await settle();
		expect(f.company.conversation(session.sessionId).get().attachments).toEqual([image, image]);
		expect(f.company.roomTargetFor(session.sessionId)).toMatchObject({ agentThread: false, images: true });
		// A room post carries text: images wait for a message.
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.querySelector(".composer")!.textContent).toContain("Add a message to send with the images.");
		f.company.conversation(session.sessionId).set({ draft: "Here is the banner" });
		await settle();
		expect(f.send().disabled).toBe(false);
		f.view.el.querySelector<HTMLButtonElement>(".composer-more")!.click();
		const menu = f.view.el.querySelector<HTMLElement>(".composer-menu")!;
		const attachItem = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent === "Attach files",
		)!;
		expect(attachItem.disabled).toBe(false);
		expect(menu.querySelector<HTMLElement>(".composer-menu-note")!.hidden).toBe(true);
		expect(f.view.el.querySelector(".composer")!.textContent).toContain(
			"Images stay on this device until you send. Up to 5 images, 8 MiB total.",
		);
	});
	it("lets images be chosen in a group chat while the cloud's answer is not known yet", async () => {
		const f = setup(true);
		await settle();
		expect(f.company.groupChatImages()).toBeUndefined();
		const image = new File(["image"], "local.png", { type: "image/png" });
		const input = f.view.el.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", { value: [image] });
		input.dispatchEvent(new Event("change"));
		await settle();
		expect(f.company.conversation(session.sessionId).get().attachments).toEqual([image]);
		expect(f.view.el.querySelector<HTMLElement>(".composer-menu-note")!.hidden).toBe(true);
		// With no text yet, the images wait for a message.
		expect(f.view.el.querySelector(".composer")!.textContent).toContain("Add a message to send with the images.");
	});
	it("rejects picker, pasted and dropped images in group chats on a cloud that keeps them text-only", async () => {
		const f = setup(true);
		// The sidebar read answered without group chats: this cloud keeps them text-only.
		f.company.store.set({ sidebar: { sections: [], placements: {}, pinned: [], hidden: [] } });
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
		const more = f.view.el.querySelector<HTMLButtonElement>(".composer-more")!;
		expect(more.hidden).toBe(false);
		expect(more.disabled).toBe(false);
		more.click();
		const menu = f.view.el.querySelector<HTMLElement>(".composer-menu")!;
		expect(menu.hidden).toBe(false);
		const attachItem = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent === "Attach files",
		)!;
		expect(attachItem.disabled).toBe(true);
		expect(menu.querySelector<HTMLElement>(".composer-menu-note")!.hidden).toBe(false);
		expect(menu.querySelector<HTMLElement>(".composer-menu-note")!.textContent).toBe(
			"Images are not supported in group chats. Use Company File.",
		);
		expect(menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.hidden).toBe(true);
		expect(document.activeElement).toBe(menu);
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(menu.hidden).toBe(true);
		expect(document.activeElement).toBe(more);
		expect(f.view.el.querySelector(".thread-status .notice")).toBeNull();
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

	it("chooses the most remaining allowance once and keeps that account across quota changes", async () => {
		const f = setup(true, withUsage([20, 80]));
		await settle();
		expect(selector()).toBeNull();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(f.view.el.textContent).not.toContain("codex-cli:");
		f.listConnections.mockResolvedValue(withUsage([95, 40]));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		type(f.view, "Hello");
		await settle();
		f.send().click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(selector()).toBeNull();

		// Reopening this room retains its account in company conversation state.
		f.view.dispose();
		const reopened = new ConversationView(f.company, session.sessionId, { nativeSubscription: f.native });
		document.body.append(reopened.el);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		reopened.dispose();

		// A new room independently chooses the current highest allowance.
		const nextSession = {
			...session,
			sessionId: id(192),
			clientSessionId: id(193),
			executionScope: { roomId: id(194) },
		};
		f.company.store.set({ sessions: [...f.company.store.get().sessions, nextSession] });
		const next = new ConversationView(f.company, nextSession.sessionId, { nativeSubscription: f.native });
		document.body.append(next.el);
		await settle();
		expect(f.company.conversation(nextSession.sessionId).get().executionSponsor?.connectionId).toBe(id(90));
		expect(selector()).toBeNull();
		next.dispose();
	});

	it("keeps an exhausted account until it resets and replaces only a disconnected one", async () => {
		const f = setup(true, withUsage([80, 40]));
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		// The payer never changes without the member (20260930059000): no move to the account with room.
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain(
			"This conversation's model account has reached its usage limit. Sending resumes when it resets.",
		);
		f.listConnections.mockResolvedValue(withUsage([30, 40]));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.send().disabled).toBe(false);
		// An owner or admin's disable is not the member's choice: the account stays.
		const disabled = withUsage([30, 40]);
		disabled.connections[0]!.connectionStatus = "disabled";
		f.listConnections.mockResolvedValue(disabled);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain(
			"This conversation's model account can't be used right now. Check it in Settings → My connections.",
		);
		expect(f.view.el.textContent).not.toContain(CONNECT_HINT);
		// An account the member disconnected leaves the conversation waiting for the member's own pick.
		const disconnected = withUsage([30, 40]);
		disconnected.connections[0]!.connectionStatus = "revoked";
		f.listConnections.mockResolvedValue(disconnected);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("Choose a login to continue.");
		buttonNamed(f.view, "Use Model account 1")!.click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(f.send().disabled).toBe(false);
		expect(selector()).toBeNull();
	});

	it("lets the member move an exhausted conversation to another of their logins, never on its own", async () => {
		const f = setup(true, withUsage([80, 40]));
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		refresh();
		await settle();
		// The conversation keeps its account and waits; the other login is offered, not taken.
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("This conversation's model account has reached its usage limit.");
		expect(f.view.el.textContent).toContain("Or continue with another of your logins.");
		expect(buttonNamed(f.view, "Use Model account 2")).toBeUndefined();
		buttonNamed(f.view, "Use Model account 1")!.click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(f.send().disabled).toBe(false);
		expect(f.view.el.textContent).not.toContain("Or continue with another of your logins.");
	});

	it("offers the member's other login when the conversation's own login is disabled", async () => {
		const f = setup(true, withUsage([80, 40]));
		await settle();
		const disabled = withUsage([30, 40]);
		disabled.connections[0]!.connectionStatus = "disabled";
		f.listConnections.mockResolvedValue(disabled);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain("This conversation's model account can't be used right now.");
		expect(f.view.el.textContent).toContain("Or continue with another of your logins.");
		buttonNamed(f.view, "Use Model account 1")!.click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});

	it("offers no other login when the member has none that can pay", async () => {
		const f = setup(true, withUsage([80, 40]));
		await settle();
		f.listConnections.mockResolvedValue(withUsage([0, 0]));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain("This conversation's model account has reached its usage limit.");
		expect(f.view.el.textContent).not.toContain("Or continue with another of your logins.");
	});

	it("moves an exhausted conversation through the cloud's choice only on the member's click", async () => {
		vi.useFakeTimers();
		const select = vi.fn(async (): Promise<string | undefined> => id(90));
		const choose = vi.fn(async (_session: string, connection: string) => connection);
		const f = setup(true, withUsage([80, 40]), select, undefined, choose);
		await settle();
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain("Or continue with another of your logins.");
		expect(choose).not.toHaveBeenCalled();
		select.mockResolvedValue(id(91));
		buttonNamed(f.view, "Use Model account 1")!.click();
		await settle();
		expect(choose).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(91), expect.any(AbortSignal));
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});

	it("names no account of the conversation once the cloud gives it none", async () => {
		const select = vi.fn(async (): Promise<string | undefined> => id(90));
		const f = setup(true, withUsage([80, 40]), select);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		select.mockResolvedValue(undefined);
		f.listConnections.mockResolvedValue(withUsage([0, 0]));
		refresh();
		await settle();
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain("Your model accounts have reached their usage limits.");
		expect(f.view.el.textContent).not.toContain("This conversation's model account");
	});

	it("names the member's accounts when a new conversation finds them all exhausted", async () => {
		const f = setup(true, withUsage([0, 0]));
		await settle();
		expect(f.sponsor()).toBeUndefined();
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.view.el.textContent).toContain(
			"Your model accounts have reached their usage limits. Sending resumes when an account resets.",
		);
	});

	it("uses the least remaining window, ranks unknown quota last and ignores expired windows", async () => {
		const observed = withUsage([90, 30]);
		observed.connections[0]!.providerAccountUsage!.windows = [
			...observed.connections[0]!.providerAccountUsage!.windows,
			{
				id: "secondary",
				label: "Weekly",
				usedPercent: 95,
				resetAt: "2099-01-01T00:00:00.000Z",
			},
		];
		const f = setup(true, observed);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		// Losing current account makes an account with measured allowance preferable to unknown.
		f.company.setExecutionSponsor(session.sessionId, observed, undefined);
		f.listConnections.mockResolvedValue(withUsage([undefined, 10]));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		f.company.setExecutionSponsor(session.sessionId, observed, undefined);
		const expired = withUsage([0, 0]);
		expired.connections[0]!.providerAccountUsage!.windows[0]!.resetAt = "2020-01-01T00:00:00.000Z";
		f.listConnections.mockResolvedValue(expired);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
	});

	it("treats stale observations as unknown and resolves equal allowance deterministically", async () => {
		const observed = withUsage([100, 25]);
		observed.connections[0]!.providerAccountUsage!.observedAt = "2020-01-01T00:00:00.000Z";
		const f = setup(true, observed);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		f.company.setExecutionSponsor(session.sessionId, observed, undefined);
		const staleExhaustion = withUsage([0, 0]);
		staleExhaustion.connections[0]!.providerAccountUsage!.observedAt = "2020-01-01T00:00:00.000Z";
		f.listConnections.mockResolvedValue(staleExhaustion);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		f.company.setExecutionSponsor(session.sessionId, observed, undefined);
		const tied = withUsage([50, 50]);
		f.listConnections.mockResolvedValue({ ...tied, connections: [...tied.connections].reverse() });
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
	});

	it("follows its binding to the member's new connection and honors authoritative usage-limit signals", async () => {
		const f = setup(true, withUsage([90, 40]));
		await settle();
		// The member signed in again: the conversation's binding now pays with their new connection.
		const moved = withUsage([90, 40]);
		moved.connections[0]!.usageLimitResetAt = "2099-01-01T00:00:00.000Z";
		moved.connections[1]!.sponsorBindingId = id(100);
		moved.connections[1]!.sponsorVersion = 2;
		f.listConnections.mockResolvedValue(moved);
		refresh();
		await settle();
		expect(f.sponsor()).toMatchObject({ connectionId: id(91), sponsorBindingId: id(100), sponsorVersion: 2 });
		// At its limit the conversation keeps that connection, though the other account's block has expired.
		const reset = withUsage([undefined, 0]);
		reset.connections[0]!.usageLimitResetAt = "2020-01-01T00:00:00.000Z";
		f.listConnections.mockResolvedValue(reset);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		// An expired authoritative block no longer prevents a new choice after all quota windows reset.
		f.company.setExecutionSponsor(session.sessionId, reset, undefined);
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
	});

	it("restores the server's sticky room account before reading its current binding", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([20, 90]), selectAccount);
		await settle();
		expect(selectAccount).toHaveBeenCalledExactlyOnceWith(session.sessionId, expect.any(AbortSignal));
		expect(selectAccount.mock.invocationCallOrder[0]).toBeLessThan(f.listConnections.mock.invocationCallOrder[0]!);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(selector()).toBeNull();
		// The server's choice wins (here a replaced disconnected account) even while the old quota observation looks usable.
		selectAccount.mockResolvedValue(id(91));
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});

	it("does not silently choose locally when server account selection is unavailable", async () => {
		const selectAccount = vi.fn(async (): Promise<string | undefined> => undefined);
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Hello");
		await settle();
		expect(f.sponsor()).toBeUndefined();
		expect(f.send().disabled).toBe(true);
		selectAccount.mockResolvedValue(id(90));
		refresh();
		await settle();
		expect(f.send().disabled).toBe(false);
		selectAccount.mockRejectedValue(new Error("private server error"));
		refresh();
		await settle();
		expect(f.send().disabled).toBe(true);
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain("Model accounts are unavailable");
		expect(f.view.el.textContent).not.toContain("private server error");
	});

	it("never invokes server reselection for an uncertain retry", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: f.sponsor()!,
		};
		f.company.conversation(session.sessionId).set({ draft: "Hello", retrySend: retained });
		f.listConnections.mockResolvedValue(withUsage([0, 90]));
		refresh();
		await settle();
		expect(selectAccount).toHaveBeenCalledOnce();
		expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
		expect(f.send().disabled).toBe(false);
		expect(f.sponsor()?.connectionId).toBe(id(90));
	});

	it("checks the latest room account before send and suppresses duplicate submissions", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Hello");
		await settle();
		const selection = deferred<string>();
		selectAccount.mockReturnValueOnce(selection.promise);
		const sending = deferred<boolean>();
		let sentAccount: string | undefined;
		f.sendMessage.mockImplementation(async () => {
			sentAccount = f.sponsor()?.connectionId;
			return sending.promise;
		});
		f.send().click();
		f.send().click();
		f.view.el.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(selectAccount).toHaveBeenCalledTimes(2);
		expect(f.sendMessage).not.toHaveBeenCalled();
		selection.resolve(id(91));
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello", expect.any(AbortSignal));
		expect(sentAccount).toBe(id(91));
		expect(f.send().disabled).toBe(true);
		f.view.el.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(f.sendMessage).toHaveBeenCalledOnce();
		sending.resolve(true);
		await settle();
	});

	it.each(["draft", "attachments"])("cancels submission when %s change during account preflight", async (change) => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(false, withUsage([80, 90]), selectAccount);
		await settle();
		const state = f.company.conversation(session.sessionId);
		const originalFile = new File(["first"], "first.png", { type: "image/png" });
		state.set({ draft: "Original", attachments: change === "attachments" ? [originalFile] : [] });
		await settle();
		const selection = deferred<string>();
		selectAccount.mockReturnValueOnce(selection.promise);
		f.send().click();
		const editedFile = new File(["second"], "second.png", { type: "image/png" });
		if (change === "draft") type(f.view, "Edited draft");
		else state.set({ attachments: [editedFile] });
		await settle();
		selection.resolve(id(91));
		await settle();
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(state.get().draft).toBe(change === "draft" ? "Edited draft" : "Original");
		if (change === "attachments") expect(state.get().attachments?.[0]).toBe(editedFile);
		expect(f.send().disabled).toBe(false);
	});

	it("never sends after the conversation is disposed during account preflight", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Keep draft");
		await settle();
		const selection = deferred<string>();
		selectAccount.mockReturnValueOnce(selection.promise);
		f.send().click();
		f.view.dispose();
		selection.resolve(id(91));
		await settle();
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Keep draft");
	});

	it("does not send when account preflight fails and keeps the draft intact", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Keep draft");
		await settle();
		selectAccount.mockRejectedValue(new Error("unavailable"));
		f.send().click();
		await settle();
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(f.company.conversation(session.sessionId).get().draft).toBe("Keep draft");
		expect(f.send().disabled).toBe(true);
	});

	it.each(["access lost", "write revoked", "company stopped"])("cancels account preflight when %s", async (change) => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Keep draft");
		await settle();
		const selection = deferred<string>();
		selectAccount.mockReturnValueOnce(selection.promise);
		f.send().click();
		if (change === "access lost") f.company.store.set({ accessLost: true });
		else if (change === "write revoked")
			f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		else f.company.stop();
		await settle();
		selection.resolve(id(91));
		await settle();
		expect(f.sendMessage).not.toHaveBeenCalled();
		if (change !== "company stopped")
			expect(f.company.conversation(session.sessionId).get().draft).toBe("Keep draft");
	});

	it("does not replace a retry that appears while account preflight is pending", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		type(f.view, "Hello");
		await settle();
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: f.sponsor()!,
		};
		const selection = deferred<string>();
		selectAccount.mockReturnValueOnce(selection.promise);
		f.send().click();
		f.company.conversation(session.sessionId).set({ retrySend: retained });
		selection.resolve(id(91));
		await settle();
		expect(f.sendMessage).not.toHaveBeenCalled();
		expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
		expect(f.sponsor()).toBe(retained.executionSponsor);
		expect(f.send().disabled).toBe(false);
	});

	it("sends an exact uncertain retry without refreshing or changing its original account", async () => {
		const selectAccount = vi.fn(async () => id(90));
		const f = setup(true, withUsage([80, 90]), selectAccount);
		await settle();
		const retained = {
			clientInputId: id(150),
			clientRequestId: id(150),
			text: "Hello",
			files: [],
			executionSponsor: f.sponsor()!,
		};
		f.company.conversation(session.sessionId).set({ draft: "Hello", retrySend: retained });
		await settle();
		f.sendMessage.mockResolvedValue(false);
		selectAccount.mockRejectedValue(new Error("must not select"));
		f.send().click();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello", expect.any(AbortSignal));
		expect(selectAccount).toHaveBeenCalledOnce();
		expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
		expect(f.sponsor()?.connectionId).toBe(id(90));
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
		f.listConnections.mockResolvedValue(withSponsorVersion(withUsage([0, 100]), 2));
		refresh();
		await settle();
		expect(selector()).toBeNull();
		expect(f.sponsor()).toEqual(selected);
		expect(f.company.conversation(session.sessionId).get().retrySend).toBe(retained);
		expect(f.view.el.textContent).toContain("Retry keeps the original model account");
	});

	it("re-binds the same account at its new sponsor version on refresh, but not during a retry", async () => {
		const f = setup(false, withUsage([20, 80]));
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

	it("explicitly releases a failed attempt while preserving the draft, the files and the conversation's account", async () => {
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
		f.listConnections.mockResolvedValue(withUsage([0, 80]));
		refresh();
		await settle();
		buttonNamed(f.view, "Start a new message request")!.click();
		await settle();
		const state = f.company.conversation(session.sessionId).get();
		expect(state.retrySend).toBeUndefined();
		expect(state.draft).toBe("Keep this draft");
		expect(state.attachments?.[0]).toBe(image);
		expect(selector()).toBeNull();
		// Releasing the request is not a choice of another account: the exhausted account stays (20260930059000).
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(f.view.el.textContent).toContain("This conversation's model account has reached its usage limit");
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

/** The Login row of the composer's "Chat settings and more" menu. */
function loginRow(view: ConversationView): HTMLButtonElement {
	return [...view.el.querySelectorAll<HTMLButtonElement>('.composer-menu button[aria-haspopup="menu"]')].find((item) =>
		item.textContent?.startsWith("Login"),
	)!;
}
function loginPage(view: ConversationView): HTMLElement {
	return view.el.querySelector<HTMLElement>(".composer-logins")!;
}
function openMenu(view: ConversationView): void {
	view.el.querySelector<HTMLButtonElement>('[aria-label="Chat settings and more"]')!.click();
}
function openLogins(view: ConversationView): HTMLElement {
	openMenu(view);
	loginRow(view).click();
	return loginPage(view);
}
/** Each listed login's name and whether it is ticked. */
function logins(page: HTMLElement): [string, string | null][] {
	return [...page.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].map((item) => [
		item.textContent ?? "",
		item.getAttribute("aria-checked"),
	]);
}
function login(page: HTMLElement, name: string): HTMLButtonElement {
	return [...page.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
		(item) => item.textContent === name,
	)!;
}
function key(name: string): void {
	document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

describe("the composer's Login page", () => {
	it("shows no Login row unless two or more of the member's own logins can pay", async () => {
		const f = setup(false, connections(1));
		await settle();
		openMenu(f.view);
		expect(loginRow(f.view).hidden).toBe(true);
		// Two logins, one used up: one can pay.
		f.listConnections.mockResolvedValue(withUsage([0, 40]));
		refresh();
		await settle();
		expect(loginRow(f.view).hidden).toBe(true);
		// Another member's logins are never offered.
		const mine = connections();
		f.listConnections.mockResolvedValue({
			...mine,
			computeIdentity: { ...mine.computeIdentity!, ownerUserId: userB.id },
		});
		refresh();
		await settle();
		expect(loginRow(f.view).hidden).toBe(true);
		f.listConnections.mockResolvedValue(mine);
		refresh();
		await settle();
		expect(loginRow(f.view).hidden).toBe(false);
	});

	it("shows no Login row where the cloud chooses but the member's pick can't reach it", async () => {
		const f = setup(
			false,
			withUsage([80, 40]),
			vi.fn(async (): Promise<string | undefined> => id(90)),
		);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(loginRow(f.view).hidden).toBe(true);
	});

	it("lists the member's logins as the login choice numbers them, the current one ticked, never Claude", async () => {
		const observed = withUsage([20, 80]);
		observed.connections[1]!.providerAccountEmail = "jonas@example.com";
		observed.connections.push({
			...observed.connections[0]!,
			connectionId: id(95),
			clientConnectionId: id(195),
			sponsorBindingId: id(96),
			provider: "anthropic",
			nativeHarness: "claude-code",
			// More room than either Codex login: still never offered for chat.
			providerAccountUsage: {
				observedAt: new Date().toISOString(),
				windows: [{ id: "primary", label: "5 hours", usedPercent: 0, resetAt: "2099-01-01T00:00:00.000Z" }],
			},
		});
		const f = setup(false, observed);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		const page = openLogins(f.view);
		expect(page.hidden).toBe(false);
		expect(loginRow(f.view).getAttribute("aria-label")).toBe("Login: jonas@example.com");
		expect(loginRow(f.view).getAttribute("aria-expanded")).toBe("true");
		expect(logins(page)).toEqual([
			["jonas@example.com", "true"],
			["Model account 2", "false"],
		]);
		expect(page.textContent).toContain(
			"Pays for your messages in this conversation. Applies from your next message.",
		);
		expect(document.activeElement).toBe(login(page, "jonas@example.com"));
		// The page leaves with its row once only one login can pay.
		f.listConnections.mockResolvedValue({
			...observed,
			connections: observed.connections.map((connection) =>
				connection.connectionId === id(90)
					? { ...connection, usageLimitResetAt: "2099-01-01T00:00:00.000Z" }
					: connection,
			),
		});
		refresh();
		await settle();
		expect(loginRow(f.view).hidden).toBe(true);
		expect(page.hidden).toBe(true);
		expect(f.view.el.querySelector<HTMLElement>(".composer-menu")?.hidden).toBe(false);
		expect(document.activeElement).toBe(buttonNamed(f.view, "Attach files"));
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});

	it("moves a group chat to the login the member picks, and only then", async () => {
		const f = setup(true, withUsage([20, 80]));
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		const page = openLogins(f.view);
		expect(page.textContent).toContain("Pays for your messages in this group chat. Applies from your next message.");
		// The login that pays already stays as it is.
		login(page, "Model account 1").click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		login(page, "Model account 2").click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(logins(page)).toEqual([
			["Model account 1", "false"],
			["Model account 2", "true"],
		]);
		expect(loginRow(f.view).getAttribute("aria-label")).toBe("Login: Model account 2");
		// A later read never moves it back to the login with more allowance.
		refresh();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		type(f.view, "Hello");
		await settle();
		expect(f.send().disabled).toBe(false);
	});

	it("moves the conversation through the cloud's choice once, with the picked login", async () => {
		const select = vi.fn(async (): Promise<string | undefined> => id(90));
		const choose = vi.fn(async (_session: string, connection: string) => connection);
		const f = setup(false, withUsage([80, 40]), select, undefined, choose);
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		const page = openLogins(f.view);
		expect(logins(page)).toEqual([
			["Model account 1", "true"],
			["Model account 2", "false"],
		]);
		login(page, "Model account 1").click();
		await settle();
		expect(choose).not.toHaveBeenCalled();
		select.mockResolvedValue(id(91));
		login(page, "Model account 2").click();
		await settle();
		expect(choose).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(91), expect.any(AbortSignal));
		expect(f.sponsor()?.connectionId).toBe(id(91));
		expect(logins(page)).toEqual([
			["Model account 1", "false"],
			["Model account 2", "true"],
		]);
		expect(page.hidden).toBe(false);
	});

	it("says on the page when the cloud refuses the pick, and keeps the conversation's login", async () => {
		const select = vi.fn(async (): Promise<string | undefined> => id(90));
		const choose = vi.fn(async (_session: string, _connection: string): Promise<string> => {
			throw new Error("refused");
		});
		const f = setup(false, withUsage([80, 40]), select, undefined, choose);
		await settle();
		const page = openLogins(f.view);
		login(page, "Model account 2").click();
		await settle();
		expect(choose).toHaveBeenCalledOnce();
		expect(f.sponsor()?.connectionId).toBe(id(90));
		expect(page.querySelector('[role="status"]')?.textContent).toBe("The login could not be chosen. Try again.");
		expect(login(page, "Model account 2").disabled).toBe(false);
	});

	it("is locked while a message is on its way, a retry waits or the member can't write", async () => {
		const pending = deferred<boolean>();
		const f = setup(false, withUsage([20, 80]));
		f.sendMessage.mockReturnValueOnce(pending.promise);
		await settle();
		type(f.view, "Hello");
		await settle();
		const page = openLogins(f.view);
		expect(login(page, "Model account 2").disabled).toBe(false);
		f.send().click();
		await settle();
		expect(f.sendMessage).toHaveBeenCalledOnce();
		expect(loginRow(f.view).disabled).toBe(true);
		expect(login(page, "Model account 2").disabled).toBe(true);
		login(page, "Model account 2").click();
		await settle();
		expect(f.sponsor()?.connectionId).toBe(id(91));
		pending.resolve(true);
		await settle();
		expect(login(page, "Model account 2").disabled).toBe(false);
		// An uncertain retry keeps its original login.
		f.company.conversation(session.sessionId).set({
			retrySend: {
				clientInputId: id(150),
				clientRequestId: id(150),
				text: "Hello",
				files: [],
				executionSponsor: f.sponsor()!,
			},
		});
		await settle();
		expect(loginRow(f.view).disabled).toBe(true);
		expect(login(page, "Model account 2").disabled).toBe(true);
		f.company.conversation(session.sessionId).set({ retrySend: undefined });
		await settle();
		expect(login(page, "Model account 2").disabled).toBe(false);
		f.company.conversation(session.sessionId).set({ sending: true });
		await settle();
		expect(loginRow(f.view).disabled).toBe(true);
		expect(f.view.el.querySelector<HTMLElement>(".composer-menu")?.hidden).toBe(true);
		f.company.conversation(session.sessionId).set({ sending: false });
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		await settle();
		expect(loginRow(f.view).disabled).toBe(true);
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});

	it("opens and closes from the keyboard as the Model page does", async () => {
		const f = setup(false, withUsage([20, 80]));
		await settle();
		openMenu(f.view);
		expect(document.activeElement).toBe(buttonNamed(f.view, "Attach files"));
		key("ArrowDown");
		expect(document.activeElement).toBe(loginRow(f.view));
		key("ArrowRight");
		const page = loginPage(f.view);
		expect(page.hidden).toBe(false);
		expect(document.activeElement).toBe(login(page, "Model account 1"));
		key("ArrowDown");
		expect(document.activeElement).toBe(login(page, "Model account 2"));
		key("ArrowDown");
		expect(document.activeElement).toBe(buttonNamed(f.view, "Login"));
		key("ArrowLeft");
		expect(page.hidden).toBe(true);
		expect(loginRow(f.view).getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(loginRow(f.view));
		key("ArrowRight");
		expect(page.hidden).toBe(false);
		key("Escape");
		expect(page.hidden).toBe(true);
		expect(document.activeElement).toBe(loginRow(f.view));
		key("Escape");
		expect(f.view.el.querySelector<HTMLElement>(".composer-menu")?.hidden).toBe(true);
		expect(document.activeElement).toBe(f.view.el.querySelector('[aria-label="Chat settings and more"]'));
		expect(f.sponsor()?.connectionId).toBe(id(91));
	});
});
