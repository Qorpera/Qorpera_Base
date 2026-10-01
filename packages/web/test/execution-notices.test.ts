// @vitest-environment jsdom

import type { CloudRoutine } from "@qorpera/cloud-client/cloud-routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { ExecutionNotices } from "../src/app/views/execution-notices.ts";
import type { MemberNotification, WebMemberNotifications } from "../src/cloud/member-notifications.ts";
import type { WebMemberConnection } from "../src/cloud/native-subscription.ts";
import { deferred, fixture, id, profileA, profileB, settle, timestamp, userB } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", "/#/");
});
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const FULL = "All 2 company computers are in use. Close one to open another.";
const item = (n = 70, at = timestamp): MemberNotification => ({
	notificationId: id(n),
	profileId: profileA.profileId,
	kind: "company_ceiling_tripped",
	createdAt: at,
	acknowledgedAt: null,
	subject: {
		schema: "qorpera.member-notification.machine-capacity/v1",
		dimension: "machines",
		ceiling: 2,
		used: 2,
		allocationId: id(90),
	},
});
const handoff = (n = 75): MemberNotification => ({
	...item(n),
	kind: "sponsor_handoff",
	subject: {
		schema: "qorpera.member-notification.sponsor-handoff/v1",
		runId: id(80),
		fromConnectionId: id(81),
		toConnectionId: id(82),
		reason: "usage_limit",
		at: timestamp,
	},
});
function setup(items: readonly MemberNotification[] = [item()]) {
	const client = {
		listNotifications: vi
			.fn<Pick<WebMemberNotifications, "listNotifications">["listNotifications"]>()
			.mockResolvedValue(items),
		acknowledgeNotification: vi
			.fn<Pick<WebMemberNotifications, "acknowledgeNotification">["acknowledgeNotification"]>()
			.mockImplementation(async (notificationId) => ({
				...items.find((entry) => entry.notificationId === notificationId)!,
				acknowledgedAt: timestamp,
			})),
	};
	const lifetime = new AbortController();
	const restoreFocus = vi.fn();
	const view = new ExecutionNotices(client, lifetime.signal, restoreFocus);
	document.body.append(view.el);
	cleanup.push(() => view.dispose());
	return { client, lifetime, view, restoreFocus };
}
const action = (name: string) => document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;

