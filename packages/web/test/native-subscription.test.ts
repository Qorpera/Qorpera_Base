import type { RequestSponsoredSessionTurnInput } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebNativeSubscription, type WebNativeProviderLoginInput } from "../src/cloud/native-subscription.ts";
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
			connectionId: id(103),
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
		await vi.advanceTimersByTimeAsync(45000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
});
