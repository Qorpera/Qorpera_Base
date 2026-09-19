import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { GroupChatDetails } from "../src/cloud/group-details.ts";
import { deferred, fixture, id, profileA, profileB, session, settle, staff, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
});

function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => company.stop());
	const group = { ...session, executionScope: { roomId: id(79) } };
	const room: GroupChatDetails = {
		roomId: id(79),
		sessionId: session.sessionId,
		environmentId: session.environmentId,
		version: 4,
		name: "Planning",
		purpose: "Plan launch",
		status: "active",
		members: [
			{ kind: "staff_agent", id: staff.id },
			{ kind: "member", id: userA.id },
		],
	};
	company.store.set({ team, sessions: [group], staff: [staff], loading: false });
	const rpc = vi.mocked(f.cloud.rpc).mockResolvedValue([room]);
	const read = () => company.groupDetails(session.sessionId, new AbortController().signal);
	return { ...f, company, group, room, rpc, read };
}

describe("company group metadata", () => {
	it("keeps newer cached metadata when an older panel read finishes later", async () => {
		const f = setup();
		const earlier = deferred<unknown>();
		f.rpc.mockReturnValueOnce(earlier.promise);
		const panel = f.read();
		await settle();
		const updated = { ...f.room, version: 5, name: "Updated group", members: [] };
		f.rpc.mockResolvedValueOnce([updated]);
		await f.company.refreshGroups();
		earlier.resolve([f.room]);
		await expect(panel).resolves.toEqual(updated);
		expect(f.company.store.get().groups?.[f.room.roomId]).toEqual(updated);
	});

	it("keeps newer panel metadata when an older company refresh finishes later", async () => {
		const f = setup();
		const earlier = deferred<unknown>();
		f.rpc.mockReturnValueOnce(earlier.promise);
		const refreshing = f.company.refreshGroups();
		await settle();
		const updated = { ...f.room, version: 5, name: "Updated group", members: [] };
		f.rpc.mockResolvedValueOnce([updated]);
		await f.read();
		earlier.resolve([f.room]);
		await refreshing;
		expect(f.company.store.get().groups?.[f.room.roomId]).toEqual(updated);
	});

	it.each(["roomId", "sessionId", "environmentId"] as const)(
		"does not preserve a higher cached revision with a mismatched %s",
		async (field) => {
			const f = setup();
			const cached = { ...f.room, version: 99, [field]: id(98) };
			f.company.store.set({ groups: { [f.room.roomId]: cached } });
			await expect(f.read()).resolves.toEqual(f.room);
			f.company.store.set({ groups: { [f.room.roomId]: cached } });
			await f.company.refreshGroups();
			expect(f.company.store.get().groups?.[f.room.roomId]).toEqual(f.room);
		},
	);

	it.each(["team", "access", "session-company", "session-environment"] as const)(
		"does not publish a pending metadata response after %s changes",
		async (change) => {
			const f = setup();
			const pending = deferred<unknown>();
			f.rpc.mockReturnValueOnce(pending.promise);
			const reading = f.company.refreshGroups();
			await settle();
			if (change === "team") f.company.store.set({ team: { ...team, profileId: profileB.profileId } });
			else if (change === "access") f.company.store.set({ accessLost: true });
			else if (change === "session-company")
				f.company.store.set({ sessions: [{ ...f.group, profileId: profileB.profileId }] });
			else f.company.store.set({ sessions: [{ ...f.group, environmentId: profileB.environmentId }] });
			pending.resolve([f.room]);
			await reading;
			expect(f.company.store.get().groups?.[f.room.roomId]).toBeUndefined();
			expect(f.company.groupAgents(session.sessionId)).toEqual([]);
		},
	);

	it("does not read group metadata for a team from another company", async () => {
		const f = setup();
		f.company.store.set({ team: { ...team, profileId: profileB.profileId } });
		await f.company.refreshGroups();
		expect(f.rpc).not.toHaveBeenCalled();
	});

	it("uses only active canonical agent members from the current company", async () => {
		const f = setup();
		const inactive = { ...staff, id: id(90), employmentStatus: "archived" as const };
		const foreign = { ...staff, id: id(91), profileId: profileB.profileId };
		f.room.members.push(
			{ kind: "staff_agent", id: inactive.id },
			{ kind: "staff_agent", id: foreign.id },
			{ kind: "staff_agent", id: id(92) },
		);
		f.company.store.set({ staff: [staff, inactive, foreign, { ...staff, id: id(93) }] });
		await f.company.refreshGroups();
		expect(f.company.groupAgents(session.sessionId)).toEqual([staff]);
	});

	it.each(["roomId", "sessionId", "environmentId"] as const)(
		"does not render cached members with a mismatched %s",
		(field) => {
			const f = setup();
			f.company.store.set({ groups: { [f.room.roomId]: { ...f.room, [field]: id(98) } } });
			expect(f.company.groupAgents(session.sessionId)).toEqual([]);
		},
	);
});
