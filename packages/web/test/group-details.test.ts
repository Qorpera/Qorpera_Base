import { afterEach, describe, expect, it, vi } from "vitest";
import { readGroupChatDetails } from "../src/cloud/group-details.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { deferred, fixture, id, profileA, session, settle, staff, userA } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());

function setup() {
	const f = fixture();
	const scope = new AbortController();
	const group = { ...session, executionScope: { roomId: id(79) } };
	const room = {
		version: 1,
		roomId: id(79),
		sessionId: session.sessionId,
		environmentId: session.environmentId,
		name: "Planning",
		purpose: "Plan launch",
		status: "active",
		members: [
			{ kind: "staff_agent", id: staff.id },
			{ kind: "member", id: userA.id },
		],
	};
	const rpc = vi.mocked(f.cloud.rpc).mockResolvedValue([room]);
	return { ...f, scope, group, room, rpc, read: () => readGroupChatDetails(f.cloud, group, scope.signal) };
}

describe("group detail read boundary", () => {
	it("reads the exact group's details and ignores other rooms in the company", async () => {
		const f = setup();
		f.rpc.mockResolvedValueOnce([{ ...f.room, roomId: id(80), name: "Another group", members: [] }, f.room]);
		await expect(f.read()).resolves.toEqual({
			roomId: f.room.roomId,
			sessionId: f.room.sessionId,
			environmentId: f.room.environmentId,
			version: 1,
			name: "Planning",
			purpose: "Plan launch",
			status: "active",
			members: f.room.members,
		});
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith("qorpera_list_company_rooms", {
			p_profile_id: profileA.profileId,
		});
	});

	it.each(["missing", "room", "session", "environment", "duplicate"] as const)(
		"rejects %s room identity instead of returning participants",
		async (mismatch) => {
			const f = setup();
			if (mismatch === "missing") f.rpc.mockResolvedValueOnce([]);
			else if (mismatch === "duplicate") f.rpc.mockResolvedValueOnce([f.room, f.room]);
			else if (mismatch === "room") f.room.roomId = id(99);
			else if (mismatch === "session") f.room.sessionId = id(99);
			else f.room.environmentId = id(99);
			await expect(f.read()).rejects.toThrow(
				mismatch === "duplicate" ? CloudShapeError : "This group chat is no longer available.",
			);
		},
	);

	it.each([
		{ label: "unknown kind", members: [{ kind: "human", id: userA.id }] },
		{ label: "invalid id", members: [{ kind: "member", id: "not-a-uuid" }] },
		{ label: "missing id", members: [{ kind: "staff_agent" }] },
		{ label: "null participant", members: [null] },
		{ label: "non-array members", members: { kind: "member", id: userA.id } },
		{
			label: "duplicate identity",
			members: [
				{ kind: "member", id: userA.id },
				{ kind: "member", id: userA.id },
			],
		},
	])("rejects $label", async ({ members }) => {
		const f = setup();
		f.rpc.mockResolvedValueOnce([{ ...f.room, members }]);
		await expect(f.read()).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("allows archived groups with an empty purpose and no remaining participants", async () => {
		const f = setup();
		f.rpc.mockResolvedValueOnce([{ ...f.room, status: "archived", purpose: "", members: [] }]);
		await expect(f.read()).resolves.toEqual({ ...f.room, purpose: "", status: "archived", members: [] });
	});

	it("ignores an unrelated archived room that has never had a conversation", async () => {
		const f = setup();
		f.rpc.mockResolvedValueOnce([{ ...f.room, roomId: id(88), sessionId: null, status: "archived" }, f.room]);
		await expect(f.read()).resolves.toEqual(f.room);
	});

	it("does not dispatch a read after its scope is cancelled", async () => {
		const f = setup();
		const reason = new Error("Conversation closed");
		f.scope.abort(reason);
		await expect(f.read()).rejects.toBe(reason);
		expect(f.rpc).not.toHaveBeenCalled();
	});

	it("rejects a pending read on cancellation even when the server responds later", async () => {
		const f = setup();
		const pending = deferred<unknown>();
		f.rpc.mockReturnValueOnce(pending.promise);
		const read = f.read();
		await settle();
		expect(f.rpc).toHaveBeenCalledTimes(1);
		const reason = new Error("Conversation changed");
		const rejected = expect(read).rejects.toBe(reason);
		f.scope.abort(reason);
		await rejected;
		pending.resolve([f.room]);
		await settle();
		await expect(read).rejects.toBe(reason);
	});
});
