import type { RequestSponsoredSessionTurnInput } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRpcError } from "../src/cloud/client.ts";
import {
	createWebNativeSubscription,
	PlanSwitchBusyError,
	type WebNativeProviderLoginInput,
} from "../src/cloud/native-subscription.ts";
import { deferred, fixture, id, profileA, session, settle, timestamp, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function setup(loginBase?: string) {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController(),
		current = vi.fn();
	if (loginBase) {
		f.cloud.config.nativeProviderLoginUrl = loginBase;
		f.cloud.config.publishableKey = "sb_publishable_fixture1234";
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	}
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
	it("selects the durable conversation account with scoped authenticated transport", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json(id(94)));
		expect(await f.client.selectSessionAccount!(session.sessionId, f.view.signal)).toBe(id(94));
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_select_member_session_account");
		expect(JSON.parse(String(request?.body))).toEqual({
			p_profile_id: profileA.profileId,
			p_session_id: session.sessionId,
		});
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(f.current).toHaveBeenCalledWith(session.sessionId);
		f.fetch.mockResolvedValueOnce(Response.json(null));
		expect(await f.client.selectSessionAccount!(session.sessionId)).toBeUndefined();
	});
	it("sends the member's own pick of a conversation's login and checks the answer", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json(id(95)));
		expect(await f.client.chooseSessionAccount!(session.sessionId, id(95), f.view.signal)).toBe(id(95));
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_choose_member_session_account");
		expect(JSON.parse(String(request?.body))).toEqual({
			p_profile_id: profileA.profileId,
			p_session_id: session.sessionId,
			p_connection_id: id(95),
		});
		expect(f.current).toHaveBeenCalledWith(session.sessionId);
		f.fetch.mockResolvedValueOnce(Response.json(id(96)));
		await expect(f.client.chooseSessionAccount!(session.sessionId, id(95))).rejects.toThrow(
			"Invalid conversation account response",
		);
		await expect(f.client.chooseSessionAccount!(session.sessionId, "invalid")).rejects.toThrow(
			"Invalid conversation account request",
		);
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
	it("rejects malformed account selections and does not send after an account switch", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json({ access_token: "private" }));
		await expect(f.client.selectSessionAccount!(session.sessionId)).rejects.toThrow(
			"Invalid conversation account response",
		);
		await expect(f.client.selectSessionAccount!("invalid")).rejects.toThrow("Invalid conversation account request");
		expect(f.fetch).toHaveBeenCalledTimes(1);
		f.auth(userB);
		await expect(f.client.selectSessionAccount!(session.sessionId)).rejects.toThrow("Refresh its status");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("discards a late durable selection when its conversation changes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const selected = f.client.selectSessionAccount!(session.sessionId, f.view.signal);
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Conversation changed");
		});
		response.resolve(Response.json(id(94)));
		await expect(selected).rejects.toThrow("Refresh its status");
	});
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
	it("binds profile operations despite an extra caller profile, recording unattended consent first", async () => {
		const f = setup();
		// Unattended use is the default: the owner's consent is recorded, then the consented version is bound.
		const rpc = vi.spyOn(f.cloud, "rpc").mockResolvedValueOnce({
			schema: "qorpera.provider-connection-consent/v1",
			connection_id: id(94),
			version: 3,
			allow_autonomous: true,
			changed: true,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ binding_id: id(92), version: 4 }));
		const consent = {
			profileId: id(999),
			clientBindingId: id(92),
			providerConnectionId: id(94),
			providerConnectionVersion: 2,
			allowAutonomous: false,
		};
		expect(await f.client.createMemberSponsor(consent)).toEqual({ bindingId: id(92), version: 4 });
		expect(rpc).toHaveBeenCalledWith("qorpera_consent_provider_connection_autonomous", {
			p_profile_id: profileA.profileId,
			p_connection_id: id(94),
			p_allow_autonomous: true,
		});
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_client_binding_id: id(92),
			p_provider_connection_id: id(94),
			p_provider_connection_version: 3,
			p_allow_autonomous: true,
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

function loginSetup(existing = true) {
	const f = setup("https://fixture.invalid/functions/v1/native-provider-login/");
	const input: WebNativeProviderLoginInput = {
		provider: "openai",
		displayName: "My model account",
		clientIdentityId: id(101),
		clientLoginId: id(102),
		clientConnectionId: id(103),
	};
	const responses = {
		identity: {
			compute_identity_id: id(104),
			ownership_kind: "member",
			owner_user_id: userA.id,
			owner_scope_key: null,
			display_name: "My model account",
			template_key: "qorpera-member-linux",
			template_version: "v1",
			capabilities: ["agent_turn", "company_substrate"],
			policy: {},
			status: "active",
			created_at: timestamp,
			updated_at: timestamp,
		},
		authorization: {
			login_id: id(105),
			compute_identity_id: id(104),
			compute_identity_ownership_kind: "member",
			compute_identity_owner_user_id: userA.id,
			compute_identity_owner_scope_key: null,
			provider: "openai",
			native_harness: "codex-cli",
			expires_at: new Date(Date.now() + 900000).toISOString(),
		},
		prompt: {
			schema: "qorpera.native-provider-login-result/v1",
			login_id: id(105),
			status: "awaiting_member",
			interaction_url: "https://auth.openai.com/device",
			user_code: "ABCD-EFGH",
		},
	};
	f.fetch.mockImplementation(async (url) => {
		if (String(url).endsWith("qorpera_list_member_native_execution_connections"))
			return Response.json({ compute_identity: existing ? responses.identity : null, connections: [] });
		if (String(url).endsWith("qorpera_upsert_member_compute_identity")) return Response.json(responses.identity);
		if (String(url).endsWith("qorpera_begin_native_provider_login")) return Response.json(responses.authorization);
		if (String(url).endsWith("/native-provider-login/login")) return Response.json(responses.prompt);
		throw new Error("Unexpected request");
	});
	return { ...f, input, responses };
}

describe("Continue with ChatGPT (offered only while the company may use plan logins)", () => {
	const authorize = "https://auth.openai.com/oauth/authorize?state=fixture";
	function planSetup() {
		const f = loginSetup();
		const rpc = vi.spyOn(f.cloud, "rpc").mockImplementation(async (name: string) => {
			if (name === "qorpera_begin_chatgpt_plan_sign_in")
				return { ...f.responses.authorization, model_login_kind: "chatgpt_plan", status: "pending" };
			throw new Error(`Unexpected ${name}`);
		});
		f.responses.prompt.interaction_url = authorize;
		(f.responses.prompt as Record<string, unknown>).user_code = null;
		return { ...f, rpc };
	}
	it("asks the company's switches, and reads a deployment without them as off", async () => {
		const f = setup();
		const rpc = vi
			.spyOn(f.cloud, "rpc")
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(
				new CloudRpcError("qorpera_chatgpt_plan_available", { message: "missing", code: "PGRST202" }, 404),
			);
		expect(await f.client.chatGptPlanAvailable!()).toBe(true);
		expect(rpc).toHaveBeenCalledWith("qorpera_chatgpt_plan_available", { p_profile_id: profileA.profileId });
		expect(await f.client.chatGptPlanAvailable!()).toBe(false);
		expect(await f.client.chatGptPlanAvailable!()).toBe(false);
	});
	it("begins a plan sign-in for the member's own identity and answers OpenAI's address with what this tab keeps", async () => {
		const f = planSetup();
		const { url, signIn } = await f.client.beginChatGptPlanSignIn!("My model account");
		expect(url).toBe(authorize);
		const begin = f.rpc.mock.calls.find(([name]) => name === "qorpera_begin_chatgpt_plan_sign_in")![1] as Record<
			string,
			unknown
		>;
		expect(begin).toMatchObject({ p_profile_id: profileA.profileId, p_compute_identity_id: id(104) });
		const [loginUrl, request] = f.fetch.mock.calls.find(([address]) => String(address).endsWith("/login"))!;
		expect(loginUrl).toBe("https://fixture.invalid/functions/v1/native-provider-login/login");
		// The capability is the only credential: no member token, no apikey, no cookies.
		expect([...new Headers(request!.headers).keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
		expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
		const body = JSON.parse(request!.body as string);
		expect(body).toMatchObject({ login_id: id(105), client_connection_id: begin.p_client_connection_id });
		expect(new Headers(request!.headers).get("authorization")).toBe(`Bearer ${body.login_capability}`);
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.login_capability)),
		);
		expect(begin.p_capability_sha256).toBe(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
		expect(signIn).toMatchObject({
			companyId: profileA.profileId,
			memberId: userA.id,
			loginId: id(105),
			clientConnectionId: begin.p_client_connection_id,
			capability: body.login_capability,
			expiresAt: f.responses.authorization.expires_at,
		});
	});
	it("refuses a begin answer that is not this member's plan sign-in, before going to the vault", async () => {
		for (const wrong of [
			{ model_login_kind: "codex" },
			{ compute_identity_owner_user_id: userB.id },
			{ compute_identity_id: id(9) },
			{ login_id: "not-a-uuid" },
			{ expires_at: "soon" },
		]) {
			const f = planSetup();
			f.rpc.mockResolvedValueOnce({
				...f.responses.authorization,
				model_login_kind: "chatgpt_plan",
				status: "pending",
				...wrong,
			});
			await expect(f.client.beginChatGptPlanSignIn!("My model account")).rejects.toThrow("authority does not match");
			expect(f.fetch.mock.calls.some(([address]) => String(address).endsWith("/login"))).toBe(false);
		}
	});
	it("refuses an address that is not OpenAI's, and says why a begin was refused", async () => {
		let f = planSetup();
		f.responses.prompt.interaction_url = "https://example.com/authorize";
		await expect(f.client.beginChatGptPlanSignIn!("My model account")).rejects.toThrow("OpenAI's address");
		for (const [message, reason] of [
			["Disconnect your other ChatGPT plan first", "other_plan"],
			["ChatGPT plan sign-in is switched off", "unavailable"],
		] as const) {
			f = planSetup();
			f.rpc.mockRejectedValueOnce(
				new CloudRpcError("qorpera_begin_chatgpt_plan_sign_in", { message, code: "55000" }, 400),
			);
			await expect(f.client.beginChatGptPlanSignIn!("My model account")).rejects.toMatchObject({ reason });
		}
	});
	const signIn = {
		companyId: profileA.profileId,
		memberId: userA.id,
		loginId: id(105),
		clientConnectionId: id(103),
		capability: "c".repeat(43),
		expiresAt: timestamp,
		startedAt: Date.now(),
		returnRoute: `#/c/${profileA.profileId}`,
	};
	it("confirms with the tab's capability and the one-time confirmation id, and says why a confirm failed", async () => {
		const f = setup("https://fixture.invalid/functions/v1/native-provider-login/");
		const confirmation = "d".repeat(43);
		f.fetch.mockResolvedValueOnce(
			Response.json({ schema: "qorpera.native-provider-login-result/v1", login_id: id(105), status: "completed" }),
		);
		await f.client.finishChatGptPlanSignIn!({ outcome: "confirm", confirmation, signIn });
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/functions/v1/native-provider-login/chatgpt-plan-confirm");
		expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
		// Only the two headers the Edge function allows: no apikey, no member token.
		expect([...new Headers(request!.headers).keys()].sort()).toEqual(["authorization", "content-type"]);
		expect(new Headers(request!.headers).get("authorization")).toBe(`Bearer ${"c".repeat(43)}`);
		expect(JSON.parse(request!.body as string)).toEqual({
			schema: "qorpera.chatgpt-plan-confirm/v1",
			login_id: id(105),
			confirmation,
		});
		f.fetch.mockResolvedValueOnce(
			Response.json({ schema: "qorpera.chatgpt-plan-confirm-failed/v1", reason: "expired" }, { status: 403 }),
		);
		await expect(
			f.client.finishChatGptPlanSignIn!({ outcome: "confirm", confirmation, signIn }),
		).rejects.toMatchObject({
			reason: "expired",
		});
		f.fetch.mockResolvedValueOnce(Response.json({ error: "Native provider login is unavailable" }, { status: 503 }));
		await expect(
			f.client.finishChatGptPlanSignIn!({ outcome: "confirm", confirmation, signIn }),
		).rejects.toMatchObject({
			reason: "provider_error",
		});
		await expect(
			f.client.finishChatGptPlanSignIn!({ outcome: "failed", reason: "declined", signIn }),
		).rejects.toMatchObject({ reason: "declined" });
		await expect(
			f.client.finishChatGptPlanSignIn!({
				outcome: "confirm",
				confirmation,
				signIn: { ...signIn, companyId: id(9) },
			}),
		).rejects.toThrow("cannot be finished here");
		expect(f.fetch).toHaveBeenCalledTimes(3);
	});
	it("counts only a completed answer for this sign-in, and a reason only from the failed answer", async () => {
		const f = setup("https://fixture.invalid/functions/v1/native-provider-login/");
		const confirmation = "d".repeat(43);
		for (const [answer, status] of [
			[{ login_id: id(9), status: "completed" }, 200],
			[{ login_id: id(105) }, 200],
			[{ login_id: id(105), status: "completed" }, 202],
			[{ reason: "expired" }, 403],
		] as const) {
			f.fetch.mockResolvedValueOnce(Response.json(answer, { status }));
			await expect(
				f.client.finishChatGptPlanSignIn!({ outcome: "confirm", confirmation, signIn }),
			).rejects.toMatchObject({ reason: "provider_error" });
		}
	});
	it("gives up on a confirm after 45 seconds", async () => {
		const f = setup("https://fixture.invalid/functions/v1/native-provider-login/");
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		f.fetch.mockImplementationOnce(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) =>
					init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
				),
		);
		const finishing = f.client.finishChatGptPlanSignIn!({ outcome: "confirm", confirmation: "d".repeat(43), signIn });
		expect(timeout).toHaveBeenCalledExactlyOnceWith(45_000);
		deadline.abort(new DOMException("The confirm took too long.", "TimeoutError"));
		await expect(finishing).rejects.toThrow("took too long");
	});
});

