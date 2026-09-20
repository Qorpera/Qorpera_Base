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
const item = (n = 70): CompanyExecutionNotification => ({
	notificationId: id(n),
	profileId: profileA.profileId,
	kind: "sponsor_handoff",
	createdAt: timestamp,
	acknowledgedAt: null,
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
	it("shows addressed updates without acknowledging, and preserves focus/DOM during unchanged polling", async () => {
		const f = setup();
		await settle();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.textContent).toBe("Execution sponsor changed");
		expect(f.view.el.querySelector("p, small")).toBeNull();
		expect(f.view.el.querySelectorAll("button")).toHaveLength(1);
		const dismiss = action("dismiss-notification");
		dismiss.focus();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(action("dismiss-notification")).toBe(dismiss);
		expect(document.activeElement).toBe(dismiss);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
	});
	it("dismisses queued notices one at a time and skips acknowledged records", async () => {
		const f = setup([item(70), item(71), { ...item(72), acknowledgedAt: timestamp }]);
		await settle();
		expect(f.view.el.querySelectorAll(".notification-card")).toHaveLength(1);
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
	it("requires a read after an uncertain acknowledgment without replaying it", async () => {
		const f = setup();
		await settle();
		f.client.acknowledgeNotification.mockRejectedValueOnce(new Error("response lost"));
		action("dismiss-notification").click();
		await settle();
		expect(f.view.el.textContent).toBe("Dismissal could not be confirmedRefresh");
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
		f.client.listNotifications.mockResolvedValue([{ ...item(), acknowledgedAt: timestamp }]);
		action("refresh").click();
		await settle();
		expect(f.view.el.hidden).toBe(true);
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
	});
	it("locally closes an uncertain dismissal without replaying the write or reopening on stale reads", async () => {
		const f = setup();
		await settle();
		f.client.acknowledgeNotification.mockRejectedValueOnce(new Error("response lost"));
		action("dismiss-notification").click();
		await settle();
		action("dismiss-notification").focus();
		action("dismiss-notification").click();
		expect(f.view.el.hidden).toBe(true);
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
	it("dismisses with Escape inside the card while leaving workspace Escape alone", async () => {
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
	])("rejects invalid acknowledgment receipts and prevents repeat clicks during a write: %j", async (receipt) => {
		const f = setup();
		await settle();
		const pending = deferred<CompanyExecutionNotification>();
		f.client.acknowledgeNotification.mockReturnValueOnce(pending.promise);
		action("dismiss-notification").click();
		action("dismiss-notification").click();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
		pending.resolve({ ...item(), ...receipt });
		await settle();
		expect(f.view.el.textContent).toContain("could not be confirmed");
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
	it("surfaces unavailable reads and clears stale content until explicitly refreshed", async () => {
		const f = setup();
		await settle();
		f.client.listNotifications.mockRejectedValueOnce(new Error("denied"));
		await f.view.refresh();
		expect(f.view.el.textContent).toContain("updates are unavailable");
		expect(f.view.el.textContent).not.toContain("Execution sponsor changed");
		action("refresh").click();
		await settle();
		expect(f.view.el.textContent).toContain("Execution sponsor changed");
	});
	it("keeps a closed offline error hidden across failed polls and shows a new outage after recovery", async () => {
		const f = setup();
		await settle();
		f.client.listNotifications.mockRejectedValue(new Error("offline"));
		await f.view.refresh();
		action("dismiss-notification").focus();
		action("dismiss-notification").click();
		expect(f.view.el.hidden).toBe(true);
		expect(f.restoreFocus).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.view.el.hidden).toBe(true);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
		f.client.listNotifications.mockResolvedValue([]);
		await f.view.refresh();
		f.client.listNotifications.mockRejectedValue(new Error("offline again"));
		await f.view.refresh();
		expect(f.view.el.hidden).toBe(false);
		expect(f.view.el.textContent).toBe("Company updates are unavailableRefresh");
	});
	it("removes its popup on disposal and ignores a late acknowledgment receipt", async () => {
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
	it("keeps keyboard focus on dismiss when a failed poll shows an error", async () => {
		const f = setup();
		await settle();
		action("dismiss-notification").focus();
		f.client.listNotifications.mockRejectedValueOnce(new Error("offline"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(document.activeElement).toBe(action("dismiss-notification"));
		expect(f.restoreFocus).not.toHaveBeenCalled();
	});
	it("moves focus to dismiss when a successful retry removes Refresh", async () => {
		const f = setup();
		await settle();
		f.client.listNotifications.mockRejectedValueOnce(new Error("offline"));
		await f.view.refresh();
		action("refresh").focus();
		action("refresh").click();
		await settle();
		expect(document.activeElement).toBe(action("dismiss-notification"));
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
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
			"company_ceiling_tripped",
			{
				schema: "qorpera.member-notification.company-ceiling-tripped/v1",
				dimension: "spend",
				ceiling: 100,
				periodStart: timestamp,
			},
			"Company execution limit reached",
		],
		[
			"company_ceiling_tripped",
			{
				schema: "qorpera.member-notification.machine-capacity/v1",
				dimension: "machines",
				ceiling: 2,
				used: 2,
				allocationId: id(90),
			},
			"Company computer limit reached",
		],
		[
			"company_execution_paused",
			{
				schema: "qorpera.member-notification.company-execution-stop/v1",
				paused: true,
				byUserId: id(91),
				reason: "Check spend",
				at: timestamp,
			},
			"Company execution paused",
		],
		[
			"company_execution_resumed",
			{
				schema: "qorpera.member-notification.company-execution-stop/v1",
				paused: false,
				byUserId: id(91),
				reason: null,
				at: timestamp,
			},
			"Company execution resumed",
		],
	] as const)("presents %s notices", async (kind, subject, text) => {
		const f = setup([{ ...item(), kind, subject }]);
		await settle();
		expect(f.view.el.textContent).toBe(text);
	});
	it("gives a reached usage limit no popup and never acknowledges it: the failed run's card tells it", async () => {
		const usage = {
			...item(),
			notificationId: id(79),
			kind: "provider_usage_limit" as const,
			subject: {
				schema: "qorpera.member-notification.provider-usage-limit/v1" as const,
				provider: "openai",
				resetsAt: timestamp,
				runId: id(80),
				connectionId: id(81),
			},
		};
		const alone = setup([usage]);
		await settle();
		expect(alone.view.el.hidden).toBe(true);
		expect(alone.view.el.textContent).toBe("");
		expect(alone.client.acknowledgeNotification).not.toHaveBeenCalled();
		// Other notices still show, also behind a usage-limit one.
		const mixed = setup([usage, item()]);
		await settle();
		expect(mixed.view.el.textContent).toBe("Execution sponsor changed");
	});
});

it("mounts notices in the company workspace, then clears them on account change", async () => {
	const f = fixture();
	const wire = {
		schema: "qorpera.member-notification/v1",
		notification_id: id(70),
		profile_id: profileA.profileId,
		kind: "sponsor_handoff",
		created_at: timestamp,
		acknowledged_at: null,
		subject: item().subject,
	};
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
	expect(root.querySelector('.notification-stack[aria-label="Notifications"] .execution-notices')).not.toBeNull();
	expect(root.querySelector(".execution-notices")?.textContent).toContain("Execution sponsor changed");
	expect(root.querySelector('a[href$="/notifications"]')).toBeNull();
	const oldNotices = root.querySelector(".execution-notices")!;
	transport.mockImplementation(async () => Response.json([]));
	f.auth(userB);
	await vi.advanceTimersByTimeAsync(100);
	expect(oldNotices.isConnected).toBe(false);
	expect(root.querySelector(".execution-notices")?.textContent ?? "").not.toContain("Execution sponsor changed");
});
