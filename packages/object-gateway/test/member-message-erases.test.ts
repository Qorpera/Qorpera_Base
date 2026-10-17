import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import type { MemberCompanyAuthority } from "../src/member-company-authority.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "44100000-0000-4000-8000-000000000010";
const environmentId = "44100000-0000-4000-8000-000000000020";
const otherEnvironmentId = "44100000-0000-4000-8000-000000000021";
const userId = "44100000-0000-4000-8000-000000000030";
const sessionId = "44100000-0000-4000-8000-000000000040";
const eventId = "44100000-0000-4000-8000-000000000050";
const eraseId = "44100000-0000-4000-8000-000000000060";
const token = "synthetic-member-jwt";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const answer = (state = "pending") => ({
	schema: "qorpera.memory-message-erase/v1",
	eraseId,
	state,
	sessionId,
	eventId,
	blocks: 2,
	runsPending: 1,
	copies: [
		{ environmentId, path: "Zeta/notes.md", live: false },
		{ environmentId, path: "reports/r2.md", live: true },
		{ environmentId: otherEnvironmentId, path: "reports/r2.md", live: false },
	],
});

/** The gateway with a fake database: the writer check and the erase functions of 20260930441000. */
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-message-erase-"));
	const store = new FileSystemObjectStore(join(root, "objects"));
	const objects = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "fixture-public",
		secretKey: "fixture-secret",
		fetch: async () => {
			throw new Error("Raw object authority must not be used");
		},
	});
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, objects);
	const state: { writer?: ObjectDependencyError; refusal?: ObjectDependencyError; reply?: unknown } = {};
	const member: MemberCompanyAuthority["member"] = vi.fn(async (method, memberToken, args) => {
		expect([method, memberToken, args]).toEqual([
			"qorpera_member_folder_writer",
			token,
			{ p_environment_id: environmentId },
		]);
		if (state.writer) throw state.writer;
		return { schema: "qorpera.member-folder-writer/v1", actor: { kind: "member", userId }, profileId };
	});
	const publisher: MemberCompanyAuthority["publisher"] = vi.fn(async (method) => {
		if (state.refusal) throw state.refusal;
		if (state.reply !== undefined) return state.reply;
		return answer(method === "qorpera_memory_message_erase_status" ? "done" : "pending");
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority: objects,
			replication,
			controlToken: "synthetic-control",
			memberFiles: { member, publisher },
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		state,
		member,
		publisher,
		request(path: string, init: RequestInit = {}) {
			return fetch(`http://127.0.0.1:${address.port}/v1/member-message-erases/${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers)) },
			});
		},
	};
}

const asked = `${environmentId}/${sessionId}/${eventId}`;
const read = `${environmentId}/${eraseId}`;

describe("a member's erase of one message", () => {
	it("asks for the erase as the member the token names, and reads where it stands", async () => {
		const service = await fixture();
		const request = await service.request(asked, { method: "POST" });
		expect(request.status).toBe(200);
		expect(request.headers.get("cache-control")).toBe("private, no-store");
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(await request.json()).toEqual(answer());
		const status = await service.request(read);
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual(answer("done"));
		expect(vi.mocked(service.member)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(service.publisher).mock.calls.map(([method, args]) => [method, args])).toEqual([
			[
				"qorpera_memory_message_erase_request",
				{ p_environment_id: environmentId, p_user_id: userId, p_session_id: sessionId, p_event_id: eventId },
			],
			[
				"qorpera_memory_message_erase_status",
				{ p_environment_id: environmentId, p_user_id: userId, p_erase_id: eraseId },
			],
		]);
	});

	it.each([
		["a read of a request", asked, { method: "GET" }, 405],
		["a write of a status", read, { method: "POST" }, 405],
		["a request with a body", asked, { method: "POST", body: "{}" }, 400],
		["a request without a member", asked, { method: "POST", headers: { authorization: "" } }, 401],
		["an id that is no UUID", `${environmentId}/${sessionId}/${"x".repeat(36)}`, { method: "POST" }, 404],
		["a version-0 id", `${environmentId}/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, {}, 404],
		["one more id", `${asked}/${eraseId}`, { method: "POST" }, 404],
		["a query", `${read}?userId=${userId}`, {}, 404],
	] as const)("refuses %s before any call", async (_name, path, init, status) => {
		const service = await fixture();
		expect((await service.request(path, init)).status).toBe(status);
		expect(service.member).not.toHaveBeenCalled();
		expect(service.publisher).not.toHaveBeenCalled();
	});

	it.each([
		["a member the database does not know", new ObjectDependencyError(403), 403],
		["a paused company", new ObjectDependencyError(423), 423],
	] as const)("keeps the writer check's refusal of %s", async (_name, refusal, status) => {
		const service = await fixture();
		service.state.writer = refusal;
		expect((await service.request(asked, { method: "POST" })).status).toBe(status);
		expect(service.publisher).not.toHaveBeenCalled();
	});

	it("answers 403 to a member who is no owner or admin asking, and 404 when they read an erase", async () => {
		// The database refuses the request with 42501 and hides the erase from the read with P0002.
		const service = await fixture();
		service.state.refusal = new ObjectDependencyError(403);
		expect((await service.request(asked, { method: "POST" })).status).toBe(403);
		service.state.refusal = new ObjectDependencyError(404);
		expect((await service.request(read)).status).toBe(404);
	});

	it.each([
		["a missing conversation, message or erase", new ObjectDependencyError(404), 404],
		["an invalid request", new ObjectDependencyError(400), 400],
		["an unavailable database", new ObjectDependencyError(500), 503],
	] as const)("keeps the database's refusal of %s", async (_name, refusal, status) => {
		const service = await fixture();
		service.state.refusal = refusal;
		expect((await service.request(asked, { method: "POST" })).status).toBe(status);
		expect((await service.request(read)).status).toBe(status);
	});

	it.each([
		["no answer", null],
		["another schema", { ...answer(), schema: "qorpera.memory-message-erase/v2" }],
		["another event", { ...answer(), eventId: eraseId }],
		["another session", { ...answer(), sessionId: eventId }],
		["one more key", { ...answer(), userId }],
		["one key less", { ...answer(), runsPending: undefined }],
		["an unknown state", answer("erased")],
		["a negative count", { ...answer(), blocks: -1 }],
		["a fractional count", { ...answer(), runsPending: 0.5 }],
		["an id that is no UUID", { ...answer(), eraseId: "erase" }],
		["no copies", { ...answer(), copies: null }],
		["a copy without an environment", { ...answer(), copies: [{ path: "reports/r2.md", live: true }] }],
		[
			"a copy whose environment is no UUID",
			{ ...answer(), copies: [{ environmentId: "env", path: "r2.md", live: true }] },
		],
		["a copy without a path", { ...answer(), copies: [{ environmentId, live: true }] }],
		["a copy with an empty path", { ...answer(), copies: [{ environmentId, path: "", live: true }] }],
		["a copy that is not live or gone", { ...answer(), copies: [{ environmentId, path: "r2.md", live: "yes" }] }],
		[
			"a copy with one more key",
			{ ...answer(), copies: [{ environmentId, path: "r2.md", live: true, kind: "block" }] },
		],
	])("answers 503 for a request whose answer has %s", async (_name, reply) => {
		const service = await fixture();
		service.state.reply = reply === null ? null : JSON.parse(JSON.stringify(reply));
		expect((await service.request(asked, { method: "POST" })).status).toBe(503);
	});

	it("answers 503 for a status of another erase", async () => {
		const service = await fixture();
		service.state.reply = { ...answer(), eraseId: eventId };
		expect((await service.request(read)).status).toBe(503);
	});
});
