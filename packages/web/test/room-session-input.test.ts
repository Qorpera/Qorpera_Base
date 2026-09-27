// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { createWebSessionInputWriter, type SessionExecutionSponsor } from "../src/cloud/session-input.ts";
import type { HostedSession } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, session, settle, team, userA, userB } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const target = { roomId: id(70), environmentId: profileA.environmentId, agentThread: false, images: false };
const roomSession: HostedSession = { ...session, executionScope: { roomId: target.roomId } };
const sponsor: SessionExecutionSponsor = {
	connectionId: id(80),
	provider: "openai",
	nativeHarness: "codex-cli",
	sponsorBindingId: id(81),
	sponsorVersion: 1,
	computeIdentityId: id(82),
	workerClass: "managed_sandbox",
};
const rooms = [
	{ ...target, sessionId: session.sessionId, status: "active", members: [{ kind: "member", id: userA.id }] },
];
const receipt = {
	schema: "qorpera.company-room-post/v1",
	roomId: target.roomId,
	sessionId: session.sessionId,
	inputId: id(90),
	occurrenceIds: [id(91)],
};
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController(),
		current = vi.fn();
	const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		if (String(url).endsWith("/qorpera_list_company_rooms")) return Response.json(rooms);
		if (String(url).endsWith("/qorpera_post_company_room_message")) return Response.json(receipt);
		throw new Error("Unexpected transport");
	});
	vi.stubGlobal("fetch", fetch);
	const write = vi.fn(createWebSessionInputWriter(f.cloud, userA.id, company.signal, current, profileA.profileId));
	const controller = new CompanyController(f.api, profileA, userA.id, write);
	controller.store.set({ team, sessions: [roomSession] });
	controller.conversation(session.sessionId, false).set({ executionSponsor: sponsor });
	const append = vi.spyOn(f.api, "appendPrompt");
	cleanup.push(() => {
		controller.stop();
		company.abort();
	});
	return { ...f, company, view, current, fetch, write, controller, append };
}