describe("ChatGPT plan logins (switched off until a company has one)", () => {
	const row = (n: number, extra: Record<string, unknown>) => ({
		connection_id: id(n),
		client_connection_id: id(100 + n),
		connection_version: 2,
		provider: "openai",
		native_harness: "codex-cli",
		authorization_state: "active",
		max_native_concurrency: 1,
		billing_source: "personal_subscription",
		consent_version: "1",
		consented_at: timestamp,
		connection_status: "active",
		sponsor_binding_id: id(200 + n),
		sponsor_version: 1,
		policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
		...extra,
	});
	it("reads each login's kind, consent and card from the same answer, in one request", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				compute_identity: null,
				connections: [
					row(81, { login_kind: "chatgpt_plan", allow_autonomous: false, routine_offer_shown_at: timestamp }),
					row(82, { login_kind: "codex", allow_autonomous: true, routine_offer_shown_at: null }),
					row(83, {}),
					row(84, { login_kind: "something", allow_autonomous: "yes", routine_offer_shown_at: "soon" }),
					// Another version of 81: each version reads its own consent.
					row(81, { connection_version: 3, login_kind: "chatgpt_plan", allow_autonomous: true }),
				],
			}),
		);
		const listed = await f.client.listConnections();
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(
			listed.connections.map(({ loginKind, allowAutonomous, routineOfferShownAt }) => ({
				loginKind,
				allowAutonomous,
				routineOfferShownAt,
			})),
		).toEqual([
			{ loginKind: "chatgpt_plan", allowAutonomous: false, routineOfferShownAt: timestamp },
			{ loginKind: "codex", allowAutonomous: true, routineOfferShownAt: undefined },
			// A node login, and fields the web cannot read, read as absent.
			{ loginKind: undefined, allowAutonomous: undefined, routineOfferShownAt: undefined },
			{ loginKind: undefined, allowAutonomous: undefined, routineOfferShownAt: undefined },
			{ loginKind: "chatgpt_plan", allowAutonomous: true, routineOfferShownAt: undefined },
		]);
		expect(listed.connections[0]).toMatchObject({ connectionId: id(81), sponsorBindingId: id(281) });
	});
	it("reads each login's recent turns from the same answer (20260930559000)", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				compute_identity: null,
				connections: [
					row(81, { recent_turns: { refused: true, completed: false } }),
					row(82, { recent_turns: { refused: false, completed: true } }),
					row(83, {}),
					row(84, { recent_turns: { refused: "yes", completed: true } }),
					row(85, { recent_turns: null }),
				],
			}),
		);
		const listed = await f.client.listConnections();
		expect(listed.connections.map(({ recentTurns }) => recentTurns)).toEqual([
			{ refused: true, completed: false },
			{ refused: false, completed: true },
			// An older cloud, and fields the web cannot read, read as absent.
			undefined,
			undefined,
			undefined,
		]);
	});
	it("binds a plan for the member's own messages without consenting it", async () => {
		const f = setup();
		const rpc = vi.spyOn(f.cloud, "rpc");
		f.fetch.mockResolvedValueOnce(Response.json({ binding_id: id(92), version: 1 }));
		expect(
			await f.client.createMemberSponsor({
				providerConnectionId: id(94),
				providerConnectionVersion: 2,
				allowAutonomous: false,
				planLogin: true,
			}),
		).toEqual({ bindingId: id(92), version: 1 });
		expect(rpc).not.toHaveBeenCalled();
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
			p_profile_id: profileA.profileId,
			p_provider_connection_id: id(94),
			p_provider_connection_version: 2,
			p_allow_autonomous: false,
		});
	});
	it("records the first-routine card once and returns the first showing", async () => {
		const f = setup();
		const rpc = vi
			.spyOn(f.cloud, "rpc")
			.mockResolvedValueOnce({ connection_id: id(94), shown_at: timestamp })
			.mockResolvedValueOnce({ connection_id: id(95), shown_at: timestamp });
		expect(await f.client.recordRoutineOffer!(id(94))).toBe(timestamp);
		expect(rpc).toHaveBeenCalledWith("qorpera_record_chatgpt_plan_routine_offer", {
			p_profile_id: profileA.profileId,
			p_connection_id: id(94),
		});
		await expect(f.client.recordRoutineOffer!(id(94))).rejects.toThrow("Invalid cloud response");
	});
	it("turns work while away on and off through the member's own switch, binding each new version", async () => {
		const f = setup();
		const rpc = vi
			.spyOn(f.cloud, "rpc")
			.mockResolvedValueOnce({ connection_id: id(94), version: 3, allow_autonomous: true, changed: true })
			.mockResolvedValueOnce({ connection_id: id(94), version: 4, allow_autonomous: false, changed: true });
		f.fetch
			.mockResolvedValueOnce(Response.json({ binding_id: id(92), version: 2 }))
			.mockResolvedValueOnce(Response.json({ binding_id: id(93), version: 1 }));
		await f.client.setWorkWhileAway!(id(94), true);
		expect(rpc).toHaveBeenNthCalledWith(1, "qorpera_set_chatgpt_plan_work_while_away", {
			p_profile_id: profileA.profileId,
			p_connection_id: id(94),
			p_on: true,
		});
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
			p_provider_connection_id: id(94),
			p_provider_connection_version: 3,
			p_allow_autonomous: true,
		});
		await f.client.setWorkWhileAway!(id(94), false);
		expect(rpc).toHaveBeenNthCalledWith(2, "qorpera_set_chatgpt_plan_work_while_away", {
			p_profile_id: profileA.profileId,
			p_connection_id: id(94),
			p_on: false,
		});
		// Turned off, the new version is bound at once for the member's own messages.
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
			p_provider_connection_id: id(94),
			p_provider_connection_version: 4,
			p_allow_autonomous: false,
		});
		// An answer for another connection or the other choice is refused.
		rpc.mockResolvedValueOnce({ connection_id: id(94), version: 5, allow_autonomous: true });
		await expect(f.client.setWorkWhileAway!(id(94), false)).rejects.toThrow("Invalid cloud response");
		// A switch that waited too long for a lock (55P03) reads as busy, and binds nothing; other errors stay.
		const binds = f.fetch.mock.calls.length;
		rpc.mockRejectedValueOnce(
			new CloudRpcError(
				"qorpera_set_chatgpt_plan_work_while_away",
				{ message: "Busy right now. Try again in a moment.", code: "55P03" },
				500,
			),
		);
		await expect(f.client.setWorkWhileAway!(id(94), true)).rejects.toBeInstanceOf(PlanSwitchBusyError);
		for (const [code, status] of [
			["42501", 403],
			// The consent's own refusal also arrives as a 500: only 55P03 is busy.
			["55000", 500],
		] as const) {
			rpc.mockRejectedValueOnce(
				new CloudRpcError("qorpera_set_chatgpt_plan_work_while_away", { message: "refused", code }, status),
			);
			await expect(f.client.setWorkWhileAway!(id(94), true)).rejects.not.toBeInstanceOf(PlanSwitchBusyError);
		}
		expect(f.fetch.mock.calls.length).toBe(binds);
	});
});

