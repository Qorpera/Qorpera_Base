import type { RequestSponsoredSessionTurnInput } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebNativeSubscription } from "../src/cloud/native-subscription.ts";
import { deferred, fixture, id, profileA, session, settle, timestamp, userA, userB } from "./fixtures.ts";

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
			turn_request_id: id(90),
			input_id: id(91),
			status: "queued",
			sponsor_mode: "member_connection",
		}),
	);
	vi.stubGlobal("fetch", fetch);
	const input: RequestSponsoredSessionTurnInput = {
		sessionId: session.sessionId,
		clientInputId: id(91),
		clientRequestId: id(90),
		body: { schema: "qorpera.session-prompt/v1", text: "Inspect the company", images: [] },
		sponsorMode: "member_connection",
		sponsorBindingId: id(92),
		sponsorVersion: 3,
		computeIdentityId: id(93),
		workerClass: "managed_sandbox",
	};
	return {
		...f,
		company,
		view,
		current,
		fetch,
		input,
		client: createWebNativeSubscription(f.cloud, profileA.profileId, userA.id, company.signal, current),
	};
}
describe("native subscription browser transport", () => {
	it("submits the SDK's exact sponsored request without dispatching a local runtime", async () => {
		const f = setup();
		expect(await f.client.requestSessionTurn(f.input, f.view.signal)).toEqual({
			turnRequestId: id(90),
			inputId: id(91),
			status: "queued",
			sponsorMode: "member_connection",
		});
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_request_session_turn_v2");
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_client_input_id: id(91),
			p_client_request_id: id(90),
			p_body: f.input.body,
			p_sponsor_mode: "member_connection",
			p_sponsor_binding_id: id(92),
			p_sponsor_version: 3,
			p_requested_sponsor_user_id: null,
			p_compute_identity_id: id(93),
			p_logical_computer_id: null,
			p_worker_class: "managed_sandbox",
			p_required_capability: "agent_turn",
			p_job_type: "agent_turn",
			p_publication_mode: "automatic",
			p_review_policy_key: null,
			p_reviewer_staff_ids: [],
		});
		expect(f.current).toHaveBeenCalledWith(session.sessionId);
	});
	it("binds profile operations despite an extra caller profile and retains explicit consent identity", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ binding_id: id(92), version: 4 }));
		const consent = {
			profileId: id(999),
			clientBindingId: id(92),
			providerConnectionId: id(94),
			providerConnectionVersion: 2,
			allowAutonomous: false,
		};
		expect(await f.client.createMemberSponsor(consent)).toEqual({ bindingId: id(92), version: 4 });
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_client_binding_id: id(92),
			p_provider_connection_id: id(94),
			p_provider_connection_version: 2,
			p_allow_autonomous: false,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ connection_id: id(94), status: "revoked" }));
		expect(await f.client.revokeConnection(consent)).toEqual({ connectionId: id(94), status: "revoked" });
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_connection_id: id(94),
		});
	});
	it("uses SDK connection and provenance parsing with bounded scoped requests", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ compute_identity: null, connections: [] }));
		expect(await f.client.listConnections()).toEqual({ connections: [] });
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({ p_profile_id: profileA.profileId });
		f.fetch.mockResolvedValueOnce(
			Response.json([
				{
					turn_request_id: id(90),
					input_id: id(91),
					requested_by_user_id: userA.id,
					sponsor_mode: "member_connection",
					worker_class: "managed_sandbox",
					status: "materialized",
					run_id: id(95),
					run_status: "leased",
					created_at: timestamp,
				},
			]),
		);
		expect(await f.client.listSessionTurnProvenance(session.sessionId)).toMatchObject([
			{ turnRequestId: id(90), inputId: id(91), runId: id(95), runStatus: "leased" },
		]);
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_limit: 100,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ compute_identity: null, connections: [{}] }));
		await expect(f.client.listConnections()).rejects.toThrow("Native subscription control returned invalid");
	});
	it("refuses another account's refreshed token before dispatch", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.client.requestSessionTurn(f.input)).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it.each(["company", "view"] as const)("aborts %s during authentication without dispatch", async (lifetime) => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.requestSessionTurn(f.input, f.view.signal)).rejects.toThrow();
		await settle();
		f[lifetime].abort();
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("checks route authority after authentication and rejects a late response", async () => {
		const f = setup();
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Route changed");
			});
		await expect(f.client.requestSessionTurn(f.input)).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
		f.current.mockImplementation(() => {});
		const response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const reading = f.client.listConnections();
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Company changed");
		});
		response.resolve(Response.json({ connections: [] }));
		await expect(reading).rejects.toThrow("Refresh its status");
	});
	it("snapshots request arguments before authentication yields", async () => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const body = { text: "Original" };
		const submitting = f.client.requestSessionTurn({ ...f.input, body });
		body.text = "Changed";
		token.resolve(original);
		await submitting;
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string).p_body).toEqual({ text: "Original" });
	});
	it("does not retry an uncertain mutation or expose server error content", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("sensitive internal failure", { status: 500 }));
		await expect(f.client.requestSessionTurn(f.input)).rejects.toThrow(
			"Cloud execution could not be confirmed. Refresh its status before trying again.",
		);
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each([401, 403])("preserves permission status %s without reflecting server content", async (status) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("private server detail", { status }));
		await expect(f.client.requestSessionTurn(f.input)).rejects.toMatchObject({
			status,
			code: "42501",
			message: "You do not have permission to manage this cloud execution.",
		});
	});
	it("bounds authentication time and discards a later token", async () => {
		vi.useFakeTimers();
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.requestSessionTurn(f.input)).rejects.toThrow("Refresh its status");
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("aborts an in-flight request when the company closes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const rejected = expect(f.client.listConnections()).rejects.toThrow();
		await settle();
		f.company.abort();
		expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
		await rejected;
		response.resolve(Response.json({ connections: [] }));
		await settle();
	});
});