describe("room session input routing", () => {
	it("uses the public room post receipt and creates no native turn or image upload", async () => {
		const f = setup();
		await expect(
			f.write(session.sessionId, id(92), "Room message", f.view.signal, [], sponsor, target),
		).resolves.toMatchObject({ inputId: receipt.inputId });
		expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([
			"https://fixture.invalid/rest/v1/rpc/qorpera_list_company_rooms",
			"https://fixture.invalid/rest/v1/rpc/qorpera_post_company_room_message",
		]);
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({ p_profile_id: profileA.profileId });
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toEqual({
			p_room_id: target.roomId,
			p_client_input_id: id(92),
			p_body: { schema: "qorpera.session-prompt/v1", text: "Room message", images: [] },
			p_sponsor_binding_id: sponsor.sponsorBindingId,
			p_sponsor_version: sponsor.sponsorVersion,
		});
		expect(f.append).not.toHaveBeenCalled();
	});
	it("replays the exact uncertain room input and sponsor despite a newer selected binding", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json(rooms)).mockRejectedValueOnce(new Error("Lost post reply"));
		expect(await f.controller.sendPrompt(session.sessionId, "Room draft")).toBe(false);
		const state = f.controller.conversation(session.sessionId, false),
			retained = state.get().retrySend!;
		expect(retained).toMatchObject({ text: "Room draft", executionSponsor: sponsor, roomTarget: target, files: [] });
		expect(retained.clientRequestId).toBe(retained.clientInputId);
		state.set({
			executionSponsor: { ...sponsor, sponsorBindingId: id(83), sponsorVersion: 2, connectionId: id(84) },
		});
		expect(await f.controller.sendPrompt(session.sessionId, "Room draft")).toBe(true);
		const posts = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_post_company_room_message"));
		expect(posts).toHaveLength(2);
		expect(posts[1]![1]!.body).toBe(posts[0]![1]!.body);
		expect(f.write.mock.calls[1]![1]).toBe(retained.clientInputId);
		expect(f.write.mock.calls[1]![5]).toEqual(sponsor);
		expect(f.write.mock.calls[1]![6]).toEqual(target);
		expect(state.get()).toMatchObject({ draft: "", attachments: [] });
		expect(state.get().retrySend).toBeUndefined();
		expect(f.fetch).toHaveBeenCalledTimes(4);
		expect(f.append).not.toHaveBeenCalled();
	});
	it("requires explicit abandonment before posting an edited uncertain room message", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json(rooms)).mockRejectedValueOnce(new Error("Lost post reply"));
		expect(await f.controller.sendPrompt(session.sessionId, "Original room draft")).toBe(false);
		const state = f.controller.conversation(session.sessionId, false),
			retained = state.get().retrySend!;
		state.set({ draft: "Edited room draft" });
		expect(await f.controller.sendPrompt(session.sessionId, "Edited room draft")).toBe(false);
		expect(f.fetch).toHaveBeenCalledTimes(2);
		expect(state.get().retrySend).toBe(retained);
		expect(retained.roomTarget).toEqual(target);
		f.controller.discardSendRetry(session.sessionId);
		expect(state.get().draft).toBe("Edited room draft");
		expect(await f.controller.sendPrompt(session.sessionId, "Edited room draft")).toBe(true);
		expect(f.fetch).toHaveBeenCalledTimes(4);
		expect(f.write.mock.calls[1]![1]).not.toBe(retained.clientInputId);
		expect(f.write.mock.calls[1]![2]).toBe("Edited room draft");
		expect(f.write.mock.calls[1]![6]).toEqual(target);
	});
	it.each(["another room", "direct conversation"])(
		"refuses replay when the canonical destination becomes %s",
		async (change) => {
			const f = setup();
			f.fetch.mockResolvedValueOnce(Response.json(rooms)).mockRejectedValueOnce(new Error("Lost post reply"));
			expect(await f.controller.sendPrompt(session.sessionId, "Keep this draft")).toBe(false);
			const state = f.controller.conversation(session.sessionId, false),
				retained = state.get().retrySend;
			f.controller.store.set({
				sessions: [{ ...roomSession, executionScope: change === "another room" ? { roomId: id(71) } : undefined }],
			});
			expect(await f.controller.sendPrompt(session.sessionId, "Keep this draft")).toBe(false);
			expect(state.get().retrySend).toBe(retained);
			expect(state.get().draft).toBe("Keep this draft");
			expect(state.get().sendError).toContain("destination changed");
			expect(f.write).toHaveBeenCalledTimes(1);
			expect(f.fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("rejects room images before reading or uploading and preserves the controller draft and exact files", async () => {
		const f = setup();
		const file = new File(["image bytes"], "image.png", { type: "image/png" });
		const read = vi.fn();
		Object.defineProperty(file, "arrayBuffer", { value: read });
		await expect(
			f.write(session.sessionId, id(92), "Image draft", f.view.signal, [file], sponsor, target),
		).rejects.toThrow("Images are not supported");
		const state = f.controller.conversation(session.sessionId, false);
		state.set({ attachments: [file], draft: "Image draft" });
		expect(await f.controller.sendPrompt(session.sessionId, "Image draft")).toBe(false);
		expect(state.get().draft).toBe("Image draft");
		expect(state.get().attachments?.[0]).toBe(file);
		expect(state.get().sendError).toContain("Images are not supported");
		expect(state.get().retrySend).toBeUndefined();
		expect(f.write).toHaveBeenCalledTimes(1);
		expect(read).not.toHaveBeenCalled();
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.cloud.supabase.auth.getSession).not.toHaveBeenCalled();
		expect(f.append).not.toHaveBeenCalled();
	});
	it("sends a group chat's images once the cloud takes them", async () => {
		const f = setup();
		f.controller.store.set({ sidebar: { sections: [], placements: {}, pinned: [], hidden: [], groupChats: true } });
		const file = new File(["image bytes"], "image.png", { type: "image/png" });
		f.write.mockResolvedValueOnce({ inputId: receipt.inputId } as Awaited<ReturnType<typeof f.write>>);
		const state = f.controller.conversation(session.sessionId, false);
		state.set({ attachments: [file], draft: "Look at this" });
		expect(await f.controller.sendPrompt(session.sessionId, "Look at this")).toBe(true);
		expect(f.write).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			expect.any(String),
			"Look at this",
			expect.any(AbortSignal),
			[file],
			sponsor,
			{ ...target, images: true },
		);
		expect(state.get()).toMatchObject({ draft: "", attachments: [] });
	});
	it.each([{ ...roomSession, executionScope: { roomId: "invalid" } }])(
		"refuses a malformed canonical room scope",
		async (invalidSession) => {
			const f = setup();
			f.controller.store.set({ sessions: [invalidSession] });
			expect(await f.controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
			expect(f.controller.conversation(session.sessionId, false).get().sendError).toContain(
				"room conversation is unavailable",
			);
			expect(f.write).not.toHaveBeenCalled();
			expect(f.fetch).not.toHaveBeenCalled();
		},
	);
	it("fences the current account before room discovery or post", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.write(session.sessionId, id(92), "Draft", f.view.signal, [], sponsor, target)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("does not accept a late room receipt after the caller's destination fence changes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockResolvedValueOnce(Response.json(rooms)).mockReturnValueOnce(response.promise);
		const sending = f.write(session.sessionId, id(92), "Draft", f.view.signal, [], sponsor, target);
		await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
		f.current.mockImplementation(() => {
			throw new Error("Destination changed");
		});
		response.resolve(Response.json(receipt));
		await expect(sending).rejects.toThrow();
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
});
