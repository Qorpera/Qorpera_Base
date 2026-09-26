import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { createGmailConnectorAdapters } from "@qorpera/runtime/cloud-connector-google";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Cloud } from "../../web/src/cloud/client.ts";
import { EmailDraftClient, type EmailDraftContent } from "../../web/src/cloud/email-drafts.ts";

/* Cross-layer integration: actual browser client, loopback HTTP broker, encrypted
 * custody, and production Gmail adapters. Only provider responses and the SQL RPC
 * authority are controlled fixtures. The real SQL authority is tested separately
 * in supabase/tests/620_member_email_drafts.test.sql. */
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.unstubAllGlobals();
});

interface Action {
	id: string;
	hash: string;
	action: string;
	content: EmailDraftContent;
	draftId: string | null;
	phase: "pending" | "running" | "succeeded" | "unconfirmed";
	receipt?: JsonValue;
}

async function fixture(loseProviderSendResponse = false) {
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "test-key",
	};
	const sessionId = randomUUID(),
		interactionId = randomUUID();
	const sponsor = { sponsorBindingId: randomUUID(), sponsorVersion: 3 };
	const keyring = new CloudSecretKeyring({ [identity.keyId]: randomBytes(32) });
	cleanup.push(() => keyring.close());
	const refreshToken = "1//private_refresh_token_for_integration";
	const envelope = Buffer.from(keyring.seal({ refresh_token: refreshToken }, identity));
	const actions = new Map<string, Action>();
	const providerWrites: { method: string; path: string; data: { id?: string; message?: { raw: string } } }[] = [];
	const provider: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.href === "https://oauth2.googleapis.com/token") {
			expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(refreshToken);
			return Response.json({ access_token: "integration_access_token_0123456789", expires_in: 3600 });
		}
		expect(url.origin).toBe("https://gmail.googleapis.com");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer integration_access_token_0123456789");
		if (url.pathname === "/gmail/v1/users/me/profile") return Response.json({ emailAddress: "verified@example.com" });
		const data = JSON.parse(String(init?.body ?? "{}")) as { id?: string; message?: { raw: string } };
		providerWrites.push({ method: init?.method ?? "GET", path: url.pathname, data });
		if (url.pathname === "/gmail/v1/users/me/drafts/send") {
			expect(data.id).toBe("draft-1");
			if (loseProviderSendResponse) throw new TypeError("Provider accepted mail but its response was lost");
			return Response.json({ id: "sent-message-1", threadId: "thread-1" });
		}
		if (url.pathname === "/gmail/v1/users/me/drafts" || url.pathname === "/gmail/v1/users/me/drafts/draft-1")
			return Response.json({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } });
		throw new Error(`Unexpected provider request: ${url.pathname}`);
	};
	let content: EmailDraftContent = {
		to: ["henrik@example.com"],
		cc: [],
		subject: "About Qorpera",
		body: "Hej Henrik,\n\nOm Qorpera.",
	};
	let status = "ready",
		draftId: string | undefined,
		messageId: string | undefined;
	let current: Action | undefined;
	const receipt = (action = current): JsonValue => ({
		schema: "qorpera.email-draft-state/v1",
		companyId: identity.companyId,
		from: "verified@example.com",
		content: { ...content },
		status,
		...(draftId ? { draftId } : {}),
		...(messageId ? { messageId } : {}),
		...(action ? { actionId: action.id, phase: action.phase } : {}),
		brokerOrigin: "https://integration-broker.example.test",
	});
	const unavailable = async (): Promise<never> => {
		throw new Error("Unused authority route");
	};
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: unavailable,
		completeCapture: unavailable,
		authorizeOperation: unavailable,
		authorizeRepositoryCredential: unavailable,
		async claimEmailDraftAction(id, hash) {
			const action = actions.get(id);
			if (!action || action.hash !== hash) throw new Error("Capability rejected");
			if (action.phase !== "pending") return { execute: false, state: action.receipt ?? receipt(action) };
			action.phase = "running";
			return {
				execute: true,
				action: action.action,
				content: { ...action.content },
				draftId: action.draftId,
				replyTo: null,
				...identity,
				encryptedEnvelopeBase64: envelope.toString("base64"),
				envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			};
		},
		async finishEmailDraftAction(id, hash, result) {
			const action = actions.get(id);
			if (!action || action.hash !== hash || action.phase !== "running") throw new Error("Completion rejected");
			if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid result");
			content = action.content;
			if (result.status === "unconfirmed") {
				status = "unconfirmed";
				action.phase = "unconfirmed";
			} else if (action.action === "save" && typeof result.draft_id === "string") {
				draftId = result.draft_id;
				status = "saved";
				action.phase = "succeeded";
			} else if (action.action === "send" && typeof result.message_id === "string") {
				messageId = result.message_id;
				status = "sent";
				action.phase = "succeeded";
			} else throw new Error(`Unexpected broker completion: ${JSON.stringify(result)}`);
			action.receipt = receipt(action);
			return action.receipt;
		},
	};
	const broker = new CloudSecretBroker({
		authority,
		keyring,
		adapters: createGmailConnectorAdapters({
			fetch: provider,
			client: { clientId: "test.apps.googleusercontent.com", clientSecret: "test-client-secret" },
		}),
	});
	const service = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), {
		memberOrigins: ["https://app.example.test"],
	});
	const port = await service.start();
	cleanup.push(() => service.close());
	const nativeFetch = globalThis.fetch;
	const requests: { url: string; body: string }[] = [];
	let dropBrokerResponse = false;
	// HTTPS termination is normally the deployment router's job. Only that origin
	// is rewritten here; every request still crosses the actual HTTP listener.
	vi.stubGlobal("fetch", (async (input, init) => {
		const url = new URL(String(input));
		if (url.origin !== "https://integration-broker.example.test") throw new Error("Unexpected external request");
		requests.push({ url: url.href, body: String(init?.body) });
		const response = await nativeFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
			...init,
			headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: "https://app.example.test" },
		});
		expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
		if (dropBrokerResponse) {
			dropBrokerResponse = false;
			await response.text();
			throw new TypeError("Broker receipt was lost");
		}
		return response;
	}) satisfies typeof fetch);
	const rpc = async (name: string, args: Record<string, unknown>): Promise<JsonValue> => {
		expect(args.p_session_id).toBe(sessionId);
		expect(args.p_interaction_id).toBe(interactionId);
		if (name === "qorpera_get_email_draft") return receipt();
		expect(name).toBe("qorpera_prepare_email_draft_action");
		expect(args.p_sponsor_binding_id).toBe(sponsor.sponsorBindingId);
		expect(args.p_sponsor_version).toBe(3);
		const id = String(args.p_client_action_id),
			hash = String(args.p_capability_sha256);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		const known = actions.get(id);
		if (known) {
			expect(known.hash).toBe(hash);
			return known.receipt ?? receipt(known);
		}
		if (status === "sent" || status === "unconfirmed") throw new Error("Draft cannot be executed again");
		content = structuredClone(args.p_content) as EmailDraftContent;
		current = { id, hash, action: String(args.p_action), content, draftId: draftId ?? null, phase: "pending" };
		actions.set(id, current);
		status = "sending";
		return receipt();
	};
	const cloud = { config: { projectUrl: "https://integration-cloud.example.test" }, rpc } as unknown as Cloud;
	const signal = AbortSignal.timeout(10_000);
	const client = new EmailDraftClient(cloud, "member", signal);
	return {
		client,
		cloud,
		signal,
		sessionId,
		interactionId,
		sponsor,
		requests,
		providerWrites,
		nativeFetch,
		port,
		dropNextBrokerResponse() {
			dropBrokerResponse = true;
		},
	};
}