describe("native provider onboarding browser adapter", () => {
	it("is unavailable without an explicitly configured gateway and performs no cloud mutation", async () => {
		const f = setup();
		expect(f.client.onboardingAvailable).toBe(false);
		await expect(
			f.client.beginProviderLogin({
				provider: "openai",
				displayName: "Model",
				clientIdentityId: id(101),
				clientLoginId: id(102),
				clientConnectionId: id(103),
			}),
		).rejects.toThrow("Refresh connections");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("creates missing member identity through SDK, admits login and returns only safe interaction data", async () => {
		const f = loginSetup(false);
		expect(f.client.onboardingAvailable).toBe(true);
		const result = await f.client.beginProviderLogin(f.input, f.view.signal);
		expect(result).toEqual({
			loginId: id(105),
			clientConnectionId: id(103),
			status: "awaiting_member",
			interactionUrl: "https://auth.openai.com/device",
			userCode: "ABCD-EFGH",
			expiresAt: f.responses.authorization.expires_at,
		});
		expect(f.fetch).toHaveBeenCalledTimes(4);
		const create = JSON.parse(f.fetch.mock.calls[1]![1]!.body as string);
		expect(create).toEqual({
			p_profile_id: profileA.profileId,
			p_client_identity_id: id(101),
			p_display_name: "My model account",
			p_template_key: "qorpera-member-linux",
			p_template_version: "v1",
			p_capabilities: ["agent_turn", "company_substrate"],
			p_policy: { credentialExport: false, operatorBlindnessClaimed: false },
		});
		const admission = JSON.parse(f.fetch.mock.calls[2]![1]!.body as string);
		expect(admission).toMatchObject({
			p_profile_id: profileA.profileId,
			p_compute_identity_id: id(104),
			p_client_login_id: id(102),
			p_client_connection_id: id(103),
			p_provider: "openai",
			p_native_harness: "codex-cli",
			p_login_seconds: 900,
		});
		const [url, request] = f.fetch.mock.calls[3]!;
		expect(url).toBe("https://fixture.invalid/functions/v1/native-provider-login/login");
		expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
		const body = JSON.parse(request!.body as string),
			headers = new Headers(request!.headers);
		expect(body).toMatchObject({
			schema: "qorpera.native-provider-login/v1",
			login_id: id(105),
			client_connection_id: id(103),
			compute_identity_id: id(104),
			compute_identity_ownership_kind: "member",
			compute_identity_owner_user_id: userA.id,
			provider: "openai",
			native_harness: "codex-cli",
		});
		expect(body.login_capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(headers.get("authorization")).toBe(`Bearer ${body.login_capability}`);
		expect(headers.has("apikey")).toBe(false);
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.login_capability)),
		);
		expect(admission.p_capability_sha256).toBe(
			Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		);
		expect(JSON.stringify(result)).not.toContain(body.login_capability);
		expect(JSON.stringify(request)).not.toContain("fixture-token");
	});
	it("reuses the observed identity, snapshots input and uses the SDK's Anthropic harness mapping", async () => {
		const f = loginSetup();
		f.input.provider = "anthropic";
		f.responses.authorization.provider = "anthropic";
		f.responses.authorization.native_harness = "claude-code";
		const pending = f.client.beginProviderLogin(f.input);
		f.input.provider = "openai";
		f.input.clientLoginId = id(999);
		await pending;
		expect(f.fetch).toHaveBeenCalledTimes(3);
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
			p_provider: "anthropic",
			p_native_harness: "claude-code",
			p_client_login_id: id(102),
		});
	});
	it("rechecks preparation after one second using the same admitted capability", async () => {
		vi.useFakeTimers();
		const f = loginSetup();
		const preparing = deferred<Response>();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockResolvedValueOnce(Response.json(f.responses.authorization))
			.mockReturnValueOnce(preparing.promise);
		const pending = f.client.beginProviderLogin(f.input);
		await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
		preparing.resolve(Response.json({ schema: f.responses.prompt.schema, login_id: id(105), status: "preparing" }));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(999);
		expect(f.fetch).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toMatchObject({ status: "awaiting_member", userCode: "ABCD-EFGH" });
		expect(f.fetch).toHaveBeenCalledTimes(4);
		expect(f.fetch.mock.calls[3]![1]!.body).toBe(f.fetch.mock.calls[2]![1]!.body);
	});
	it("cancels the preparation delay without sending another request", async () => {
		vi.useFakeTimers();
		const f = loginSetup();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockResolvedValueOnce(Response.json(f.responses.authorization))
			.mockResolvedValueOnce(
				Response.json({ schema: f.responses.prompt.schema, login_id: id(105), status: "preparing" }),
			);
		const rejected = expect(f.client.beginProviderLogin(f.input, f.view.signal)).rejects.toThrow(
			"Refresh connections",
		);
		await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
		await settle();
		f.view.abort();
		await rejected;
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.fetch).toHaveBeenCalledTimes(3);
	});
	it.each(["owner", "disabled"] as const)("rejects %s identity mismatch before login admission", async (change) => {
		const f = loginSetup();
		if (change === "owner") f.responses.identity.owner_user_id = userB.id;
		else f.responses.identity.status = "disabled";
		await expect(f.client.beginProviderLogin(f.input)).rejects.toThrow("Refresh connections");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["owner", "identity", "provider", "harness", "expired"] as const)(
		"rejects substituted %s authorization before bridge dispatch",
		async (change) => {
			const f = loginSetup();
			if (change === "owner") f.responses.authorization.compute_identity_owner_user_id = userB.id;
			if (change === "identity") f.responses.authorization.compute_identity_id = id(999);
			if (change === "provider") f.responses.authorization.provider = "anthropic";
			if (change === "harness") f.responses.authorization.native_harness = "claude-code";
			if (change === "expired") f.responses.authorization.expires_at = new Date(Date.now() - 1000).toISOString();
			await expect(f.client.beginProviderLogin(f.input)).rejects.toThrow("Refresh connections");
			expect(f.fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("refuses an account switch after admission before sending its capability", async () => {
		const f = loginSetup();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockImplementationOnce(async () => {
				f.auth(userB);
				return Response.json(f.responses.authorization);
			});
		await expect(f.client.beginProviderLogin(f.input)).rejects.toThrow("Refresh connections");
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
	it.each(["company", "view"] as const)("aborts %s during admission without contacting the bridge", async (scope) => {
		const f = loginSetup(),
			response = deferred<Response>(),
			admitted = deferred<void>();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockImplementationOnce(() => {
				admitted.resolve();
				return response.promise;
			});
		const rejected = expect(f.client.beginProviderLogin(f.input, f.view.signal)).rejects.toThrow(
			"Refresh connections",
		);
		await admitted.promise;
		f[scope].abort();
		await rejected;
		response.resolve(Response.json(f.responses.authorization));
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
	it("discards SDK interaction data after a late account/company change", async () => {
		const f = loginSetup(),
			response = deferred<Response>(),
			reached = deferred<void>();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockResolvedValueOnce(Response.json(f.responses.authorization))
			.mockImplementationOnce(() => {
				reached.resolve();
				return response.promise;
			});
		const pending = f.client.beginProviderLogin(f.input);
		await reached.promise;
		f.current.mockImplementation(() => {
			throw new Error("Company changed");
		});
		response.resolve(Response.json(f.responses.prompt));
		await expect(pending).rejects.toThrow("Refresh connections");
	});
	it.each(["identity", "admission", "bridge"] as const)("never retries an uncertain %s mutation", async (stage) => {
		const f = loginSetup(stage !== "identity");
		f.fetch.mockResolvedValueOnce(
			Response.json({ compute_identity: stage === "identity" ? null : f.responses.identity, connections: [] }),
		);
		if (stage === "bridge") f.fetch.mockResolvedValueOnce(Response.json(f.responses.authorization));
		f.fetch.mockRejectedValueOnce(new Error("private internal detail"));
		await expect(f.client.beginProviderLogin(f.input)).rejects.toThrow(
			"Provider login could not be confirmed. Refresh connections before starting a new sign-in attempt.",
		);
		expect(f.fetch).toHaveBeenCalledTimes(stage === "bridge" ? 3 : 2);
	});
	it.each([401, 403])("preserves safe bridge permission status %s", async (status) => {
		const f = loginSetup();
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockResolvedValueOnce(Response.json(f.responses.authorization))
			.mockResolvedValueOnce(new Response("private detail", { status }));
		await expect(f.client.beginProviderLogin(f.input)).rejects.toMatchObject({
			status,
			code: "42501",
			message: "You do not have permission to start this provider login.",
		});
	});
	it("lets the SDK reject credential-shaped responses and unsafe interaction links", async () => {
		const f = loginSetup();
		f.responses.prompt.interaction_url = "http://unsafe.invalid/";
		await expect(f.client.beginProviderLogin(f.input)).rejects.toThrow("Refresh connections");
		f.responses.prompt.interaction_url = "https://auth.openai.com/device";
		f.fetch
			.mockResolvedValueOnce(Response.json({ compute_identity: f.responses.identity, connections: [] }))
			.mockResolvedValueOnce(Response.json(f.responses.authorization))
			.mockResolvedValueOnce(Response.json({ ...f.responses.prompt, access_token: "must-not-escape" }));
		await expect(
			f.client.beginProviderLogin({ ...f.input, clientLoginId: id(110), clientConnectionId: id(111) }),
		).rejects.toThrow("Refresh connections");
	});
	it("bounds the whole onboarding attempt and never dispatches after a late bridge auth response", async () => {
		vi.useFakeTimers();
		const f = loginSetup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>(),
			reached = deferred<void>();
		vi.mocked(f.cloud.supabase.auth.getSession)
			.mockResolvedValueOnce(original)
			.mockResolvedValueOnce(original)
			.mockImplementationOnce(() => {
				reached.resolve();
				return token.promise;
			});
		const rejected = expect(f.client.beginProviderLogin(f.input)).rejects.toThrow("Refresh connections");
		await reached.promise;
		await vi.advanceTimersByTimeAsync(120000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
});
