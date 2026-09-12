// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { parseRoute, routeHash } from "../src/app/router.ts";
import { MemberNotificationStatus, MemberNotificationsView } from "../src/app/views/member-notifications.ts";
import type { CompanyExecutionNotification, WebCompanyExecution } from "../src/cloud/company-execution.ts";
import { deferred, fixture, id, profileA, settle, timestamp, userB } from "./fixtures.ts";

const item: CompanyExecutionNotification = {
	notificationId: id(81),
	profileId: profileA.profileId,
	kind: "provider_usage_limit",
	createdAt: timestamp,
	acknowledgedAt: null,
	subject: {
		schema: "qorpera.member-notification.provider-usage-limit/v1",
		provider: "openai",
		resetsAt: timestamp,
		runId: id(82),
		connectionId: id(83),
	},
};
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function action(root: ParentNode, label: string): HTMLButtonElement {
	return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
}
function setup() {
	const client: Pick<WebCompanyExecution, "listNotifications" | "acknowledgeNotification"> = {
		listNotifications: vi.fn(async () => [item]),
		acknowledgeNotification: vi.fn(async () => ({ ...item, acknowledgedAt: timestamp })),
	};
	const lifetime = new AbortController(),
		changed = vi.fn();
	const view = new MemberNotificationsView(client, lifetime.signal, changed);
	cleanup.push(() => view.dispose());
	document.body.append(view.el);
	return { client, lifetime, view, changed };
}
describe("member notification inbox", () => {
	it("reads on entry, focus, online and manual refresh without automatic acknowledgment", async () => {
		const f = setup();
		await settle();
		expect(f.view.el.textContent).toContain("Model account usage limit reached");
		expect(f.view.el.textContent).toContain("OpenAI");
		expect(f.view.el.textContent).toContain("50 recent");
		window.dispatchEvent(new Event("focus"));
		await settle();
		window.dispatchEvent(new Event("online"));
		await settle();
		action(f.view.el, "Refresh notifications").click();
		await settle();
		expect(f.client.listNotifications).toHaveBeenCalledTimes(4);
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
	});
	it("acknowledges only the selected observed notification and publishes its authoritative receipt", async () => {
		const f = setup();
		await settle();
		action(f.view.el, "Acknowledge").click();
		await settle();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledExactlyOnceWith(id(81), expect.any(AbortSignal));
		expect(f.view.el.textContent).toContain("Acknowledged");
		expect(action(f.view.el, "Acknowledge")).toBeUndefined();
		expect(f.changed).toHaveBeenLastCalledWith([{ ...item, acknowledgedAt: timestamp }]);
	});
	it("holds an uncertain acknowledgment until refreshed, never dumping raw error text", async () => {
		const f = setup();
		await settle();
		vi.mocked(f.client.acknowledgeNotification).mockRejectedValueOnce(new Error("credential=SECRET"));
		action(f.view.el, "Acknowledge").click();
		await settle();
		expect(f.view.el.textContent).toContain("Refresh before trying again");
		expect(f.view.el.textContent).not.toContain("SECRET");
		action(f.view.el, "Acknowledge").click();
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
		vi.mocked(f.client.listNotifications).mockResolvedValueOnce([{ ...item, acknowledgedAt: timestamp }]);
		action(f.view.el, "Refresh notifications").click();
		await settle();
		expect(f.view.el.textContent).toContain("Acknowledged");
		expect(f.client.acknowledgeNotification).toHaveBeenCalledTimes(1);
	});
	it("prevents a detached stale action from acknowledging an item removed by refresh", async () => {
		const f = setup();
		await settle();
		const old = action(f.view.el, "Acknowledge");
		vi.mocked(f.client.listNotifications).mockResolvedValueOnce([]);
		await f.view.refresh();
		old.click();
		expect(f.client.acknowledgeNotification).not.toHaveBeenCalled();
		expect(f.view.el.textContent).toContain("No recent notifications");
	});
	it("clears disposed data and refuses late read/ack results", async () => {
		const f = setup();
		await settle();
		const result = deferred<CompanyExecutionNotification>();
		vi.mocked(f.client.acknowledgeNotification).mockReturnValueOnce(result.promise);
		action(f.view.el, "Acknowledge").click();
		f.lifetime.abort();
		result.resolve({ ...item, acknowledgedAt: timestamp });
		await settle();
		expect(f.view.el.textContent).toBe("");
		expect(f.changed).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(f.client.listNotifications).toHaveBeenCalledTimes(1);
	});
	it("uses safe typed labels for pause and handoff metadata, without dumping reasons or identities", async () => {
		const f = setup();
		await settle();
		vi.mocked(f.client.listNotifications).mockResolvedValueOnce([
			{
				...item,
				kind: "company_execution_paused",
				subject: {
					schema: "qorpera.member-notification.company-execution-stop/v1",
					paused: true,
					byUserId: id(99),
					reason: "SECRET private operator text",
					at: timestamp,
				},
			},
			{
				...item,
				notificationId: id(84),
				kind: "sponsor_handoff",
				subject: {
					schema: "qorpera.member-notification.sponsor-handoff/v1",
					runId: id(99),
					fromConnectionId: id(85),
					toConnectionId: id(86),
					reason: "usage_limit",
					at: timestamp,
				},
			},
		]);
		await f.view.refresh();
		expect(f.view.el.textContent).toContain("Company execution paused");
		expect(f.view.el.textContent).toContain("Execution sponsor changed");
		expect(f.view.el.textContent).not.toContain("SECRET");
		expect(f.view.el.textContent).not.toContain(id(99));
	});
	it("coalesces simultaneous reads and presents unavailable instead of an empty all-clear", async () => {
		const f = setup();
		await settle();
		const result = deferred<readonly CompanyExecutionNotification[]>();
		vi.mocked(f.client.listNotifications).mockReturnValueOnce(result.promise);
		const refresh = f.view.refresh();
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(f.client.listNotifications).toHaveBeenCalledTimes(2);
		result.reject(new Error("raw secret"));
		await refresh;
		expect(f.view.el.textContent).toContain("Notifications are unavailable");
		expect(f.view.el.textContent).not.toContain("No recent");
		expect(f.view.el.textContent).not.toContain("raw secret");
	});
});
describe("recent unread notification status", () => {
	it("reads while visible with a bounded interval, suspends when hidden, and clears unavailable state", async () => {
		vi.useFakeTimers();
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const client = { listNotifications: vi.fn(async () => [item]) },
			lifetime = new AbortController(),
			changed = vi.fn();
		const status = new MemberNotificationStatus(client, lifetime.signal, changed);
		cleanup.push(() => status.dispose());
		await settle();
		expect(changed).toHaveBeenLastCalledWith(1, "ready");
		await vi.advanceTimersByTimeAsync(30000);
		expect(client.listNotifications).toHaveBeenCalledTimes(2);
		visibility = "hidden";
		await vi.advanceTimersByTimeAsync(90000);
		expect(client.listNotifications).toHaveBeenCalledTimes(2);
		visibility = "visible";
		vi.mocked(client.listNotifications).mockRejectedValueOnce(new Error("private"));
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(changed).toHaveBeenLastCalledWith(undefined, "unavailable");
		lifetime.abort();
		await vi.advanceTimersByTimeAsync(60000);
		expect(client.listNotifications).toHaveBeenCalledTimes(3);
	});
	it("does not allow an older badge read to undo a fresh inbox acknowledgment", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const pending = deferred<readonly CompanyExecutionNotification[]>(),
			client = { listNotifications: vi.fn(() => pending.promise) },
			changed = vi.fn(),
			lifetime = new AbortController();
		const status = new MemberNotificationStatus(client, lifetime.signal, changed);
		cleanup.push(() => status.dispose());
		status.observe([{ ...item, acknowledgedAt: timestamp }]);
		pending.resolve([item]);
		await settle();
		expect(changed).toHaveBeenLastCalledWith(0, "ready");
	});
});
describe("company notification route", () => {
	it("round-trips a company-scoped URL", () => {
		const route = { name: "company" as const, profileId: profileA.profileId, section: "notifications" as const };
		expect(parseRoute(routeHash(route))).toEqual(route);
	});
	it("mounts from the reachable rail link with real authenticated list and acknowledgment transport", async () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		history.replaceState(null, "", `#/c/${profileA.profileId}/notifications`);
		const f = fixture(),
			root = document.createElement("div");
		document.body.append(root);
		let acknowledged = false;
		const wire = () => ({
			schema: "qorpera.member-notification/v1",
			notification_id: item.notificationId,
			profile_id: item.profileId,
			kind: item.kind,
			subject: item.subject,
			created_at: item.createdAt,
			acknowledged_at: acknowledged ? timestamp : null,
		});
		const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
			if (String(url).endsWith("/qorpera_list_member_notifications")) {
				expect(JSON.parse(init!.body as string)).toEqual({ p_profile_id: profileA.profileId, p_limit: 50 });
				return Response.json([wire()]);
			}
			if (String(url).endsWith("/qorpera_acknowledge_member_notification")) {
				expect(JSON.parse(init!.body as string)).toEqual({ p_notification_id: item.notificationId });
				acknowledged = true;
				return Response.json(wire());
			}
			throw Error("Unexpected notification RPC");
		});
		vi.stubGlobal("fetch", fetcher);
		cleanup.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() => expect(root.textContent).toContain("1 unread in recent notifications"));
		expect(root.querySelector(`.rail a[href="#/c/${profileA.profileId}/notifications"]`)).not.toBeNull();
		action(root, "Acknowledge").click();
		await vi.waitFor(() => expect(root.textContent).toContain("0 unread in recent notifications"));
		expect(
			fetcher.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_acknowledge_member_notification")),
		).toHaveLength(1);
		expect(root.textContent).toContain("Acknowledged");
	});
	it("discards a late account A notification response after switching account", async () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		history.replaceState(null, "", `#/c/${profileA.profileId}/notifications`);
		const f = fixture(),
			root = document.createElement("div"),
			pending = deferred<Response>();
		document.body.append(root);
		let switched = false;
		const fetcher = vi.fn(async () => (switched ? Response.json([]) : pending.promise));
		vi.stubGlobal("fetch", fetcher);
		cleanup.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
		switched = true;
		f.auth(userB);
		pending.resolve(
			Response.json([
				{
					schema: "qorpera.member-notification/v1",
					notification_id: id(81),
					profile_id: profileA.profileId,
					kind: "provider_usage_limit",
					subject: item.subject,
					created_at: timestamp,
					acknowledged_at: null,
				},
			]),
		);
		await settle();
		await vi.waitFor(() => expect(root.textContent).toContain("Account B"));
		expect(root.textContent).not.toContain("OpenAI");
	});
});
