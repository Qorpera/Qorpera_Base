// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { MessageEraseError } from "../src/cloud/message-erases.ts";
import { fixture, id, profileA, userA } from "./fixtures.ts";

/* The member's erase of one message (summary trees M3c): the object gateway's member route, bridged through the
 * member company gateway once that is configured, under the member's own token, with no body and no other header. */

const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const session = id(50),
	event = id(51),
	eraseId = id(52);
const answer = (fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		schema: "qorpera.memory-message-erase/v1",
		eraseId,
		state: "pending",
		sessionId: session,
		eventId: event,
		blocks: 0,
		runsPending: 0,
		...fields,
	});

function setup(reply: () => Response, useBridge = true) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	const bridge = `${f.cloud.config.projectUrl}/functions/v1/member-company-gateway`;
	if (useBridge) f.cloud.config.memberCompanyGatewayUrl = bridge;
	const calls: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		expect(init?.redirect).toBe("error");
		expect(init?.credentials).toBe("omit");
		calls.push({
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			headers: new Headers(init?.headers),
			body: init?.body,
		});
		return reply();
	});
	vi.stubGlobal("fetch", fetch);
	const company = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stop.signal, vi.fn());
	disposers.push(() => stop.abort());
	return { erases: company.messageErases(), calls, bridge, signal: new AbortController().signal };
}

describe("the member's message erase transport", () => {
	it("asks for an erase and reads it again through the bridge with the member's token alone", async () => {
		const { erases, calls, bridge, signal } = setup(() => new Response(answer(), { status: 200 }));
		const asked = await erases.request(session, event, signal);
		expect(asked).toEqual({ eraseId, state: "pending", sessionId: session, eventId: event });
		await erases.status(asked, signal);
		expect(calls.map((call) => [call.method, call.url.href])).toEqual([
			["POST", `${bridge}/v1/member-message-erases/${profileA.environmentId}/${session}/${event}`],
			["GET", `${bridge}/v1/member-message-erases/${profileA.environmentId}/${eraseId}`],
		]);
		for (const call of calls) {
			// The bridge and the gateway take the authorization header alone: no body and no content type.
			expect([...call.headers.keys()]).toEqual(["authorization"]);
			expect(call.headers.get("authorization")).toBe("Bearer fixture-token");
			expect(call.body).toBeUndefined();
		}
	});

	it("goes to the object gateway itself until the bridge is configured", async () => {
		const { erases, calls, signal } = setup(() => new Response(answer({ state: "done" }), { status: 200 }), false);
		expect((await erases.request(session, event, signal)).state).toBe("done");
		expect(calls[0]!.url.href).toBe(
			`https://objects.fixture.invalid/v1/member-message-erases/${profileA.environmentId}/${session}/${event}`,
		);
	});

	it("keeps the route's status when it refuses", async () => {
		for (const status of [403, 404, 423, 503]) {
			const { erases, signal } = setup(() => new Response(JSON.stringify({ error: "no" }), { status }));
			const error = await erases.request(session, event, signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(MessageEraseError);
			expect((error as MessageEraseError).status).toBe(status);
		}
	});

	it("takes an answer only for the erase, conversation and message it asked about", async () => {
		for (const fields of [
			{ schema: "qorpera.memory-message-erase/v2" },
			{ state: "gone" },
			{ eventId: id(53) },
			{ sessionId: id(53) },
			{ eraseId: "not-an-id" },
		]) {
			const { erases, signal } = setup(() => new Response(answer(fields), { status: 200 }));
			await expect(erases.request(session, event, signal)).rejects.toThrow("Invalid message erase answer");
		}
		const { erases, signal } = setup(() => new Response(answer({ eraseId: id(54) }), { status: 200 }));
		await expect(
			erases.status({ eraseId, state: "open", sessionId: session, eventId: event }, signal),
		).rejects.toThrow("Invalid message erase answer");
		const { erases: other, signal: otherSignal } = setup(() => new Response("{", { status: 200 }));
		await expect(other.request(session, event, otherSignal)).rejects.toThrow("Invalid message erase answer");
	});

	it("sends nothing for an id that is not one", async () => {
		const { erases, calls, signal } = setup(() => new Response(answer(), { status: 200 }));
		await expect(erases.request(session, "optimistic-1", signal)).rejects.toThrow("Invalid message erase");
		expect(calls).toEqual([]);
	});
});
