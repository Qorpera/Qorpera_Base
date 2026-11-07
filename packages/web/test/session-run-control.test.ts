import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSessionRunControl } from "../src/cloud/session-run-control.ts";
import { deferred, fixture, id, session, settle, staff, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController(),
		current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
		Response.json({
			session_id: session.sessionId,
			staff_agent_id: staff.id,
			run: { run_id: id(90), status: "leased", can_cancel: true },
		}),
	);
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		control: createWebSessionRunControl(f.cloud, userA.id, company.signal, current),
	};
}
describe("member cloud run control transport", () => {
	it("reads and cancels only the selected cloud run through the shared client", async () => {
		const f = setup();
		expect(await f.control.read(session.sessionId, staff.id, f.view.signal)).toEqual({
			sessionId: session.sessionId,
			staffAgentId: staff.id,
			run: { runId: id(90), status: "leased", canCancel: true },
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({ session_id: session.sessionId, run_id: id(90), status: "cancelled" }),
		);
		expect(await f.control.cancel(session.sessionId, id(90), f.view.signal)).toBe("cancelled");
		expect(f.fetch).toHaveBeenCalledTimes(2);
		const [url, request] = f.fetch.mock.calls[1]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_cancel_session_run");
		expect(request).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
		expect(request?.cache).toBeUndefined();
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({ p_session_id: session.sessionId, p_run_id: id(90) });
		expect(f.current).toHaveBeenCalledWith(session.sessionId);
	});
	it("refuses a different token owner before dispatch", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it.each(["company", "view"] as const)("aborts the %s lifetime during token refresh", async (lifetime) => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.control.cancel(session.sessionId, id(90), f.view.signal)).rejects.toThrow();
		await settle();
		f[lifetime].abort();
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("rechecks session authority after token refresh", async () => {
		const f = setup();
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Session changed");
			});
		await expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("aborts an in-flight request and rejects its late response", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const rejected = expect(f.control.read(session.sessionId, staff.id, f.view.signal)).rejects.toThrow();
		await settle();
		f.company.abort();
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		await rejected;
		response.resolve(Response.json({ session_id: session.sessionId, staff_agent_id: staff.id, run: null }));
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects a response after account or company authority changes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const reading = f.control.read(session.sessionId, staff.id);
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Account changed");
		});
		response.resolve(Response.json({ session_id: session.sessionId, staff_agent_id: staff.id, run: null }));
		await expect(reading).rejects.toThrow("unavailable");
	});
	it("does not replay an uncertain cancellation and retains the SDK recovery instruction", async () => {
		const f = setup();
		f.fetch.mockRejectedValueOnce(new Error("Lost response after commit"));
		await expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow(
			"Could not confirm that the cloud run stopped. Refresh its status before trying again.",
		);
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("lets the SDK reject another run's cancellation response", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ session_id: session.sessionId, run_id: id(91), status: "cancelled" }),
		);
		await expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow("selected run");
	});
	it("preserves member permission refusals", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
		await expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow("do not have permission");
	});
	it("bounds pending authentication and does not dispatch after the deadline", async () => {
		vi.useFakeTimers();
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.control.cancel(session.sessionId, id(90))).rejects.toThrow("Refresh its status");
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("refuses unsafe origins before authentication", () => {
		const f = fixture();
		f.cloud.config.projectUrl = "https://fixture.invalid/other";
		expect(() => createWebSessionRunControl(f.cloud, userA.id, new AbortController().signal, () => {})).toThrow(
			"Invalid cloud run control configuration",
		);
		expect(f.cloud.supabase.auth.getSession).not.toHaveBeenCalled();
	});
});