describe("company notices", () => {
	it("shows one plain line without acknowledging, and preserves focus/DOM during unchanged polling", async () => {
		const f = setup();
		await settle();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.querySelector(".company-notice p")?.textContent).toBe(FULL);
		expect(f.view.el.querySelectorAll("button")).toHaveLength(1);
		const dismiss = action("dismiss-notification");
		expect(dismiss.textContent).toBe("Dismiss");
		dismiss.focus();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(action("dismiss-notification")).toBe(dismiss);
		expect(document.activeElement).toBe(dismiss);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
	});
	it("dismisses queued notices one at a time and skips acknowledged records", async () => {
		const f = setup([item(70), item(71), { ...item(72), acknowledgedAt: timestamp }]);
		await settle();
		expect(f.view.el.querySelectorAll(".company-notice")).toHaveLength(1);
		action("dismiss-notification").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(id(70), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(false);
		action("dismiss-notification").focus();
		action("dismiss-notification").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenNthCalledWith(2, id(71), expect.any(AbortSignal));
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(2);
		expect(f.view.el.hidden).toBe(true);
		expect(f.restoreFocus).toHaveBeenCalledOnce();
	});
	it("closes the line after an uncertain acknowledgment, shows no error and never replays the write", async () => {
		const f = setup();
		await settle();
		f.client.acknowledgeNotification.mockRejectedValueOnce(new Error("response lost"));
		action("dismiss-notification").focus();
		action("dismiss-notification").click();
		await settle();
		expect(f.view.el.hidden).toBe(true);
		expect(f.view.el.textContent).toBe("");
		expect(f.restoreFocus).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.view.el.hidden).toBe(true);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
	});
	it("does not show a confirmed dismissal again when a subsequent poll returns stale records", async () => {
		const f = setup();
		await settle();
		action("dismiss-notification").click();
		await settle();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(true);
		f.client.listNotifications.mockResolvedValue([item(), item(71)]);
		await f.view.refresh();
		expect(f.view.el.hidden).toBe(false);
		f.client.acknowledgeNotification.mockResolvedValueOnce({ ...item(71), acknowledgedAt: timestamp });
		action("dismiss-notification").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenNthCalledWith(2, id(71), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(true);
	});
	it("dismisses with Escape inside the line while leaving workspace Escape alone", async () => {
		const f = setup();
		await settle();
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.focus();
		composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
		const dismiss = action("dismiss-notification");
		dismiss.focus();
		const dismissKeyEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		dismiss.dispatchEvent(dismissKeyEvent);
		await settle();
		expect(dismissKeyEvent.defaultPrevented).toBe(true);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(id(70), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(true);
		expect(f.restoreFocus).toHaveBeenCalledOnce();
	});
	it.each([
		{ profileId: profileB.profileId, acknowledgedAt: timestamp },
		{ notificationId: id(71), acknowledgedAt: timestamp },
		{ acknowledgedAt: null },
	])("prevents repeat clicks during a write and closes quietly on an invalid receipt: %j", async (receipt) => {
		const f = setup();
		await settle();
		const pending = deferred<MemberNotification>();
		f.client.acknowledgeNotification.mockReturnValueOnce(pending.promise);
		action("dismiss-notification").click();
		expect(action("dismiss-notification").getAttribute("aria-disabled")).toBe("true");
		action("dismiss-notification").click();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
		pending.resolve({ ...item(), ...receipt });
		await settle();
		expect(f.view.el.hidden).toBe(true);
		expect(f.view.el.textContent).toBe("");
	});
	it("discards an old poll after explicit acknowledgment and a late result after access loss", async () => {
		const f = setup();
		await settle();
		const old = deferred<readonly MemberNotification[]>();
		f.client.listNotifications.mockReturnValueOnce(old.promise);
		const refresh = f.view.refresh();
		action("dismiss-notification").click();
		await settle();
		old.resolve([item()]);
		await refresh;
		expect(f.view.el.hidden).toBe(true);
		const late = deferred<readonly MemberNotification[]>();
		f.client.listNotifications.mockReturnValueOnce(late.promise);
		const reading = f.view.refresh();
		f.lifetime.abort();
		late.resolve([item()]);
		await reading;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.view.el.textContent).toBe("");
		expect(f.client.listNotifications).toHaveBeenCalledTimes(3);
	});
	it("shows nothing while reads fail, no error either, and the line returns with the next good read", async () => {
		const f = setup();
		await settle();
		f.client.listNotifications.mockRejectedValueOnce(new Error("denied"));
		await f.view.refresh();
		expect(f.view.el.hidden).toBe(true);
		expect(f.view.el.textContent).toBe("");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.textContent).toBe(`${FULL}Dismiss`);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
	});
	it("removes its line on disposal and ignores a late acknowledgment receipt", async () => {
		const f = setup();
		await settle();
		const pending = deferred<MemberNotification>();
		f.client.acknowledgeNotification.mockReturnValueOnce(pending.promise);
		action("dismiss-notification").click();
		f.lifetime.abort();
		pending.resolve({ ...item(), acknowledgedAt: timestamp });
		await settle();
		expect(f.view.el.isConnected).toBe(false);
		expect(f.view.el.textContent).toBe("");
		expect(f.view.el.hidden).toBe(true);
	});
	it("hands focus back to the workspace when a failed poll takes the focused line away", async () => {
		const f = setup();
		await settle();
		action("dismiss-notification").focus();
		f.client.listNotifications.mockRejectedValueOnce(new Error("offline"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(true);
		expect(f.restoreFocus).toHaveBeenCalledOnce();
	});
	it("keeps focus on dismiss when polling replaces the current queued notice", async () => {
		const f = setup([item(70), item(71)]);
		await settle();
		action("dismiss-notification").focus();
		f.client.listNotifications.mockResolvedValue([item(71)]);
		await f.view.refresh();
		expect(document.activeElement).toBe(action("dismiss-notification"));
	});
	it("does not move focus from the workspace when a poll fails or recovers", async () => {
		const f = setup();
		await settle();
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.focus();
		f.client.listNotifications.mockRejectedValueOnce(new Error("offline"));
		await f.view.refresh();
		expect(document.activeElement).toBe(composer);
		await f.view.refresh();
		expect(document.activeElement).toBe(composer);
		expect(f.restoreFocus).not.toHaveBeenCalled();
	});
	it("gives a usage limit and a changed sponsor no line, and never acknowledges them", async () => {
		const usage = {
			...item(79),
			kind: "provider_usage_limit" as const,
			subject: {
				schema: "qorpera.member-notification.provider-usage-limit/v1" as const,
				provider: "openai",
				resetsAt: timestamp,
				runId: id(80),
				connectionId: id(81),
			},
		};
		const quiet = setup([usage, handoff()]);
		await settle();
		expect(quiet.view.el.hidden).toBe(true);
		expect(quiet.view.el.textContent).toBe("");
		expect(quiet.client.acknowledgeNotification).not.toHaveBeenCalled();
		// A notice that does get a line still shows behind them.
		const mixed = setup([usage, handoff(), item(70, "2099-01-01T00:00:00.000Z")]);
		await settle();
		expect(mixed.view.el.querySelector("p")?.textContent).toBe(FULL);
	});
});

it("reads notices for the company workspace without any popup, also across an account change", async () => {
	const f = fixture();
	const wire = {
		schema: "qorpera.member-notification/v1",
		notification_id: id(70),
		profile_id: profileA.profileId,
		kind: "company_ceiling_tripped",
		created_at: timestamp,
		acknowledged_at: null,
		subject: {
			schema: "qorpera.member-notification.machine-capacity/v1",
			dimension: "machines",
			ceiling: 2,
			used: 2,
			allocationId: id(90),
		},
	};
	const reads = () =>
		transport.mock.calls.filter(([input]) => String(input).endsWith("qorpera_list_member_notifications")).length;
	const transport = vi.fn(async (input: string | URL | Request) => {
		if (String(input).endsWith("qorpera_list_member_notifications")) return Response.json([wire]);
		return Response.json([]);
	});
	vi.stubGlobal("fetch", transport);
	history.replaceState(null, "", `/#/c/${profileA.profileId}/new`);
	const root = document.createElement("div");
	document.body.append(root);
	cleanup.push(mountApplication(root, f.cloud, f.api));
	await vi.advanceTimersByTimeAsync(100);
	expect(reads()).toBe(1);
	// The line belongs to an open conversation (above its composer); nothing floats over the app.
	expect(root.querySelector(".notification-stack, .notification-card")).toBeNull();
	expect(root.textContent).not.toContain("company computers are in use");
	expect(root.querySelector('a[href$="/notifications"]')).toBeNull();
	transport.mockImplementation(async () => Response.json([]));
	f.auth(userB);
	await vi.advanceTimersByTimeAsync(100);
	expect(root.textContent).not.toContain("company computers are in use");
});

describe("a ChatGPT plan's first-routine card (shown only to a member with a plan login)", () => {
	const waiting = (n = 77): MemberNotification => ({
		...item(n),
		kind: "routine_needs_model_account",
		subject: {
			schema: "routine-needs-model-account",
			staffAgentId: id(60),
			routineId: id(61),
			title: "Morning brief",
		},
	});
	const connection = (extra: Record<string, unknown>) =>
		({
			connectionId: id(85),
			clientConnectionId: id(185),
			connectionVersion: 2,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "personal_subscription",
			consentVersion: "v1",
			consentedAt: timestamp,
			connectionStatus: "active",
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 3 },
			...extra,
		}) as unknown as WebMemberConnection;
	const routine = { routineId: id(61), title: "Morning brief" } as unknown as CloudRoutine;
	function planSetup(connections: WebMemberConnection[], items: MemberNotification[] = [waiting()]) {
		const client = {
			listNotifications: vi.fn(async () => items),
			acknowledgeNotification: vi.fn(async (notificationId: string) => ({
				...items.find((entry) => entry.notificationId === notificationId)!,
				acknowledgedAt: timestamp,
			})),
		};
		let listed = connections;
		const plan = {
			native: {
				listConnections: vi.fn(async () => ({ connections: listed })),
				setWorkWhileAway: vi.fn(async () => {
					listed = [...listed, { ...listed[0]!, connectionVersion: 3, allowAutonomous: true }];
				}),
				recordRoutineOffer: vi.fn(async () => timestamp),
			},
			routines: { list: vi.fn(async () => [routine]), setEnabled: vi.fn(async () => {}) },
		};
		const lifetime = new AbortController();
		const view = new ExecutionNotices(client, lifetime.signal, undefined, plan);
		document.body.append(view.el);
		cleanup.push(() => view.dispose());
		return { client, plan, view };
	}
	it("stays out of sight for a member without a plan login, or with a Codex login", async () => {
		for (const connections of [[], [connection({ loginKind: "codex", allowAutonomous: false })]]) {
			const f = planSetup(connections);
			await settle();
			expect(f.view.el.hidden).toBe(true);
			expect(f.plan.native.recordRoutineOffer).not.toHaveBeenCalled();
			f.view.dispose();
		}
		// Without the plan's helpers the band reads as before: a waiting routine gets no line.
		const f = setup([waiting()]);
		await settle();
		expect(f.view.el.hidden).toBe(true);
	});
	it("does not come back once shown, or once the plan is turned on", async () => {
		for (const extra of [{ routineOfferShownAt: timestamp }, { allowAutonomous: true }]) {
			const f = planSetup([connection({ loginKind: "chatgpt_plan", allowAutonomous: false, ...extra })]);
			await settle();
			expect(f.view.el.hidden).toBe(true);
			f.view.dispose();
		}
	});
	it("asks once, and Turn on turns the plan on and saves the waiting routine on it", async () => {
		const f = planSetup([connection({ loginKind: "chatgpt_plan", allowAutonomous: false })]);
		await settle();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.querySelector(".company-notice p")?.textContent).toBe(
			"Morning brief can run while you're away. Turn on “Work while you're away” so your ChatGPT plan can run it.",
		);
		expect(f.plan.native.recordRoutineOffer).toHaveBeenCalledExactlyOnceWith(id(85), expect.any(AbortSignal));
		// The card stands in this window after the showing is recorded.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.plan.native.recordRoutineOffer).toHaveBeenCalledTimes(1);
		action("turn-on-plan").click();
		await settle();
		expect(f.plan.native.setWorkWhileAway).toHaveBeenCalledExactlyOnceWith(id(85), true, expect.any(AbortSignal));
		expect(f.plan.routines.setEnabled).toHaveBeenCalledExactlyOnceWith(
			routine,
			expect.objectContaining({ connectionId: id(85), connectionVersion: 3, allowAutonomous: true }),
			true,
			expect.any(String),
		);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(true);
	});
	it("Not now leaves the routine waiting and never asks again", async () => {
		const f = planSetup([connection({ loginKind: "chatgpt_plan", allowAutonomous: false })]);
		await settle();
		action("not-now-plan").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
		expect(f.plan.native.setWorkWhileAway).not.toHaveBeenCalled();
		expect(f.view.el.hidden).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(true);
	});
	it("says when the plan could not be turned on, and keeps the card", async () => {
		const f = planSetup([connection({ loginKind: "chatgpt_plan", allowAutonomous: false })]);
		await settle();
		f.plan.native.setWorkWhileAway.mockRejectedValueOnce(new Error("offline"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain("“Work while you're away” could not be turned on. Try again.");
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
		expect(action("turn-on-plan")).toBeTruthy();
	});
});
