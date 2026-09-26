import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretConnectorAdapter,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

function fixture(
	action = "send",
	draftId: string | null = null,
	output: JsonValue = { schema: "qorpera.connector-result/v1", status: "completed", result: { message_id: "m1" } },
) {
	const keyring = new CloudSecretKeyring({ test: randomBytes(32) });
	closers.push(() => keyring.close());
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "test",
	};
	const envelope = keyring.seal({ refresh_token: "private_refresh_token_never_return" }, identity);
	const actionId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const hash = createHash("sha256").update(capability).digest("hex");
	const content = { to: ["edited@example.test"], cc: [], subject: "Edited subject", body: "Edited body" };
	let claimed = false;
	let state: JsonValue = { status: "sending" };
	const execute = vi.fn<CloudSecretConnectorAdapter["execute"]>(async () => output);
	const finish = vi.fn(async (_id: string, _hash: string, result: JsonValue) => {
		state = result;
		return state;
	});
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(),
		completeCapture: vi.fn(),
		authorizeOperation: vi.fn(),
		authorizeRepositoryCredential: vi.fn(),
		claimEmailDraftAction: vi.fn(async (id, digest) => {
			if (id !== actionId || digest !== hash) throw new Error("denied");
			if (claimed) return { execute: false, state };
			claimed = true;
			return {
				execute: true,
				action,
				draftId,
				content,
				replyTo: null,
				...identity,
				encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
				envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			};
		}),
		finishEmailDraftAction: finish,
	};
	const operationId =
		action === "send"
			? draftId
				? "send_draft"
				: "send_message"
			: action === "save"
				? draftId
					? "update_draft"
					: "create_draft"
				: "delete_draft";
	const broker = new CloudSecretBroker({
		authority,
		keyring,
		adapters: [
			{
				connectorId: "gmail",
				operationId,
				operationVersion: 1,
				adapterSha256: "a".repeat(64),
				destinationOrigin: "https://gmail.googleapis.com",
				execute,
			},
		],
	});
	return { broker, actionId, capability, content, execute, finish, authority };
}

it.each([
	["send", null],
	["send", "draft1"],
	["save", null],
	["save", "draft1"],
] as const)("executes %s with exact member edits once (draft %s)", async (action, draftId) => {
	const f = fixture(action, draftId);
	const signal = AbortSignal.timeout(5000);
	await Promise.all([
		f.broker.executeEmailDraft(f.actionId, f.capability, signal),
		f.broker.executeEmailDraft(f.actionId, f.capability, signal),
	]);
	await f.broker.executeEmailDraft(f.actionId, f.capability, signal);
	expect(f.execute).toHaveBeenCalledTimes(1);
	expect(f.execute.mock.calls[0][0]).toMatchObject({
		arguments: { ...f.content, ...(draftId ? { draft_id: draftId } : {}) },
		credentialName: "refresh_token",
		idempotencyKey: f.actionId,
	});
});

it("does not touch Gmail when discarding an unsaved draft", async () => {
	const f = fixture("discard");
	expect(await f.broker.executeEmailDraft(f.actionId, f.capability, AbortSignal.timeout(5000))).toEqual({
		deleted: true,
	});
	expect(f.execute).not.toHaveBeenCalled();
});

it("records an ambiguous transport outcome and never retries the send", async () => {
	const f = fixture();
	f.execute.mockRejectedValue(new Error("lost response"));
	expect(await f.broker.executeEmailDraft(f.actionId, f.capability, AbortSignal.timeout(5000))).toEqual({
		status: "unconfirmed",
	});
	await f.broker.executeEmailDraft(f.actionId, f.capability, AbortSignal.timeout(5000));
	expect(f.execute).toHaveBeenCalledTimes(1);
});

it("records a definitive permission refusal as retryable with a new action", async () => {
	const f = fixture("save", null, {
		schema: "qorpera.connector-result/v1",
		status: "failed",
		reason: "authorization_required",
		detail: "scope",
	});
	expect(await f.broker.executeEmailDraft(f.actionId, f.capability, AbortSignal.timeout(5000))).toEqual({
		status: "failed",
		error: "Reconnect Gmail to allow this email action.",
	});
});

it("withholds secret-bearing provider responses", async () => {
	const f = fixture("send", null, {
		schema: "qorpera.connector-result/v1",
		status: "completed",
		result: { message_id: "private_refresh_token_never_return" },
	});
	expect(await f.broker.executeEmailDraft(f.actionId, f.capability, AbortSignal.timeout(5000))).toEqual({
		status: "unconfirmed",
	});
});

it("requires an exact member capability and an allowed browser origin", async () => {
	const f = fixture();
	const service = new HttpCloudSecretBrokerService(f.broker, randomBytes(32).toString("base64url"), {
		memberOrigins: ["https://app.example.test"],
	});
	const port = await service.start();
	closers.push(() => service.close());
	const url = `http://127.0.0.1:${port}/v1/email-drafts/${f.actionId}`;
	const request = (origin: string, capability: string) =>
		fetch(url, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ schema: "qorpera.email-draft-action/v1", capability }),
		});
	expect((await request("https://evil.example.test", f.capability)).status).toBe(403);
	expect((await request("https://app.example.test", randomBytes(32).toString("base64url"))).status).toBe(403);
	expect(f.execute).not.toHaveBeenCalled();
	const response = await request("https://app.example.test", f.capability);
	expect(response.status).toBe(200);
	expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
	expect(await response.json()).toEqual({ message_id: "m1" });
});
