// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSessionInputWriter } from "../src/cloud/session-input.ts";
import { deferred, fixture, id, session, settle, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController();
	const current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
		Response.json({ input_id: id(90), position: 1 }),
	);
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		send: createWebSessionInputWriter(f.cloud, userA.id, company.signal, current),
	};
}
describe("member message transport", () => {
	it("queues only the member prompt with a fixed request identity and no credentials in its URL", async () => {
		const f = setup();
		expect(await f.send(session.sessionId, id(91), "Do the work", f.view.signal)).toEqual({
			inputId: id(90),
			position: 1,
		});
		expect(f.fetch).toHaveBeenCalledTimes(1);
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_append_session_input");
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_client_input_id: id(91),
			p_kind: "user_message",
			p_body: { schema: "qorpera.session-prompt/v1", text: "Do the work", images: [] },
		});
	});
	it("refuses another account's token before sending", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.send(session.sessionId, id(91), "Private draft", f.view.signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it.each(["company", "view"] as const)(
		"aborts %s lifetime during token refresh before dispatch",
		async (lifetime) => {
			const f = setup();
			const original = await f.cloud.supabase.auth.getSession();
			const token = deferred<typeof original>();
			vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
			const sending = f.send(session.sessionId, id(91), "Private draft", f.view.signal);
			const rejected = expect(sending).rejects.toThrow();
			await settle();
			f[lifetime].abort();
			token.resolve(original);
			await rejected;
			expect(f.fetch).not.toHaveBeenCalled();
		},
	);
	it("rechecks session authority after token refresh", async () => {
		const f = setup();
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Session changed");
			});
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow("Session changed");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("rejects a late response after route authority changes without replay", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const sending = f.send(session.sessionId, id(91), "Draft", f.view.signal);
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Route changed");
		});
		response.resolve(Response.json({ input_id: id(90), position: 1 }));
		await expect(sending).rejects.toThrow("Route changed");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("bounds response bytes and rejects malformed receipts", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("x".repeat(16385)));
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
		f.fetch.mockResolvedValueOnce(Response.json({ input_id: "wrong", position: 0 }));
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
	});
	it("bounds token acquisition without dispatch or retry", async () => {
		vi.useFakeTimers();
		const f = setup();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValue(new Promise(() => {}));
		const rejected = expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow("deadline");
		await vi.advanceTimersByTimeAsync(15000);
		await rejected;
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("refuses oversized UTF-8 input before authentication or dispatch", async () => {
		const f = setup();
		await expect(f.send(session.sessionId, id(91), "ø".repeat(32769), f.view.signal)).rejects.toThrow("too large");
		expect(f.cloud.supabase.auth.getSession).not.toHaveBeenCalled();
		expect(f.fetch).not.toHaveBeenCalled();
	});
});
