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
			Response.json({ ...model, model_id: "gpt-6.2-sol", reasoning_effort: "high", version: 1 }),
		);
		expect(
			await f.control.set(session.sessionId, { modelId: "gpt-6.2-sol", reasoningEffort: "high" }, 0, f.view.signal),
		).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-6.2-sol",
			reasoningEffort: "high",
			version: 1,
		});
		const [url, request] = f.fetch.mock.calls[1]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_set_session_model");
		expect(request).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
		expect(request?.cache).toBeUndefined();
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: "gpt-6.2-sol",
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

	it("reads the conversation's speed and saves only a speed change", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, service_tier: "fast" }));
		expect(await f.control.read(session.sessionId)).toEqual({
			sessionId: session.sessionId,
			modelId: "gpt-6-astra",
			reasoningEffort: "low",
			serviceTier: "fast",
			version: 0,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, service_tier: "standard", version: 1 }));
		expect(await f.control.set(session.sessionId, { serviceTier: "standard" }, 0)).toMatchObject({
			serviceTier: "standard",
			version: 1,
		});
		expect(f.fetch.mock.calls[1]![0]).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_set_session_service_tier");
		expect(JSON.parse(f.fetch.mock.calls[1]![1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_service_tier: "standard",
			p_expected_version: 0,
		});
		// A save that did not come back at the chosen speed is not confirmed.
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, service_tier: "fast", version: 2 }));
		await expect(f.control.set(session.sessionId, { serviceTier: "standard" }, 1)).rejects.toThrow("Refresh");
		await expect(f.control.set(session.sessionId, { serviceTier: "priority" }, 2)).rejects.toThrow("Refresh");
		// The speed is saved on its own.
		await expect(
			f.control.set(session.sessionId, { serviceTier: "fast", reasoningEffort: "high" }, 2),
		).rejects.toThrow("Refresh");
		await expect(
			f.control.set(session.sessionId, { serviceTier: "fast", modelId: "gpt-6.2-sol" }, 2),
		).rejects.toThrow("Refresh");
		expect(f.fetch).toHaveBeenCalledTimes(3);
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
		f.fetch.mockResolvedValueOnce(Response.json({ ...older, model_id: "gpt-6.2-sol", version: 1 }));
		expect(await f.control.set(session.sessionId, { modelId: "gpt-6.2-sol" }, 0)).toMatchObject({
			modelId: "gpt-6.2-sol",
			version: 1,
		});
		expect(JSON.parse(f.fetch.mock.calls[1]![1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: "gpt-6.2-sol",
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
		await expect(
			f.control.set(session.sessionId, { modelId: "gpt-6.2-sol", reasoningEffort: "max" }, 5),
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
		{ service_tier: "" },
		{ service_tier: " fast" },
		{ service_tier: true },
		{ service_tier: null },
		{ service_tier: "x".repeat(65) },
		{ version: -1 },
		{ version: 0.5 },
		{ version: Number.MAX_SAFE_INTEGER + 1 },
		{ models: "gpt-6-astra" },
		{ models: [""] },
		{ models: [7] },
		{ models: ["x".repeat(257)] },
		{ models: Array.from({ length: 33 }, (_, index) => `model-${index}`) },
		{ efforts: null },
		{ efforts: ["low"] },
		{ efforts: { "gpt-6-astra": "low" } },
		{ efforts: { "gpt-6-astra": [""] } },
		{ efforts: { "gpt-6-astra": [7] } },
		{ efforts: { "gpt-6-astra": ["x".repeat(65)] } },
		{ efforts: { ["x".repeat(257)]: ["low"] } },
		{ efforts: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`model-${index}`, ["low"]])) },
	])("rejects an invalid response %j", async (invalid) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, ...invalid }));
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Invalid conversation model response");
	});

	it.each([
		{ model_id: "gpt-6.2-sol", reasoning_effort: "medium", version: 0 },
		{ model_id: "gpt-6-astra", reasoning_effort: "medium", version: 1 },
		{ model_id: "gpt-6.2-sol", reasoning_effort: "medium", version: 2 },
		{ model_id: "gpt-6.2-sol", reasoning_effort: "low", version: 1 },
		{ model_id: "gpt-6.2-sol", reasoning_effort: undefined, version: 1 },
	])("does not confirm a different model, effort or revision after saving %j", async (invalid) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, ...invalid }));
		await expect(
			f.control.set(session.sessionId, { modelId: "gpt-6.2-sol", reasoningEffort: "medium" }, 0),
		).rejects.toThrow("Refresh");
	});

	it("reads the models the cloud offers this member, keeping ones it does not list", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, models: ["gpt-6-astra", "claude-fable-5-2", "gpt-6-astra", "gpt-7-terra"] }),
		);
		expect(await f.control.read(session.sessionId)).toMatchObject({
			models: ["gpt-6-astra", "claude-fable-5-2", "gpt-7-terra"],
		});
	});

	it.each([
		{ modelId: "gpt-6-sol" },
		{ modelId: "claude-opus-5-5", reasoningEffort: "ultra" },
		{ modelId: "gpt-6-astra", reasoningEffort: "max" },
	])("refuses a selection the client does not offer %j", async (selection) => {
		const f = setup();
		await expect(f.control.set(session.sessionId, selection, 0)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("reads the efforts the cloud offers with each model and saves extra high on GPT", async () => {
		const f = setup();
		const efforts = {
			"gpt-6-astra": ["low", "medium", "high", "xhigh"],
			"gpt-6.2-sol": ["low", "medium", "high", "xhigh", "xhigh"],
		};
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, models: ["gpt-6-astra", "gpt-6.2-sol"], efforts }));
		expect(await f.control.read(session.sessionId)).toMatchObject({
			efforts: {
				"gpt-6-astra": ["low", "medium", "high", "xhigh"],
				"gpt-6.2-sol": ["low", "medium", "high", "xhigh"],
			},
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "gpt-6.2-sol", reasoning_effort: "xhigh", efforts, version: 1 }),
		);
		expect(
			await f.control.set(session.sessionId, { modelId: "gpt-6.2-sol", reasoningEffort: "xhigh" }, 0),
		).toMatchObject({ modelId: "gpt-6.2-sol", reasoningEffort: "xhigh" });
		expect(JSON.parse(f.fetch.mock.calls[1]![1]?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_model_id: "gpt-6.2-sol",
			p_expected_version: 0,
			p_reasoning_effort: "xhigh",
		});
	});

	it("saves a Claude model with an effort only Claude has", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "claude-opus-5-5", reasoning_effort: "max", version: 1 }),
		);
		expect(
			await f.control.set(session.sessionId, { modelId: "claude-opus-5-5", reasoningEffort: "max" }, 0),
		).toMatchObject({ modelId: "claude-opus-5-5", reasoningEffort: "max" });
	});

	it("reads and saves Gemini 4 Neon with cap status and rejects max effort", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				...model,
				model_id: "gemini-4-neon",
				reasoning_effort: "xhigh",
				models: ["gpt-6.2-sol", "gemini-4-neon"],
				gemini_cap_reached: true,
				version: 1,
			}),
		);
		expect(await f.control.read(session.sessionId)).toMatchObject({
			modelId: "gemini-4-neon",
			reasoningEffort: "xhigh",
			models: ["gpt-6.2-sol", "gemini-4-neon"],
			geminiCapReached: true,
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...model, model_id: "gemini-4-neon", reasoning_effort: "high", version: 2 }),
		);
		expect(
			await f.control.set(session.sessionId, { modelId: "gemini-4-neon", reasoningEffort: "high" }, 1),
		).toMatchObject({ modelId: "gemini-4-neon", reasoningEffort: "high", version: 2 });
		await expect(
			f.control.set(session.sessionId, { modelId: "gemini-4-neon", reasoningEffort: "max" }, 2),
		).rejects.toThrow("Refresh");
		f.fetch.mockResolvedValueOnce(Response.json({ ...model, gemini_cap_reached: "yes" }));
		await expect(f.control.read(session.sessionId)).rejects.toThrow("Invalid conversation model response");
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
		const sol = { modelId: "gpt-6.2-sol" };
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
