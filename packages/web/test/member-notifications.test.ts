import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebMemberNotifications } from "../src/cloud/member-notifications.ts";
import { deferred, fixture, id, profileA, settle, timestamp, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const full = {
	schema: "qorpera.member-notification/v1",
	notification_id: id(90),
	profile_id: profileA.profileId,
	kind: "company_ceiling_tripped",
	created_at: timestamp,
	acknowledged_at: null,
	subject: {
		schema: "qorpera.member-notification.machine-capacity/v1",
		dimension: "machines",
		ceiling: 2,
		used: 2,
		allocationId: id(13),
	},
};
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController(),
		current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json([full]));
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		client: createWebMemberNotifications(f.cloud, profileA.profileId, userA.id, company.signal, current),
	};
}
describe("company notices member read", () => {
	it("binds notification lists to the member/company and acknowledges only an observed exact id", async () => {
		const f = setup();
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("Refresh notifications");
		expect(f.fetch).not.toHaveBeenCalled();
		expect(await f.client.listNotifications()).toMatchObject([
			{ notificationId: id(90), profileId: profileA.profileId, acknowledgedAt: null },
		]);
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_list_member_notifications");
		expect(JSON.parse(request!.body as string)).toEqual({ p_profile_id: profileA.profileId, p_limit: 50 });
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request!.headers).get("authorization")).toBe("Bearer fixture-token");
		f.fetch.mockResolvedValueOnce(Response.json({ ...full, acknowledged_at: timestamp }));
		expect(await f.client.acknowledgeNotification(id(90))).toMatchObject({
			notificationId: id(90),
			acknowledgedAt: timestamp,
		});
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toEqual({ p_notification_id: id(90) });
		f.fetch.mockResolvedValueOnce(Response.json([]));
		await f.client.listNotifications();
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("Refresh notifications");
	});
	it("projects every published notification subject without exposing extra fields", async () => {
		const f = setup();
		const subjects = [
			{
				kind: "provider_usage_limit",
				subject: {
					schema: "qorpera.member-notification.provider-usage-limit/v1",
					provider: "openai",
					resetsAt: timestamp,
					runId: id(11),
					connectionId: id(12),
					private: "hidden",
				},
			},
			{ kind: "company_ceiling_tripped", subject: full.subject },
			{
				kind: "run_no_progress",
				subject: {
					schema: "qorpera.member-notification.run-no-progress/v1",
					runId: id(11),
					staffAgentId: id(15),
					sessionId: null,
					since: timestamp,
					minutes: 15,
					worker: true,
					private: "hidden",
				},
			},
		];
		f.fetch.mockResolvedValueOnce(
			Response.json(subjects.map((v, i) => ({ ...full, ...v, notification_id: id(100 + i) }))),
		);
		const result = await f.client.listNotifications();
		expect(result).toHaveLength(3);
		expect(result[0]!.subject).not.toHaveProperty("private");
		expect(result[1]!.subject).toMatchObject({ dimension: "machines", used: 2, ceiling: 2 });
		// A run with no progress for 15 minutes (gap 4): its run, agent, thread (none for a worker) and last progress.
		expect(result[2]!.subject).toEqual({
			schema: "qorpera.member-notification.run-no-progress/v1",
			runId: id(11),
			staffAgentId: id(15),
			sessionId: null,
			since: timestamp,
			minutes: 15,
			worker: true,
		});
	});
	it("reads a stalled run's worker flag: absent is false, anything but a boolean fails the read (gap 4b)", async () => {
		const f = setup();
		const stalled = {
			...full,
			kind: "run_no_progress",
			subject: {
				schema: "qorpera.member-notification.run-no-progress/v1",
				runId: id(11),
				staffAgentId: id(15),
				sessionId: id(16),
				since: timestamp,
				minutes: 15,
			},
		};
		f.fetch.mockResolvedValueOnce(Response.json([stalled]));
		expect((await f.client.listNotifications())[0]!.subject).toMatchObject({ worker: false, sessionId: id(16) });
		f.fetch.mockResolvedValueOnce(Response.json([{ ...stalled, subject: { ...stalled.subject, worker: "yes" } }]));
		await expect(f.client.listNotifications()).rejects.toThrow();
	});

	it("skips notices of the removed company limits and pause instead of failing the read", async () => {
		const f = setup();
		const retired = [
			{
				kind: "company_ceiling_tripped",
				subject: {
					schema: "qorpera.member-notification.company-ceiling-tripped/v1",
					dimension: "spend",
					ceiling: 100,
					periodStart: timestamp,
				},
			},
			{
				kind: "company_ceiling_tripped",
				subject: {
					schema: "qorpera.member-notification.company-ceiling-tripped/v1",
					dimension: "wakes",
					ceiling: 20,
					periodStart: timestamp,
					used: 20,
				},
			},
			{
				kind: "company_execution_paused",
				subject: {
					schema: "qorpera.member-notification.company-execution-stop/v1",
					paused: true,
					byUserId: userA.id,
					reason: "Runtime update",
					at: timestamp,
				},
			},
			{
				kind: "company_execution_resumed",
				subject: {
					schema: "qorpera.member-notification.company-execution-stop/v1",
					paused: false,
					byUserId: userA.id,
					reason: null,
					at: timestamp,
				},
			},
		];
		f.fetch.mockResolvedValueOnce(
			Response.json([...retired.map((v, i) => ({ ...full, ...v, notification_id: id(100 + i) })), full]),
		);
		expect(await f.client.listNotifications()).toMatchObject([{ notificationId: id(90) }]);
		// A skipped notice was never observed, so it cannot be acknowledged from here.
		await expect(f.client.acknowledgeNotification(id(100))).rejects.toThrow("Refresh notifications");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("reads a routine that waits for its member's account, skips a suspended one, and fails the read for a bad one", async () => {
		const routineNotice = (kind: string, n: number) => ({
			...full,
			notification_id: id(n),
			kind,
			subject: { staffAgentId: id(70), routineId: id(71), title: "Morning brief" },
		});
		let f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json([
				routineNotice("routine_needs_model_account", 100),
				routineNotice("routine_suspended", 101),
				full,
			]),
		);
		expect(await f.client.listNotifications()).toMatchObject([
			{
				notificationId: id(100),
				kind: "routine_needs_model_account",
				subject: {
					schema: "routine-needs-model-account",
					staffAgentId: id(70),
					routineId: id(71),
					title: "Morning brief",
				},
			},
			{ notificationId: id(90) },
		]);
		await expect(f.client.acknowledgeNotification(id(101))).rejects.toThrow("Refresh notifications");
		for (const bad of [
			{ ...routineNotice("routine_needs_model_account", 100), profile_id: id(99) },
			{ ...routineNotice("routine_needs_model_account", 100), subject: null },
			{ ...routineNotice("routine_needs_model_account", 100), subject: { routineId: id(71), title: "x" } },
			{ ...routineNotice("routine_suspended", 101), profile_id: id(99) },
			{ ...routineNotice("routine_suspended", 101), schema: "qorpera.member-notification/v2" },
		]) {
			f = setup();
			f.fetch.mockResolvedValueOnce(Response.json([bad, full]));
			await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		}
	});
	it("reads a routine moved off the member's login (20260930095000), and fails the read for a bad one", async () => {
		const moved = (subject: Record<string, unknown> = {}, n = 100) => ({
			...full,
			notification_id: id(n),
			kind: "routine_payer_changed",
			subject: {
				schema: "qorpera.member-notification.routine-payer-changed/v1",
				routineId: id(71),
				routineVersion: 3,
				staffAgentId: id(70),
				payer: "member",
				payerUserId: userB.id,
				changedByUserId: userB.id,
				reason: "save",
				at: timestamp,
				...subject,
			},
		});
		let f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json([
				moved(),
				moved(
					{ payer: "company", payerUserId: null, changedByUserId: null, reason: "pick", private: "hidden" },
					101,
				),
			]),
		);
		const [member, company] = await f.client.listNotifications();
		expect(member).toMatchObject({ notificationId: id(100), kind: "routine_payer_changed" });
		expect(member!.subject).toEqual({
			schema: "qorpera.member-notification.routine-payer-changed/v1",
			routineId: id(71),
			routineVersion: 3,
			staffAgentId: id(70),
			payer: "member",
			payerUserId: userB.id,
			changedByUserId: userB.id,
			reason: "save",
			at: timestamp,
		});
		// A company account names no member; nothing beyond the published fields is kept.
		expect(company!.subject).toEqual({
			schema: "qorpera.member-notification.routine-payer-changed/v1",
			routineId: id(71),
			routineVersion: 3,
			staffAgentId: id(70),
			payer: "company",
			payerUserId: null,
			changedByUserId: null,
			reason: "pick",
			at: timestamp,
		});
		for (const bad of [
			moved({ schema: undefined }),
			moved({ schema: "qorpera.member-notification.routine-payer-changed/v2" }),
			{ ...moved(), kind: "routine_suspended_payer" },
			moved({ routineId: "routine" }),
			moved({ routineVersion: 0 }),
			moved({ staffAgentId: null }),
			moved({ payer: "agent" }),
			moved({ payerUserId: null }),
			moved({ payer: "company" }),
			moved({ changedByUserId: "someone" }),
			moved({ reason: "swap" }),
			moved({ at: "yesterday" }),
		]) {
			f = setup();
			f.fetch.mockResolvedValueOnce(Response.json([bad, full]));
			await expect(f.client.listNotifications(), JSON.stringify(bad)).rejects.toThrow("invalid response");
		}
	});
	it("reads a good will card that failed (20260930571000), links only Stripe's invoice page, and fails a bad one", async () => {
		const failed = (subject: Record<string, unknown> = {}, n = 110) => ({
			...full,
			notification_id: id(n),
			kind: "good_will_card_failed",
			subject: {
				schema: "qorpera.member-notification.good-will-card-failed/v1",
				month: "2026-11",
				dueOre: 510000,
				invoiceUrl: "https://invoice.stripe.com/i/1",
				mine: true,
				...subject,
			},
		});
		let f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json([failed(), failed({ invoiceUrl: "https://evil.example/i", mine: false }, 111)]),
		);
		const [own, other] = await f.client.listNotifications();
		expect(own!.subject).toEqual({
			schema: "qorpera.member-notification.good-will-card-failed/v1",
			month: "2026-11",
			dueOre: 510000,
			invoiceUrl: "https://invoice.stripe.com/i/1",
			mine: true,
		});
		expect(other!.subject).toMatchObject({ invoiceUrl: null, mine: false });
		for (const bad of [
			failed({ month: "2026-13" }),
			failed({ dueOre: -1 }),
			failed({ mine: "yes" }),
			failed({ invoiceUrl: 1 }),
		]) {
			f = setup();
			f.fetch.mockResolvedValueOnce(Response.json([bad]));
			await expect(f.client.listNotifications(), JSON.stringify(bad)).rejects.toThrow("invalid response");
		}
	});
	it("reads an area's supervision that ended (20260930371000), and fails the read for a bad one", async () => {
		const ended = (subject: Record<string, unknown> = {}, n = 100) => ({
			...full,
			notification_id: id(n),
			kind: "interface_supervision_ended",
			subject: {
				schema: "qorpera.member-notification.interface-supervision-ended/v1",
				supervisionId: id(80),
				tableId: id(81),
				key: ["Sales"],
				supervisorUserId: userB.id,
				reason: "withdrawn",
				byUserId: userB.id,
				at: timestamp,
				...subject,
			},
		});
		let f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json([
				ended(),
				ended({ key: null, reason: "left", byUserId: null, private: "hidden" }, 101),
				ended({ key: [2, true, null, ["a", "b"]], reason: "gone" }, 102),
			]),
		);
		const [withdrawn, left, gone] = await f.client.listNotifications();
		expect(withdrawn).toMatchObject({ notificationId: id(100), kind: "interface_supervision_ended" });
		expect(withdrawn!.subject).toEqual({
			schema: "qorpera.member-notification.interface-supervision-ended/v1",
			supervisionId: id(80),
			tableId: id(81),
			key: ["Sales"],
			supervisorUserId: userB.id,
			reason: "withdrawn",
			byUserId: userB.id,
			at: timestamp,
		});
		// A key too long to carry is null, and a leaving names no member; nothing beyond the published fields is kept.
		expect(left!.subject).toEqual({
			schema: "qorpera.member-notification.interface-supervision-ended/v1",
			supervisionId: id(80),
			tableId: id(81),
			key: null,
			supervisorUserId: userB.id,
			reason: "left",
			byUserId: null,
			at: timestamp,
		});
		expect(gone!.subject).toMatchObject({ key: [2, true, null, ["a", "b"]], reason: "gone" });
		for (const bad of [
			ended({ schema: undefined }),
			ended({ schema: "qorpera.member-notification.interface-supervision-ended/v2" }),
			{ ...ended(), kind: "routine_payer_changed" },
			ended({ supervisionId: "supervision" }),
			ended({ tableId: null }),
			ended({ key: [] }),
			ended({ key: "Sales" }),
			ended({ key: [{ name: "Sales" }] }),
			ended({ key: Array.from({ length: 65 }, () => "a") }),
			ended({ key: [[1]] }),
			ended({ supervisorUserId: null }),
			ended({ reason: "ended" }),
			ended({ byUserId: "someone" }),
			ended({ at: "yesterday" }),
		]) {
			f = setup();
			f.fetch.mockResolvedValueOnce(Response.json([bad, full]));
			await expect(f.client.listNotifications(), JSON.stringify(bad)).rejects.toThrow("invalid response");
		}
	});
	it("fails the read for a retired notice from another company, under another kind or envelope", async () => {
		const pause = {
			...full,
			notification_id: id(100),
			kind: "company_execution_paused",
			subject: {
				schema: "qorpera.member-notification.company-execution-stop/v1",
				paused: true,
				byUserId: userA.id,
				reason: null,
				at: timestamp,
			},
		};
		for (const bad of [
			{ ...pause, profile_id: id(99) },
			{ ...pause, kind: "sponsor_handoff" },
			{ ...pause, kind: "company_ceiling_tripped" },
			{ ...pause, schema: "qorpera.member-notification/v2" },
		]) {
			const f = setup();
			f.fetch.mockResolvedValueOnce(Response.json([bad, full]));
			await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		}
	});
	it("rejects cross-profile notifications, duplicate identities, unknown kinds and mismatched receipts", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json([{ ...full, profile_id: id(99) }]));
		await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		f.fetch.mockResolvedValueOnce(Response.json([full, full]));
		await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		f.fetch.mockResolvedValueOnce(Response.json([{ ...full, kind: "something_new" }]));
		await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		f.fetch.mockResolvedValueOnce(Response.json([full]));
		await f.client.listNotifications();
		f.fetch.mockResolvedValueOnce(Response.json({ ...full, notification_id: id(91), acknowledged_at: timestamp }));
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("invalid response");
	});
	it("refuses a refreshed account before dispatch and fences a company change after auth", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.client.listNotifications()).rejects.toThrow("could not be confirmed");
		expect(f.fetch).not.toHaveBeenCalled();
		f.auth(userA);
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Company changed");
			});
		await expect(f.client.listNotifications()).rejects.toThrow("could not be confirmed");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it.each(["company", "view"] as const)("aborts %s during authentication without dispatch", async (scope) => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.listNotifications(f.view.signal)).rejects.toThrow();
		await settle();
		f[scope].abort();
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("discards a late response after route authority changes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const reading = f.client.listNotifications();
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Company changed");
		});
		response.resolve(Response.json([full]));
		await expect(reading).rejects.toThrow("could not be confirmed");
	});
	it("checks authority after parsing before returning a successful record", async () => {
		const f = setup();
		let checks = 0;
		f.current.mockImplementation(() => {
			if (++checks === 5) throw new Error("Company changed after response");
		});
		await expect(f.client.listNotifications()).rejects.toThrow("could not be confirmed");
		expect(checks).toBe(5);
	});
	it("rejects oversized responses", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
		await expect(f.client.listNotifications()).rejects.toThrow("could not be confirmed");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each([401, 403])("preserves safe status %s without leaking internal diagnostics or retrying", async (status) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("sensitive detail", { status }));
		await expect(f.client.listNotifications()).rejects.toMatchObject({ status, code: "42501" });
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("does not retry an uncertain acknowledgment and bounds authentication time", async () => {
		const f = setup();
		await f.client.listNotifications();
		f.fetch.mockResolvedValueOnce(new Response("sensitive detail", { status: 500 }));
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("Company notices could not be confirmed.");
		expect(f.fetch).toHaveBeenCalledTimes(2);
		vi.useFakeTimers();
		const token = deferred<Awaited<ReturnType<typeof f.cloud.supabase.auth.getSession>>>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.listNotifications()).rejects.toThrow("could not be confirmed");
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
});
