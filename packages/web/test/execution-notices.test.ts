// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { ExecutionNotices } from "../src/app/views/execution-notices.ts";
import type { CompanyExecutionNotification, WebCompanyExecution } from "../src/cloud/company-execution.ts";
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
const PAUSED = "Agents are paused for this company. They answer again when an owner resumes them in Settings.";
const item = (n = 70, at = timestamp): CompanyExecutionNotification => ({
	notificationId: id(n),
	profileId: profileA.profileId,
	kind: "company_execution_paused",
	createdAt: at,
	acknowledgedAt: null,
	subject: {
		schema: "qorpera.member-notification.company-execution-stop/v1",
		paused: true,
		byUserId: id(91),
		reason: "Check spend",
		at,
	},
});
const handoff = (n = 75): CompanyExecutionNotification => ({
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
function setup(items: readonly CompanyExecutionNotification[] = [item()]) {
	const client = {
		listNotifications: vi
			.fn<Pick<WebCompanyExecution, "listNotifications">["listNotifications"]>()
			.mockResolvedValue(items),
		acknowledgeNotification: vi
			.fn<Pick<WebCompanyExecution, "acknowledgeNotification">["acknowledgeNotification"]>()
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

describe("company execution notices", () => {
	it("shows one plain line without acknowledging, and preserves focus/DOM during unchanged polling", async () => {
		const f = setup();
		await settle();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.querySelector(".company-notice p")?.textContent).toBe(PAUSED);
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
		const pending = deferred<CompanyExecutionNotification>();
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
		const old = deferred<readonly CompanyExecutionNotification[]>();
		f.client.listNotifications.mockReturnValueOnce(old.promise);
		const refresh = f.view.refresh();
		action("dismiss-notification").click();
		await settle();
		old.resolve([item()]);
		await refresh;
		expect(f.view.el.hidden).toBe(true);
		const late = deferred<readonly CompanyExecutionNotification[]>();
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
		expect(f.view.el.textContent).toBe(`${PAUSED}Dismiss`);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
	});
	it("removes its line on disposal and ignores a late acknowledgment receipt", async () => {
		const f = setup();
		await settle();
		const pending = deferred<CompanyExecutionNotification>();
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
	it.each([
		[
			{
				schema: "qorpera.member-notification.company-ceiling-tripped/v1",
				dimension: "spend",
				ceiling: 100,
				periodStart: timestamp,
			},
			"This company reached its monthly spend limit. Agents answer again when an owner raises it in Settings, or when the month turns.",
		],
		[
			{
				schema: "qorpera.member-notification.company-ceiling-tripped/v1",
				dimension: "tokens",
				ceiling: 100,
				periodStart: timestamp,
			},
			"This company reached its monthly token limit. Agents answer again when an owner raises it in Settings, or when the month turns.",
		],
		[
			{
				schema: "qorpera.member-notification.company-ceiling-tripped/v1",
				dimension: "wakes",
				ceiling: 100,
				periodStart: timestamp,
			},
			"Agents were started too often this hour. They answer again within the hour.",
		],
		[
			{
				schema: "qorpera.member-notification.machine-capacity/v1",
				dimension: "machines",
				ceiling: 2,
				used: 2,
				allocationId: id(90),
			},
			"All 2 company computers are in use. Close one to open another.",
		],
	] as const)("says %j in plain words", async (subject, text) => {
		const f = setup([{ ...item(), kind: "company_ceiling_tripped", subject }]);
		await settle();
		expect(f.view.el.querySelector("p")?.textContent).toBe(text);
	});
	it("gives a usage limit, a changed sponsor and a resume no line, and never acknowledges them", async () => {
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
		const resumed: CompanyExecutionNotification = {
			...item(78),
			kind: "company_execution_resumed",
			subject: { ...item().subject, paused: false, reason: null } as CompanyExecutionNotification["subject"],
		};
		const quiet = setup([usage, handoff(), resumed]);
		await settle();
		expect(quiet.view.el.hidden).toBe(true);
		expect(quiet.view.el.textContent).toBe("");
		expect(quiet.client.acknowledgeNotification).not.toHaveBeenCalled();
		// A notice that does get a line still shows behind them.
		const mixed = setup([usage, handoff(), item(70, "2099-01-01T00:00:00.000Z")]);
		await settle();
		expect(mixed.view.el.querySelector("p")?.textContent).toBe(PAUSED);
	});
	it("drops a pause that was resumed later, and keeps one that came after the resume", async () => {
		const resume = (n: number, at: string): CompanyExecutionNotification => ({
			...item(n, at),
			kind: "company_execution_resumed",
			subject: { ...item(n, at).subject, paused: false, reason: null } as CompanyExecutionNotification["subject"],
		});
		const over = setup([item(70, "2026-09-20T10:00:00.000Z"), resume(71, "2026-09-20T11:00:00+00:00")]);
		await settle();
		expect(over.view.el.hidden).toBe(true);
		const again = setup([
			item(70, "2026-09-20T10:00:00.000Z"),
			resume(71, "2026-09-20T11:00:00+00:00"),
			item(72, "2026-09-20T12:00:00.000Z"),
		]);
		await settle();
		expect(again.view.el.querySelector("p")?.textContent).toBe(PAUSED);
		action("dismiss-notification").click();
		await settle();
		expect(again.client.acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(id(72), expect.any(AbortSignal));
		expect(again.view.el.hidden).toBe(true);
	});
});

it("reads notices for the company workspace without any popup, also across an account change", async () => {
	const f = fixture();
	const wire = {
		schema: "qorpera.member-notification/v1",
		notification_id: id(70),
		profile_id: profileA.profileId,
		kind: "company_execution_paused",
		created_at: timestamp,
		acknowledged_at: null,
		subject: {
			schema: "qorpera.member-notification.company-execution-stop/v1",
			paused: true,
			byUserId: id(91),
			reason: "Check spend",
			at: timestamp,
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
	expect(root.textContent).not.toContain("Agents are paused");
	expect(root.querySelector('a[href$="/notifications"]')).toBeNull();
	transport.mockImplementation(async () => Response.json([]));
	f.auth(userB);
	await vi.advanceTimersByTimeAsync(100);
	expect(root.textContent).not.toContain("Agents are paused");
});