it("saves, edits and sends through the real HTTP broker and Gmail adapters, then replays without sending twice", async () => {
	const f = await fixture();
	const initial = await f.client.read(f.sessionId, f.interactionId);
	expect(initial.from).toBe("verified@example.com");
	const saved = await f.client.act(f.sessionId, f.interactionId, "save", initial.content, f.sponsor);
	expect(saved).toMatchObject({ status: "saved", draftId: "draft-1" });
	const edited = {
		...initial.content,
		cc: ["copy@example.com"],
		subject: "Updated introduction",
		body: "Hej Henrik,\n\nÆndret tekst om Qorpera.",
	};
	expect(await f.client.act(f.sessionId, f.interactionId, "save", edited, f.sponsor)).toMatchObject({
		status: "saved",
		content: edited,
	});
	const final = { ...edited, to: ["final@example.com"], body: "The final member-approved letter." };
	f.dropNextBrokerResponse();
	await expect(f.client.act(f.sessionId, f.interactionId, "send", final, f.sponsor)).rejects.toThrow(
		"Broker receipt was lost",
	);
	const reopened = new EmailDraftClient(f.cloud, "member", f.signal);
	expect(await reopened.read(f.sessionId, f.interactionId)).toMatchObject({
		status: "sent",
		messageId: "sent-message-1",
		content: final,
	});
	const sendRequest = f.requests.at(-1)!;
	const replay = await f.nativeFetch(`http://127.0.0.1:${f.port}${new URL(sendRequest.url).pathname}`, {
		method: "POST",
		headers: { origin: "https://app.example.test", "content-type": "application/json" },
		body: sendRequest.body,
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({ status: "sent", content: final });
	expect(f.providerWrites.map(({ method, path }) => `${method} ${path}`)).toEqual([
		"POST /gmail/v1/users/me/drafts",
		"PUT /gmail/v1/users/me/drafts/draft-1",
		"POST /gmail/v1/users/me/drafts/send",
	]);
	const raw = Buffer.from(f.providerWrites.at(-1)!.data.message!.raw, "base64url").toString("utf8");
	expect(raw).toContain("From: verified@example.com");
	expect(raw).toContain("To: final@example.com");
	expect(raw).toContain("Cc: copy@example.com");
	expect(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe(final.body);
	expect(JSON.stringify(f.requests)).not.toContain("private_refresh_token");
	const invalid = await f.nativeFetch(`http://127.0.0.1:${f.port}${new URL(sendRequest.url).pathname}`, {
		method: "POST",
		headers: { origin: "https://app.example.test", "content-type": "application/json" },
		body: JSON.stringify({
			schema: "qorpera.email-draft-action/v1",
			capability: randomBytes(32).toString("base64url"),
		}),
	});
	expect(invalid.status).toBe(403);
	expect(f.providerWrites).toHaveLength(3);
});

it("retains an ambiguous provider delivery and never executes the send again on refresh or HTTP replay", async () => {
	const f = await fixture(true);
	const initial = await f.client.read(f.sessionId, f.interactionId);
	await f.client.act(f.sessionId, f.interactionId, "save", initial.content, f.sponsor);
	expect(await f.client.act(f.sessionId, f.interactionId, "send", initial.content, f.sponsor)).toMatchObject({
		status: "unconfirmed",
	});
	expect(await f.client.read(f.sessionId, f.interactionId)).toMatchObject({ status: "unconfirmed" });
	const request = f.requests.at(-1)!;
	const replay = await f.nativeFetch(`http://127.0.0.1:${f.port}${new URL(request.url).pathname}`, {
		method: "POST",
		headers: { origin: "https://app.example.test", "content-type": "application/json" },
		body: request.body,
	});
	expect(await replay.json()).toMatchObject({ status: "unconfirmed" });
	expect(f.providerWrites.filter((write) => write.path.endsWith("/send"))).toHaveLength(1);
});
