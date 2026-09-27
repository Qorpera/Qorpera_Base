import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRpcError } from "../src/cloud/client.ts";
import { createWebSessionModel } from "../src/cloud/session-model.ts";
import { deferred, fixture, id, session, settle, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const model = { session_id: session.sessionId, model_id: "gpt-6-astra", reasoning_effort: "low", version: 0 };

function setup() {
	const f = fixture();
	const company = new AbortController();
	const view = new AbortController();
	const current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(model));
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		control: createWebSessionModel(f.cloud, userA.id, company.signal, current),
	};
}

describe("conversation model transport", () => {
	it("reads the effective model and saves only the selected conversation with its observed version", async () => {
		const f = setup();
		expect(await f.control.read(session.sessionId, f.view.signal)).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-6-astra",
			reasoningEffort: "low",
			version: 0,
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "gpt-6-sol", reasoning_effort: "high", version: 1 }),
		);
		expect(
			await f.control.set(session.sessionId, { modelId: "gpt-6-sol", reasoningEffort: "high" }, 0, f.view.signal),
		).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-6-sol",
			reasoningEffort: "high",
			version: 1,
		});
		const [url, request] = f.fetch.mock.calls[1]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_set_session_model");
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: "gpt-6-sol",
			p_expected_version: 0,
			p_reasoning_effort: "high",
		});
		expect(f.current).toHaveBeenCalledWith(session.sessionId);
	});

	it("saves only an effort, leaving the conversation's model to the cloud", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "gpt-native", reasoning_effort: "high", version: 1 }),
		);
		expect(await f.control.set(session.sessionId, { reasoningEffort: "high" }, 0)).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-native",
			reasoningEffort: "high",
			version: 1,
		});
		expect(JSON.parse(f.fetch.mock.calls[0]![1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: null,
			p_expected_version: 0,
			p_reasoning_effort: "high",
		});
		await expect(f.control.set(session.sessionId, {}, 1)).rejects.toThrow("Refresh");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("reads a group chat with no model chosen as none, and saves an effort there", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, model_id: null }));
		expect(await f.control.read(session.sessionId)).toEqual({
			sessionId: session.sessionId,
			reasoningEffort: "low",
			version: 0,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, model_id: null, reasoning_effort: "high", version: 1 }));
		expect(await f.control.set(session.sessionId, { reasoningEffort: "high" }, 0)).toEqual({
			sessionId: session.sessionId,
			reasoningEffort: "high",
			version: 1,
		});
		// A missing or empty model is still a broken answer.
		const { model_id: _, ...missing } = model;
		f.fetch.mockResolvedValueOnce(Response.json(missing));
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Invalid conversation model response.");
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, model_id: "" }));
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Invalid conversation model response.");
	});
	it("works with a cloud that predates per-conversation effort", async () => {
		const f = setup();
		const { reasoning_effort: _, ...older } = model;
		f.fetch.mockResolvedValueOnce(Response.json(older));
		expect(await f.control.read(session.sessionId)).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-6-astra",
			version: 0,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ ...older, model_id: "gpt-6-luna", version: 1 }));
		expect(await f.control.set(session.sessionId, { modelId: "gpt-6-luna" }, 0)).toMatchObject({
			modelId: "gpt-6-luna",
			version: 1,
		});
		expect(JSON.parse(f.fetch.mock.calls[1]![1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: "gpt-6-luna",
			p_expected_version: 0,
		});
	});

	it("retains unknown existing models while refusing unsupported new selections", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "future-model", reasoning_effort: "xhigh", version: 5 }),
		);
		expect(await f.control.read(session.sessionId)).toMatchObject({
			modelId: "future-model",
			reasoningEffort: "xhigh",
			version: 5,
		});
		await expect(f.control.set(session.sessionId, { modelId: "future-model" }, 5)).rejects.toThrow("Refresh");
		for (const retired of ["gpt-5.6-sol", "gpt-5.6-terra"])
			await expect(f.control.set(session.sessionId, { modelId: retired }, 5)).rejects.toThrow("Refresh");
		await expect(
			f.control.set(session.sessionId, { modelId: "gpt-6-sol", reasoningEffort: "xhigh" }, 5),
		).rejects.toThrow("Refresh");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ session_id: id(90) },
		{ model_id: "" },
		{ model_id: " gpt-6-astra" },
		{ model_id: "x".repeat(257) },
		{ reasoning_effort: "" },
		{ reasoning_effort: " low" },
		{ reasoning_effort: 2 },
		{ reasoning_effort: null },
		{ reasoning_effort: "x".repeat(65) },
		{ version: -1 },
		{ version: 0.5 },
		{ version: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects an invalid response %j", async (invalid) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, ...invalid }));
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Invalid conversation model response");
	});

	it.each([
		{ model_id: "gpt-6-sol", reasoning_effort: "medium", version: 0 },
		{ model_id: "gpt-6-astra", reasoning_effort: "medium", version: 1 },
		{ model_id: "gpt-6-sol", reasoning_effort: "medium", version: 2 },
		{ model_id: "gpt-6-sol", reasoning_effort: "low", version: 1 },
		{ model_id: "gpt-6-sol", reasoning_effort: undefined, version: 1 },
	])("does not confirm a different model, effort or revision after saving %j", async (invalid) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, ...invalid }));
		await expect(
			f.control.set(session.sessionId, { modelId: "gpt-6-sol", reasoningEffort: "medium" }, 0),
		).rejects.toThrow("Refresh");
	});

	it("refuses a switched account before dispatch", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Sign in again");
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it.each(["company", "view"] as const)("aborts the %s lifetime during authentication", async (lifetime) => {
		const f = setup();
		const original = await f.cloud.supabase.auth.getSession();
		const token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.control.read(session.sessionId, f.view.signal)).rejects.toThrow();
		await settle();
		f[lifetime].abort();
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("rechecks authority after authentication and refuses dispatch after revocation", async () => {
		const f = setup();
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Access changed");
			});
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Access changed");
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("aborts the actual network signal and rejects a late response", async () => {
		const f = setup();
		const response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const rejected = expect(f.control.read(session.sessionId, f.view.signal)).rejects.toThrow();
		await settle();
		f.company.abort();
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		await rejected;
		response.resolve(Response.json(model));
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("discards a response when session authority changed while it was in flight", async () => {
		const f = setup();
		const response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const reading = f.control.read(session.sessionId);
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Session unavailable");
		});
		response.resolve(Response.json(model));
		await expect(reading).rejects.toThrow("Session unavailable");
	});

	it("preserves conflict and permission errors without replaying a write", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ code: "QRC01", message: "Conversation model changed; refresh first." }, { status: 409 }),
		);
		const sol = { modelId: "gpt-6-sol" };
		await expect(f.control.set(session.sessionId, sol, 0)).rejects.toMatchObject({ code: "QRC01" });
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
		await expect(f.control.set(session.sessionId, sol, 0)).rejects.toBeInstanceOf(CloudRpcError);
		f.fetch.mockRejectedValueOnce(new Error("Lost response after commit"));
		await expect(f.control.set(session.sessionId, sol, 0)).rejects.toThrow("Refresh");
		expect(f.fetch).toHaveBeenCalledTimes(3);
	});

	it("bounds authentication and prevents dispatch after its deadline", async () => {
		vi.useFakeTimers();
		const f = setup();
		const original = await f.cloud.supabase.auth.getSession();
		const token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.control.read(session.sessionId)).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("bounds response bodies", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, excess: "x".repeat(16384) }));
		await expect(f.control.read(session.sessionId)).rejects.toThrow();
	});

	it("rejects unsafe origins before authentication", () => {
		const f = fixture();
		f.cloud.config.projectUrl = "https://fixture.invalid/other";
		expect(() => createWebSessionModel(f.cloud, userA.id, new AbortController().signal, () => {})).toThrow(
			"Invalid conversation model configuration",
		);
		expect(f.cloud.supabase.auth.getSession).not.toHaveBeenCalled();
	});
});
