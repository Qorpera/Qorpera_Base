import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebRoomMessages, type RoomMessageInput } from "../src/cloud/room-messages.ts";
import { deferred, fixture, id, profileA, settle, userA, userB } from "./fixtures.ts";

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
	const input: RoomMessageInput = {
		roomId: id(90),
		sessionId: id(91),
		environmentId: id(92),
		clientInputId: id(93),
		text: "Review the company plan",
		sponsorBindingId: id(94),
		sponsorVersion: 5,
	};
	const room = {
		roomId: input.roomId,
		key: "planning",
		name: "Planning",
		purpose: "Coordinate",
		status: "active",
		projectId: null,
		sessionId: input.sessionId,
		version: 3,
		environmentId: input.environmentId,
		members: [
			{ kind: "member", id: userA.id },
			{ kind: "staff_agent", id: id(95) },
			{ kind: "staff_agent", id: id(96) },
		],
	};
	const receipt = {
		schema: "qorpera.company-room-post/v1",
		roomId: input.roomId,
		sessionId: input.sessionId,
		inputId: id(97),
		occurrenceIds: [id(98), id(99)],
	};
	const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		if (String(url).endsWith("qorpera_list_company_rooms")) return Response.json([room]);
		if (String(url).endsWith("qorpera_post_company_room_message")) return Response.json(receipt);
		throw new Error("Unexpected endpoint");
	});
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		input,
		room,
		receipt,
		fetch,
		client: createWebRoomMessages(f.cloud, profileA.profileId, userA.id, company.signal, current),
	};
}

describe("room messages use the public room admission contract", () => {
	it("discovers scoped membership then makes one atomic post without inventing a session run", async () => {
		const f = setup();
		expect(await f.client.post(f.input, f.view.signal)).toEqual(f.receipt);
		expect(f.fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({ p_profile_id: profileA.profileId });
		const [url, request] = f.fetch.mock.calls[1]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_post_company_room_message");
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request!.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(JSON.parse(request!.body as string)).toEqual({
			p_room_id: id(90),
			p_client_input_id: id(93),
			p_body: { schema: "qorpera.session-prompt/v1", text: "Review the company plan", images: [] },
			p_sponsor_binding_id: id(94),
			p_sponsor_version: 5,
		});
		expect(f.current).toHaveBeenCalledWith(id(91));
	});
	it("snapshots exact input and sponsor identity before discovery yields", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const posting = f.client.post(f.input);
		f.input.clientInputId = id(999);
		f.input.text = "Changed";
		f.input.sponsorVersion = 6;
		response.resolve(Response.json([f.room]));
		await posting;
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
			p_client_input_id: id(93),
			p_sponsor_version: 5,
			p_body: { text: "Review the company plan" },
		});
	});
	it.each(["room", "session", "environment", "inactive", "member", "duplicate"] as const)(
		"refuses %s discovery mismatch before posting",
		async (change) => {
			const f = setup();
			if (change === "room") f.room.roomId = id(999);
			if (change === "session") f.room.sessionId = id(999);
			if (change === "environment") f.room.environmentId = id(999);
			if (change === "inactive") f.room.status = "closed";
			if (change === "member") f.room.members[0]!.id = userB.id;
			if (change === "duplicate") f.fetch.mockResolvedValueOnce(Response.json([f.room, f.room]));
			await expect(f.client.post(f.input)).rejects.toThrow("Refresh the conversation");
			expect(f.fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["room", "session", "input", "occurrences", "extra"] as const)(
		"rejects a substituted %s receipt without retry",
		async (change) => {
			const f = setup();
			if (change === "room") f.receipt.roomId = id(999);
			if (change === "session") f.receipt.sessionId = id(999);
			if (change === "input") f.receipt.inputId = "not-a-uuid";
			if (change === "occurrences") f.receipt.occurrenceIds = [id(98), id(98)];
			if (change === "extra")
				f.fetch
					.mockResolvedValueOnce(Response.json([f.room]))
					.mockResolvedValueOnce(Response.json({ ...f.receipt, runId: id(100) }));
			await expect(f.client.post(f.input)).rejects.toThrow("Refresh the conversation");
			expect(f.fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("accepts an admitted room input with no agent occurrences without reporting completed work", async () => {
		const f = setup();
		f.receipt.occurrenceIds = [];
		f.room.members = f.room.members.slice(0, 1);
		expect(await f.client.post(f.input)).toEqual({ ...f.receipt, occurrenceIds: [] });
	});
	it("validates the UTF8 text boundary and rejects unsupported image inputs before dispatch", async () => {
		const f = setup();
		await expect(f.client.post({ ...f.input, text: "😀".repeat(16385) })).rejects.toThrow();
		await expect(f.client.post({ ...f.input, text: "   " })).rejects.toThrow();
		const withImages = { ...f.input, images: [{ objectSha256: "not-a-digest", bytes: 1, mediaType: "image/png" }] };
		await expect(f.client.post(withImages)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		await f.client.post({ ...f.input, text: "😀".repeat(16384) });
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
	it("rejects another account before discovery and an account switch before posting", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.client.post(f.input)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		f.auth(userA);
		f.fetch.mockImplementationOnce(async () => {
			f.auth(userB);
			return Response.json([f.room]);
		});
		await expect(f.client.post(f.input)).rejects.toThrow();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["company", "view"] as const)("aborts %s during discovery and never submits a post", async (scope) => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const rejected = expect(f.client.post(f.input, f.view.signal)).rejects.toThrow();
		await settle();
		f[scope].abort();
		await rejected;
		response.resolve(Response.json([f.room]));
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("fences current session after discovery and rejects late post receipts", async () => {
		const f = setup();
		f.fetch.mockImplementationOnce(async () => {
			f.current.mockImplementation(() => {
				throw new Error("Room changed");
			});
			return Response.json([f.room]);
		});
		await expect(f.client.post(f.input)).rejects.toThrow();
		expect(f.fetch).toHaveBeenCalledTimes(1);
		f.current.mockImplementation(() => {});
		const response = deferred<Response>(),
			reached = deferred<void>();
		f.fetch.mockResolvedValueOnce(Response.json([f.room])).mockImplementationOnce(() => {
			reached.resolve();
			return response.promise;
		});
		const pending = f.client.post(f.input);
		await reached.promise;
		f.current.mockImplementation(() => {
			throw new Error("Room changed");
		});
		response.resolve(Response.json(f.receipt));
		await expect(pending).rejects.toThrow("Refresh the conversation");
	});
	it.each([401, 403])("preserves safe permission status%s without leaking server details", async (status) => {
		const f = setup();
		f.fetch
			.mockResolvedValueOnce(Response.json([f.room]))
			.mockResolvedValueOnce(new Response("sensitive detail", { status }));
		await expect(f.client.post(f.input)).rejects.toMatchObject({
			status,
			code: "42501",
			message: "You do not have permission to post in this room.",
		});
	});
	it("never retries uncertain admission and bounds delayed authentication", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json([f.room])).mockRejectedValueOnce(new Error("private server detail"));
		await expect(f.client.post(f.input)).rejects.toThrow(
			"Room message could not be confirmed. Refresh the conversation before trying again.",
		);
		expect(f.fetch).toHaveBeenCalledTimes(2);
		vi.useFakeTimers();
		const original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.post(f.input)).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(15000);
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});
});
