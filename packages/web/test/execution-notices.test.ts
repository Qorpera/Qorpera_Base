// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { ExecutionNotices } from "../src/app/views/execution-notices.ts";
import type { MemberNotification, WebMemberNotifications } from "../src/cloud/member-notifications.ts";
import { PlanSwitchBusyError, type WebMemberConnection } from "../src/cloud/native-subscription.ts";
import type { WebRoutine } from "../src/cloud/routines.ts";
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
const FULL =
	"Your monthly Gemini API spend cap of $25 was reached ($25.50 used in November 2026). Raise the cap in Settings or switch models to continue.";
const item = (n = 70, at = timestamp): MemberNotification => ({
	notificationId: id(n),
	profileId: profileA.profileId,
	kind: "gemini_cap_reached",
	createdAt: at,
	acknowledgedAt: null,
	subject: {
		schema: "qorpera.member-notification.gemini-cap-reached/v1",
		month: "2026-11",
		monthlyCapCents: 2500,
		spendMicrodollars: 25_500_000,
		runId: id(90),
		sessionId: null,
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
	it("gives a usage limit no line, and never acknowledges it", async () => {
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
		const quiet = setup([usage]);
		await settle();
		expect(quiet.view.el.hidden).toBe(true);
		expect(quiet.view.el.textContent).toBe("");
		expect(quiet.client.acknowledgeNotification).not.toHaveBeenCalled();
		// A notice that does get a line still shows behind it.
		const mixed = setup([usage, item(70, "2099-01-01T00:00:00.000Z")]);
		await settle();
		expect(mixed.view.el.querySelector("p")?.textContent).toBe(FULL);
	});

	it("silences auto-resuming usage limits and shows only stopped login limits", async () => {
		const usage = (accountEmail: string | null, resetsAt: string | null) => ({
			...item(77),
			kind: "provider_usage_limit" as const,
			subject: {
				schema: "qorpera.member-notification.provider-usage-limit/v1" as const,
				provider: "openai",
				resetsAt,
				runId: id(80),
				connectionId: id(81),
				accountEmail,
			},
		});
		const soon = new Date(Date.now() + 4 * 3_600_000 - 60_000).toISOString();
		const autoResuming = setup([usage("a@example.com", soon), usage(null, null)]);
		await settle();
		expect(autoResuming.view.el.hidden).toBe(true);
		expect(autoResuming.view.count).toBe(0);
		expect(autoResuming.client.acknowledgeNotification).not.toHaveBeenCalled();

		const stopped = (accountEmail: string | null) => {
			const notice = usage(accountEmail, soon);
			return { ...notice, subject: { ...notice.subject, runStopped: true as const } };
		};
		const named2 = setup([stopped("a@example.com")]);
		await settle();
		expect(named2.view.count).toBe(1);
		expect(named2.view.el.querySelector("p")?.textContent).toBe(
			"Your login a@example.com reached its usage limit, and the work it paid for stopped. It does not go on by itself.",
		);
		const unnamed = setup([stopped(null)]);
		await settle();
		expect(unnamed.view.count).toBe(1);
		expect(unnamed.view.el.querySelector("p")?.textContent).toBe(
			"Your login reached its usage limit, and the work it paid for stopped. It does not go on by itself.",
		);
	});

	it("silences operational run_no_progress and machine-capacity notices", async () => {
		const stalled: MemberNotification = {
			...item(78),
			kind: "run_no_progress",
			subject: {
				schema: "qorpera.member-notification.run-no-progress/v1",
				runId: id(80),
				staffAgentId: id(83),
				sessionId: null,
				since: timestamp,
				minutes: 15,
				worker: true,
			},
		};
		const capacity: MemberNotification = {
			...item(79),
			kind: "company_ceiling_tripped",
			subject: {
				schema: "qorpera.member-notification.machine-capacity/v1",
				dimension: "machines",
				ceiling: 2,
				used: 2,
				allocationId: id(90),
			},
		};
		const onCountChange = vi.fn();
		const client = {
			listNotifications: vi.fn(async () => [stalled, capacity]),
			acknowledgeNotification: vi.fn(async () => ({ ...stalled, acknowledgedAt: timestamp })),
		};
		const lifetime = new AbortController();
		const view = new ExecutionNotices(
			client,
			lifetime.signal,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			onCountChange,
		);
		document.body.append(view.el);
		cleanup.push(() => view.dispose());
		await settle();
		expect(view.el.hidden).toBe(true);
		expect(view.count).toBe(0);
		expect(onCountChange).not.toHaveBeenCalled();
		expect(client.acknowledgeNotification).not.toHaveBeenCalled();
	});

	it("says who moved a routine off the member's login, and dismisses it like any line (20260930095000)", async () => {
		type Moved = Extract<
			MemberNotification["subject"],
			{ schema: "qorpera.member-notification.routine-payer-changed/v1" }
		>;
		const moved = (n: number, subject: Partial<Moved> = {}): MemberNotification => ({
			...item(n),
			kind: "routine_payer_changed",
			subject: {
				schema: "qorpera.member-notification.routine-payer-changed/v1",
				routineId: id(81),
				routineVersion: 2,
				staffAgentId: id(83),
				payer: "member",
				payerUserId: id(84),
				changedByUserId: id(84),
				reason: "save",
				at: timestamp,
				...subject,
			},
		});
		const names: Record<string, string> = { [id(83)]: "Nova", [id(84)]: "Anna", [id(85)]: "Ben" };
		const show = async (notice: MemberNotification, named = true) => {
			const client = {
				listNotifications: vi.fn(async () => [notice]),
				acknowledgeNotification: vi.fn(async () => ({ ...notice, acknowledgedAt: timestamp })),
			};
			const view = new ExecutionNotices(
				client,
				new AbortController().signal,
				undefined,
				undefined,
				named ? (staffAgentId) => names[staffAgentId] : undefined,
				undefined,
				named ? (userId) => names[userId] : undefined,
			);
			document.body.append(view.el);
			cleanup.push(() => view.dispose());
			await settle();
			return { client, view, text: view.el.querySelector("p")?.textContent };
		};
		expect((await show(moved(71))).text).toBe(
			"Nova's routine no longer runs on your login. Anna moved it to their login.",
		);
		expect((await show(moved(72, { payer: "company", payerUserId: null, reason: "pick" }))).text).toBe(
			"Nova's routine no longer runs on your login. Anna moved it to the company's account.",
		);
		expect((await show(moved(73, { payerUserId: id(85) }))).text).toBe(
			"Nova's routine no longer runs on your login. Anna moved it to Ben's login.",
		);
		// Without the names (another window's lists, or no one named), the line still says what happened.
		expect((await show(moved(74), false)).text).toBe(
			"An agent's routine no longer runs on your login. A member moved it to their login.",
		);
		expect((await show(moved(75, { changedByUserId: null, payerUserId: id(86) }))).text).toBe(
			"Nova's routine no longer runs on your login. A member moved it to another member's login.",
		);
		const shown = await show(moved(76));
		const dismiss = shown.view.el.querySelector<HTMLButtonElement>('[data-action="dismiss-notification"]')!;
		dismiss.click();
		await settle();
		expect(shown.client.acknowledgeNotification).toHaveBeenCalledWith(id(76), expect.any(AbortSignal));
		expect(shown.view.el.hidden).toBe(true);
	});

	it("tells a founder and the card's member that the good will card failed, with Stripe's invoice (20260930571000)", async () => {
		const failed = (n: number, mine: boolean, invoiceUrl: string | null): MemberNotification => ({
			...item(n),
			kind: "good_will_card_failed",
			subject: {
				schema: "qorpera.member-notification.good-will-card-failed/v1",
				month: "2026-11",
				dueOre: 510000,
				invoiceUrl,
				mine,
			},
		});
		const show = async (notice: MemberNotification) => {
			const client = {
				listNotifications: vi.fn(async () => [notice]),
				acknowledgeNotification: vi.fn(async () => ({ ...notice, acknowledgedAt: timestamp })),
			};
			const view = new ExecutionNotices(client, new AbortController().signal);
			document.body.append(view.el);
			cleanup.push(() => view.dispose());
			await settle();
			return view.el;
		};
		const own = await show(failed(91, true, "https://invoice.stripe.com/i/1"));
		expect(own.querySelector("p")?.textContent).toBe(
			"Your card could not pay November 2026's good will of 5,100 kr. Stripe tries again, or open the invoice to pay it another way.",
		);
		expect(own.querySelector("a")?.getAttribute("href")).toBe("https://invoice.stripe.com/i/1");
		const founder = await show(failed(92, false, null));
		expect(founder.querySelector("p")?.textContent).toContain(
			"The company's card could not pay November 2026's good will",
		);
		expect(founder.querySelector("a")).toBeNull();
	});

	it("says whose supervision of an area's agents ended and why, and dismisses it like any line (20260930371000)", async () => {
		type Ended = Extract<
			MemberNotification["subject"],
			{ schema: "qorpera.member-notification.interface-supervision-ended/v1" }
		>;
		const ended = (n: number, subject: Partial<Ended> = {}): MemberNotification => ({
			...item(n),
			kind: "interface_supervision_ended",
			subject: {
				schema: "qorpera.member-notification.interface-supervision-ended/v1",
				supervisionId: id(81),
				tableId: id(82),
				key: ["Sales"],
				supervisorUserId: id(84),
				reason: "withdrawn",
				byUserId: id(84),
				at: timestamp,
				...subject,
			},
		});
		const names: Record<string, string> = { [id(84)]: "Anna" };
		const show = async (notice: MemberNotification, named = true) => {
			const client = {
				listNotifications: vi.fn(async () => [notice]),
				acknowledgeNotification: vi.fn(async () => ({ ...notice, acknowledgedAt: timestamp })),
			};
			const view = new ExecutionNotices(
				client,
				new AbortController().signal,
				undefined,
				undefined,
				undefined,
				undefined,
				named ? (userId) => names[userId] : undefined,
			);
			document.body.append(view.el);
			cleanup.push(() => view.dispose());
			await settle();
			return { client, view, text: view.el.querySelector("p")?.textContent };
		};
		expect((await show(ended(71))).text).toBe("Anna stopped supervising the agents in the area Sales.");
		expect((await show(ended(72, { reason: "released", byUserId: id(85) }))).text).toBe(
			"Anna no longer supervises the agents in the area Sales.",
		);
		expect((await show(ended(73, { reason: "gone", key: ["North", 2, null, ["a", "b"]] }))).text).toBe(
			"Anna no longer supervises the agents in the area North, 2, a, b: the area is gone.",
		);
		expect((await show(ended(74, { reason: "left", byUserId: null }))).text).toBe(
			"Anna left the company, so the agents in the area Sales have no supervisor.",
		);
		// Without the name (another window's list) or the key (too long to carry), the line still says what happened.
		expect((await show(ended(75, { key: null }), false)).text).toBe(
			"A member stopped supervising the agents in an area.",
		);
		const shown = await show(ended(76));
		const dismiss = shown.view.el.querySelector<HTMLButtonElement>('[data-action="dismiss-notification"]')!;
		dismiss.click();
		await settle();
		expect(shown.client.acknowledgeNotification).toHaveBeenCalledWith(id(76), expect.any(AbortSignal));
		expect(shown.view.el.hidden).toBe(true);
	});

	it("reports account health count changes as notices arrive and are dismissed", async () => {
		const counts: number[] = [];
		const client = {
			listNotifications: vi.fn(async () => [item(70), item(71)]),
			acknowledgeNotification: vi.fn(async (notificationId: string) => ({
				...item(notificationId === id(70) ? 70 : 71),
				acknowledgedAt: timestamp,
			})),
		};
		const lifetime = new AbortController();
		const view = new ExecutionNotices(
			client,
			lifetime.signal,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(count) => counts.push(count),
		);
		document.body.append(view.el);
		cleanup.push(() => view.dispose());
		await settle();
		expect(view.count).toBe(2);
		expect(counts).toEqual([2]);
		action("dismiss-notification").click();
		await settle();
		expect(view.count).toBe(1);
		expect(counts).toEqual([2, 1]);
		action("dismiss-notification").click();
		await settle();
		expect(view.count).toBe(0);
		expect(counts).toEqual([2, 1, 0]);
	});
});

it("keeps billing notices out of chat, badges the Account menu, and shows them inside Settings", async () => {
	const f = fixture();
	const wire = {
		schema: "qorpera.member-notification/v1",
		notification_id: id(70),
		profile_id: profileA.profileId,
		kind: "gemini_cap_reached",
		created_at: timestamp,
		acknowledged_at: null,
		subject: {
			schema: "qorpera.member-notification.gemini-cap-reached/v1",
			month: "2026-11",
			monthlyCapCents: 2500,
			spendMicrodollars: 25_500_000,
			runId: id(90),
			sessionId: null,
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
	expect(root.textContent).not.toContain("monthly Gemini API spend cap");
	expect(root.querySelector(".account-health-dot")).not.toBeNull();
	root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
	expect(root.querySelector('[data-account-action="settings"] .account-count')?.textContent).toBe("1");
	root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
	expect(root.querySelector(".settings-content .company-notice p")?.textContent).toBe(FULL);
	transport.mockImplementation(async () => Response.json([]));
	f.auth(userB);
	await vi.advanceTimersByTimeAsync(100);
	expect(root.querySelector(".account-health-dot")).toBeNull();
});

describe("a ChatGPT plan's first-routine card (shown only to a member with a plan login, while plans are on)", () => {
	const member = id(99);
	const waitingNotice = (n = 77): MemberNotification => ({
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
	const plan = (extra: Record<string, unknown> = {}) =>
		connection({ loginKind: "chatgpt_plan", allowAutonomous: false, ...extra });
	const routine = (extra: Record<string, unknown> = {}) =>
		({
			routineId: id(61),
			title: "Morning brief",
			status: "paused",
			pauseReason: "needs_model_account",
			runsForUserId: member,
			triggers: [{ id: "t", kind: "schedule", intervalMinutes: 60 }],
			...extra,
		}) as unknown as WebRoutine;
	function planSetup(
		options: {
			connections?: WebMemberConnection[];
			routines?: WebRoutine[];
			notices?: MemberNotification[];
			available?: boolean;
			manage?: boolean;
			mounted?: boolean;
		} = {},
	) {
		const notices = options.notices ?? [waitingNotice()];
		const client = {
			listNotifications: vi.fn(async () => notices),
			acknowledgeNotification: vi.fn(
				async (notificationId: string): Promise<MemberNotification> => ({
					...notices.find((entry) => entry.notificationId === notificationId)!,
					acknowledgedAt: timestamp,
				}),
			),
		};
		let listed = options.connections ?? [plan()];
		let routines = options.routines ?? [routine()];
		const offer = {
			native: {
				listConnections: vi.fn(async () => ({ connections: listed })),
				setWorkWhileAway: vi.fn(async () => {
					listed = [...listed, { ...listed[0]!, connectionVersion: 3, allowAutonomous: true }];
				}),
				recordRoutineOffer: vi.fn(async (connectionId: string) => {
					// As the cloud does: the list now carries the showing.
					listed = listed.map((item) =>
						item.connectionId === connectionId ? { ...item, routineOfferShownAt: timestamp } : item,
					);
					return timestamp;
				}),
				chatGptPlanAvailable: vi.fn(async () => options.available ?? true),
			},
			routines: {
				list: vi.fn(async () => routines),
				setEnabled: vi.fn(async () => {
					routines = routines.map(
						(entry) => ({ ...entry, status: "active", pauseReason: undefined }) as WebRoutine,
					);
				}),
			},
			memberId: member,
			canManage: vi.fn(() => options.manage ?? true),
		};
		const view = new ExecutionNotices(client, new AbortController().signal, undefined, offer);
		if (options.mounted !== false) document.body.append(view.el);
		cleanup.push(() => view.dispose());
		const setRoutines = (next: WebRoutine[]) => {
			routines = next;
		};
		return { client, offer, view, setRoutines };
	}
	const text = (view: ExecutionNotices) => view.el.querySelector(".company-notice p")?.textContent;
	it("stays out of sight without a plan login, with a Codex login, or while plans are off", async () => {
		for (const options of [
			{ connections: [] },
			{ connections: [connection({ loginKind: "codex", allowAutonomous: false })] },
			{ available: false },
		]) {
			const f = planSetup(options);
			await settle();
			expect(f.view.el.hidden).toBe(true);
			expect(f.offer.native.recordRoutineOffer).not.toHaveBeenCalled();
			f.view.dispose();
		}
		// Without the plan's helpers the band reads as before: a waiting routine gets no line.
		const f = setup([waitingNotice()]);
		await settle();
		expect(f.view.el.hidden).toBe(true);
	});
	it("does not come back once shown, once the plan is on, or for a routine it cannot start", async () => {
		for (const options of [
			{ connections: [plan({ routineOfferShownAt: timestamp })] },
			{ connections: [plan({ allowAutonomous: true })] },
			{ routines: [routine({ runsForUserId: id(98) })] },
			{ routines: [routine({ status: "active", pauseReason: undefined })] },
			// Paused by its agent, not waiting for an account.
			{ routines: [routine({ pauseReason: "agent" })] },
			{
				routines: [
					routine({
						triggers: [{ id: "f", kind: "listener", source: "company-file", path: "a", match: "subtree" }],
					}),
				],
			},
		]) {
			const f = planSetup(options);
			await settle();
			expect(f.view.el.hidden).toBe(true);
			f.view.dispose();
		}
	});
	it("reads the plan and the routines once for the same notices", async () => {
		const f = planSetup({ connections: [] });
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.offer.native.listConnections).toHaveBeenCalledTimes(1);
	});
	it("asks once, and Turn on turns the plan on and starts the waiting routine on it", async () => {
		const f = planSetup();
		await settle();
		expect(text(f.view)).toBe(
			"Morning brief can run while you're away. Turn on “Work while you're away” so your ChatGPT plan can run it.",
		);
		expect(f.offer.native.recordRoutineOffer).toHaveBeenCalledExactlyOnceWith(id(85), expect.any(AbortSignal));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.offer.native.recordRoutineOffer).toHaveBeenCalledTimes(1);
		expect(f.view.el.hidden).toBe(false);
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.native.setWorkWhileAway).toHaveBeenCalledExactlyOnceWith(id(85), true, expect.any(AbortSignal));
		expect(f.offer.routines.setEnabled).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ routineId: id(61) }),
			expect.objectContaining({ connectionId: id(85), connectionVersion: 3, allowAutonomous: true }),
			true,
			expect.any(String),
		);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(true);
	});
	it("names how many routines wait when there are several", async () => {
		const f = planSetup({ routines: [routine(), routine({ routineId: id(62), title: "Evening note" })] });
		await settle();
		expect(text(f.view)).toBe(
			"2 routines can run while you're away. Turn on “Work while you're away” so your ChatGPT plan can run them.",
		);
	});
	it("leaves a routine alone that stopped waiting before Turn on", async () => {
		const f = planSetup();
		await settle();
		f.setRoutines([routine({ status: "concluded", pauseReason: undefined })]);
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.native.setWorkWhileAway).toHaveBeenCalledOnce();
		expect(f.offer.routines.setEnabled).not.toHaveBeenCalled();
	});
	it("for a member who does not save routines, turns the plan on and says to ask the agent", async () => {
		const f = planSetup({ manage: false });
		await settle();
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.native.setWorkWhileAway).toHaveBeenCalledOnce();
		expect(f.offer.routines.setEnabled).not.toHaveBeenCalled();
		expect(text(f.view)).toBe(
			"Your ChatGPT plan now works while you're away. Ask the agent to set Morning brief up again.",
		);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(false);
		f.view.el
			.querySelector(".company-notice")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(f.view.el.hidden).toBe(true);
	});
	it("tells a member who does not save routines whom to ask about several", async () => {
		const evening = routine({ routineId: id(62), title: "Evening note" });
		for (const [agents, said] of [
			[[id(60), id(60)], "Ask the agent to set those routines up again."],
			[[id(60), id(63)], "Ask the agents to set those routines up again."],
		] as const) {
			const f = planSetup({
				manage: false,
				routines: [routine({ staffAgentId: agents[0] }), { ...evening, staffAgentId: agents[1] } as WebRoutine],
			});
			await settle();
			action("turn-on-plan").click();
			await settle();
			expect(text(f.view)).toBe(`Your ChatGPT plan now works while you're away. ${said}`);
			action("dismiss-plan").click();
			f.view.dispose();
		}
	});
	it("starts the newest turned-on version, and a routine set up while the card stood", async () => {
		const f = planSetup();
		await settle();
		f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {
			f.offer.native.listConnections.mockResolvedValue({
				connections: [
					plan(),
					plan({ connectionVersion: 3, allowAutonomous: true }),
					plan({ connectionVersion: 4, allowAutonomous: true }),
				],
			});
		});
		// The same agent's notice stays open, so a second routine comes with no notice of its own.
		f.setRoutines([routine(), routine({ routineId: id(62), title: "Evening note" })]);
		action("turn-on-plan").click();
		await settle();
		expect(
			(f.offer.routines.setEnabled.mock.calls as unknown as [WebRoutine, WebMemberConnection][]).map(
				([entry, account]) => [entry.routineId, account.connectionVersion],
			),
		).toEqual([
			[id(61), 4],
			[id(62), 4],
		]);
	});
	it("comes back after a failed read, and a failed plan read hides only the card", async () => {
		const f = planSetup({ notices: [waitingNotice(), item(70)] });
		f.offer.native.chatGptPlanAvailable.mockRejectedValueOnce(new Error("offline"));
		await settle();
		// The other notice still shows.
		expect(text(f.view)).toBe(FULL);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(text(f.view)).toContain("Morning brief can run while you're away.");
		f.client.listNotifications.mockRejectedValueOnce(new Error("offline"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(text(f.view)).toContain("Morning brief can run while you're away.");
		expect(f.offer.native.recordRoutineOffer).toHaveBeenCalledOnce();
	});
	it("says nothing more once the kernel started the routine (20260928369985), and saves no routine", async () => {
		for (const manage of [true, false]) {
			const f = planSetup({ manage });
			await settle();
			f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {
				// Routines that do not wait for this plan are left alone too.
				f.setRoutines([
					routine({ status: "active", pauseReason: undefined }),
					routine({ routineId: id(63), pauseReason: "agent" }),
					routine({ routineId: id(64), runsForUserId: id(98) }),
				]);
			});
			const reads = f.offer.native.listConnections.mock.calls.length;
			action("turn-on-plan").click();
			await settle();
			expect(f.offer.routines.setEnabled).not.toHaveBeenCalled();
			expect(f.offer.native.listConnections).toHaveBeenCalledTimes(reads);
			expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
			expect(f.view.el.hidden).toBe(true);
			f.view.dispose();
		}
	});
	it("tells a member who does not save routines only about a routine that still waits", async () => {
		const f = planSetup({
			manage: false,
			routines: [routine(), routine({ routineId: id(62), title: "Evening note" })],
		});
		await settle();
		f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {
			// The kernel started one; the other was busy at that moment.
			f.setRoutines([
				routine({ status: "active", pauseReason: undefined }),
				routine({ routineId: id(62), title: "Evening note" }),
			]);
		});
		action("turn-on-plan").click();
		await settle();
		expect(text(f.view)).toBe(
			"Your ChatGPT plan now works while you're away. Ask the agent to set Evening note up again.",
		);
	});
	it("names the agent of the routines that still wait, not of the ones it was asked about", async () => {
		const f = planSetup({
			manage: false,
			routines: [routine({ staffAgentId: id(60) }), routine({ routineId: id(62), staffAgentId: id(63) })],
		});
		await settle();
		// Both that still wait now are the same agent's.
		f.setRoutines([routine({ staffAgentId: id(60) }), routine({ routineId: id(65), staffAgentId: id(60) })]);
		action("turn-on-plan").click();
		await settle();
		expect(text(f.view)).toBe(
			"Your ChatGPT plan now works while you're away. Ask the agent to set those routines up again.",
		);
	});
	it("says a busy switch is busy, and a second press works", async () => {
		const f = planSetup();
		await settle();
		f.offer.native.setWorkWhileAway.mockRejectedValueOnce(new PlanSwitchBusyError());
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain("Busy right now. Try again in a moment.");
		expect(f.view.el.textContent).not.toContain("could not be turned on");
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.native.setWorkWhileAway).toHaveBeenCalledTimes(2);
		expect(f.view.el.hidden).toBe(true);
	});
	it("after a failure, says only what is known", async () => {
		// A member who does not save routines: the switch went through, the routines could not be read again.
		let f = planSetup({ manage: false });
		await settle();
		f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {
			f.setRoutines([routine({ status: "active", pauseReason: undefined })]);
		});
		f.offer.routines.list.mockRejectedValueOnce(new Error("offline"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but your routines could not be checked. Try again.",
		);
		expect(f.view.el.textContent).not.toContain("could not be started");
		f.view.dispose();
		// An owner: the kernel started one of two, and the other's save failed.
		f = planSetup({ routines: [routine(), routine({ routineId: id(62), title: "Evening note" })] });
		await settle();
		f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {
			f.setRoutines([
				routine({ status: "active", pauseReason: undefined }),
				routine({ routineId: id(62), title: "Evening note" }),
			]);
		});
		f.offer.routines.setEnabled.mockRejectedValueOnce(new Error("refused"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routine could not be started. Try again.",
		);
		f.view.dispose();
		// An owner: the web saved the first, and the second's save failed.
		f = planSetup({ routines: [routine(), routine({ routineId: id(62), title: "Evening note" })] });
		await settle();
		f.offer.routines.setEnabled.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("refused"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routine could not be started. Try again.",
		);
		f.view.dispose();
		// An owner whose plan does not read as on after the switch: nothing is saved.
		f = planSetup();
		await settle();
		f.offer.native.setWorkWhileAway.mockImplementationOnce(async () => {});
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.routines.setEnabled).not.toHaveBeenCalled();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routine could not be started. Try again.",
		);
	});
	it("Not now leaves the routine waiting and never asks again in this window", async () => {
		const f = planSetup({ notices: [waitingNotice(77)] });
		await settle();
		action("not-now-plan").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledWith(id(77), expect.any(AbortSignal));
		expect(f.offer.native.setWorkWhileAway).not.toHaveBeenCalled();
		expect(f.view.el.hidden).toBe(true);
		// A later notice in the same window brings no card back.
		f.client.listNotifications.mockResolvedValue([waitingNotice(78)]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.view.el.hidden).toBe(true);
	});
	it("says what failed, keeps the card usable, and does not turn the plan on twice", async () => {
		const f = planSetup();
		await settle();
		f.offer.native.setWorkWhileAway.mockRejectedValueOnce(new Error("offline"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain("“Work while you're away” could not be turned on. Try again.");
		expect(action("turn-on-plan").hasAttribute("aria-disabled")).toBe(false);
		f.offer.routines.setEnabled.mockRejectedValueOnce(new Error("refused"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routine could not be started. Try again.",
		);
		// Two wait now, and neither started: the card says routines.
		f.setRoutines([routine(), routine({ routineId: id(62), title: "Evening note" })]);
		f.offer.routines.setEnabled.mockRejectedValueOnce(new Error("refused"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routines could not be started. Try again.",
		);
		action("turn-on-plan").click();
		await settle();
		expect(f.offer.native.setWorkWhileAway).toHaveBeenCalledTimes(2);
		expect(f.offer.routines.setEnabled).toHaveBeenCalledTimes(4);
		expect(f.view.el.hidden).toBe(true);
	});
	it("says routines when several could not be started", async () => {
		const f = planSetup({ routines: [routine(), routine({ routineId: id(62), title: "Evening note" })] });
		await settle();
		f.offer.routines.setEnabled.mockRejectedValueOnce(new Error("refused"));
		action("turn-on-plan").click();
		await settle();
		expect(f.view.el.textContent).toContain(
			"“Work while you're away” is on, but the routines could not be started. Try again.",
		);
	});
	it("records the showing only once the card is on a page the member can see", async () => {
		const f = planSetup({ mounted: false });
		await settle();
		expect(f.offer.native.recordRoutineOffer).not.toHaveBeenCalled();
		document.body.append(f.view.el);
		f.client.listNotifications.mockResolvedValue([waitingNotice(79)]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.offer.native.recordRoutineOffer).toHaveBeenCalledOnce();
	});
	it("records nothing for a card read while the page went out of sight", async () => {
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const f = planSetup();
		const routines = deferred<WebRoutine[]>();
		f.offer.routines.list.mockImplementationOnce(() => routines.promise);
		await settle();
		visibility = "hidden";
		routines.resolve([routine()]);
		await settle();
		expect(f.offer.native.recordRoutineOffer).not.toHaveBeenCalled();
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(f.offer.native.recordRoutineOffer).toHaveBeenCalledOnce();
	});
	it("names only the action that is busy", async () => {
		const f = planSetup();
		await settle();
		const ack = deferred<MemberNotification>();
		f.client.acknowledgeNotification.mockImplementationOnce(() => ack.promise);
		action("not-now-plan").click();
		await settle();
		expect(action("turn-on-plan").textContent).toBe("Turn on");
		expect(action("turn-on-plan").getAttribute("aria-disabled")).toBe("true");
		ack.resolve({ ...waitingNotice(), acknowledgedAt: timestamp });
		await settle();
	});
	it("shows a Gemini monthly spend cap notice and lets the member dismiss it", async () => {
		const noticeItem: MemberNotification = {
			notificationId: id(95),
			profileId: profileA.profileId,
			kind: "gemini_cap_reached",
			createdAt: timestamp,
			acknowledgedAt: null,
			subject: {
				schema: "qorpera.member-notification.gemini-cap-reached/v1",
				month: "2026-11",
				spendMicrodollars: 100_250_000,
				monthlyCapCents: 10_000,
				runId: id(96),
				sessionId: id(97),
			},
		};
		const f = setup([noticeItem]);
		await settle();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.querySelector(".company-notice p")?.textContent).toBe(
			"Your monthly Gemini API spend cap of $100 was reached ($100.25 used in November 2026). Raise the cap in Settings or switch models to continue.",
		);
		action("dismiss-notification").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(id(95), expect.any(AbortSignal));
		expect(f.view.el.hidden).toBe(true);
	});
});
