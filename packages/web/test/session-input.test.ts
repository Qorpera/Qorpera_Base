// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSessionInputWriter, type SessionExecutionSponsor } from "../src/cloud/session-input.ts";
import { deferred, fixture, id, profileA, session, settle, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const sponsor: SessionExecutionSponsor = {
	connectionId: id(80),
	provider: "openai",
	nativeHarness: "codex-cli",
	sponsorBindingId: id(81),
	sponsorVersion: 1,
	computeIdentityId: id(82),
	workerClass: "managed_sandbox",
};
const receipt = { input_id: id(90), turn_request_id: id(92), status: "queued", sponsor_mode: "member_connection" };
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController();
	const current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(receipt));
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		send: (
			sessionId: string,
			inputId: string,
			text: string,
			signal: AbortSignal,
			selection: SessionExecutionSponsor | undefined = sponsor,
		) =>
			createWebSessionInputWriter(f.cloud, userA.id, company.signal, current, profileA.profileId)(
				sessionId,
				inputId,
				text,
				signal,
				[],
				selection,
			),
	};
}
describe("member message transport", () => {
	it("uploads images against the retained input ID and retries one identical sponsored request", async () => {
		vi.stubGlobal("crypto", webcrypto);
		vi.stubGlobal("File", NodeFile);
		const f = setup();
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		const bytes = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4X8AAAAASUVORK5CYII=",
				"base64",
			),
		);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const files = [new File([bytes], "image.png", { type: "image/png" })];
		let lost = true;
		f.fetch.mockImplementation(async (url) => {
			if (String(url).includes("/upload/"))
				return Response.json({ sha256, bytes: bytes.length, mediaType: "image/png" });
			if (lost) {
				lost = false;
				throw new Error("Lost reply");
			}
			return Response.json(receipt);
		});
		const send = createWebSessionInputWriter(f.cloud, userA.id, f.company.signal, f.current, profileA.profileId);
		await expect(send(session.sessionId, id(91), "Image", f.view.signal, files, sponsor)).rejects.toThrow();
		await send(session.sessionId, id(91), "Image", f.view.signal, files, sponsor);
		const uploads = f.fetch.mock.calls.filter(([url]) => String(url).includes("/upload/"));
		const requests = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_request_session_turn_v2"));
		expect(uploads).toHaveLength(2);
		expect(requests).toHaveLength(2);
		expect(uploads[0]![0]).toBe(uploads[1]![0]);
		expect(String(uploads[0]![0])).toContain(id(91));
		expect(requests[0]![1]!.body).toBe(requests[1]![1]!.body);
		expect(JSON.parse(requests[0]![1]!.body as string).p_body.images).toEqual([
			{ objectSha256: sha256, bytes: bytes.length, mediaType: "image/png" },
		]);
		expect(f.fetch.mock.calls.some(([url]) => String(url).includes("append_session_input"))).toBe(false);
	});
	it("refuses missing explicit sponsorship without appending or uploading", async () => {
		const f = setup();
		const send = createWebSessionInputWriter(f.cloud, userA.id, f.company.signal, f.current, profileA.profileId);
		await expect(send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow("Select");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("queues only the member prompt with a fixed request identity and no credentials in its URL", async () => {
		const f = setup();
		expect(await f.send(session.sessionId, id(91), "Do the work", f.view.signal)).toEqual({
			inputId: id(90),
			turnRequestId: id(92),
			status: "queued",
			sponsorMode: "member_connection",
		});
		expect(f.fetch).toHaveBeenCalledTimes(1);
		const [url, request] = f.fetch.mock.calls[0]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_request_session_turn_v2");
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request?.body as string)).toEqual({
			p_session_id: session.sessionId,
			p_client_input_id: id(91),
			p_client_request_id: id(91),
			p_sponsor_mode: "member_connection",
			p_sponsor_binding_id: id(81),
			p_sponsor_version: 1,
			p_compute_identity_id: id(82),
			p_requested_sponsor_user_id: null,
			p_logical_computer_id: null,
			p_worker_class: "managed_sandbox",
			p_required_capability: "agent_turn",
			p_job_type: "agent_turn",
			p_publication_mode: "automatic",
			p_review_policy_key: null,
			p_reviewer_staff_ids: [],
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
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
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
		response.resolve(Response.json(receipt));
		await expect(sending).rejects.toThrow();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("bounds response bytes and rejects malformed receipts", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
		f.fetch.mockResolvedValueOnce(Response.json({ input_id: "wrong", position: 0 }));
		await expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
	});
	it("bounds token acquisition without dispatch or retry", async () => {
		vi.useFakeTimers();
		const f = setup();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValue(new Promise(() => {}));
		const rejected = expect(f.send(session.sessionId, id(91), "Draft", f.view.signal)).rejects.toThrow();
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
