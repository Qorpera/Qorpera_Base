// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { groupEditsFor } from "../src/app/views/group-edits.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import type { GroupChatDetails } from "../src/cloud/group-details.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const room: GroupChatDetails = {
	roomId: id(20),
	sessionId: session.sessionId,
	environmentId: profileA.environmentId,
	version: 3,
	name: "Research",
	subtitle: "Weekly review",
	purpose: "Share research findings.",
	status: "active",
	members: [{ kind: "staff_agent", id: staff.id }],
};
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

function setup(updateGroup: NonNullable<WorkspaceActions["updateGroup"]>) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team,
		staff: [staff],
		sessions: [{ ...session, executionScope: { roomId: room.roomId } }],
		groups: { [room.roomId]: room },
		loading: false,
	});
	vi.spyOn(company, "refreshSessions").mockResolvedValue();
	vi.spyOn(company, "groupDetails").mockImplementation(async () => company.store.get().groups![room.roomId]!);
	const scope = new AbortController();
	cleanup.push(() => {
		scope.abort();
		company.stop();
	});
	const reopen = () => groupEditsFor(company, room, { updateGroup }, scope.signal);
	const observe = (change: Partial<GroupChatDetails>) =>
		company.store.set({ groups: { [room.roomId]: { ...room, ...change } } });
	return { company, scope, edits: reopen(), reopen, observe };
}

describe("group inline edit writer", () => {
	it("serializes field edits across reopening and advances the observed revision", async () => {
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateGroup"]>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const f = setup(update);
		f.edits.change({ name: "New title" });
		expect(f.reopen()).toBe(f.edits);
		f.reopen().change({ subtitle: "New subtitle", purpose: "New description" });
		expect(update).toHaveBeenCalledTimes(1);
		first.resolve(true);
		await settle();
		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls[1]![1]).toMatchObject({ version: room.version + 1, name: "New title" });
		expect(update.mock.calls[1]![2]).toMatchObject({
			name: "New title",
			subtitle: "New subtitle",
			purpose: "New description",
		});
		second.resolve(true);
		await settle();
		expect(f.reopen().current()).toMatchObject({ name: "New title", purpose: "New description" });
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("retries the exact uncertain snapshot before submitting newer changes", async () => {
		const first = deferred<boolean>();
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateGroup"]>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(true);
		const f = setup(update);
		f.edits.change({ name: "First title" });
		f.edits.change({ name: "Latest title" });
		first.reject(new Error("lost apply response"));
		await settle();
		f.observe({ version: room.version + 1, name: "First title" });
		await settle();
		f.reopen().change({ subtitle: "Queued subtitle" });
		expect(update).toHaveBeenCalledTimes(1);
		expect(f.edits.store.get().failed).toBe(true);
		await f.edits.save();
		expect(update).toHaveBeenCalledTimes(3);
		expect(update.mock.calls[1]![1]).toEqual(update.mock.calls[0]![1]);
		expect(update.mock.calls[1]![2]).toEqual(update.mock.calls[0]![2]);
		expect(update.mock.calls[2]![1].version).toBe(room.version + 1);
		expect(update.mock.calls[2]![2]).toMatchObject({ name: "Latest title", subtitle: "Queued subtitle" });
	});

	it("accepts newer canonical fields while retaining a pending same-field edit", async () => {
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateGroup"]>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const f = setup(update);
		f.edits.change({ name: "Accepted title" });
		f.edits.change({ name: "Pending title" });
		f.observe({ version: room.version + 2, name: "Remote title", purpose: "Remote description" });
		await settle();
		first.resolve(true);
		await settle();
		expect(update.mock.calls[1]![1].version).toBe(room.version + 2);
		expect(update.mock.calls[1]![2]).toMatchObject({ name: "Pending title", purpose: "Remote description" });
		second.resolve(true);
		await settle();
		f.observe({ version: room.version + 4, name: "Later title" });
		await settle();
		expect(f.reopen().current().name).toBe("Later title");
	});

	it.each(["role", "archive", "navigation", "access"] as const)(
		"aborts and discards queued edits after %s changes",
		async (kind) => {
			const pending = deferred<boolean>();
			const update = vi.fn<NonNullable<WorkspaceActions["updateGroup"]>>().mockReturnValue(pending.promise);
			const f = setup(update);
			f.edits.change({ name: "In flight" });
			f.edits.change({ name: "Queued" });
			if (kind === "role")
				f.company.store.set({
					team: { ...team, role: "contributor", capabilities: { ...team.capabilities, authorize: false } },
				});
			else if (kind === "archive") f.observe({ version: room.version + 1, status: "archived" });
			else if (kind === "navigation") f.scope.abort();
			else f.company.store.set({ accessLost: true, team: undefined });
			await settle();
			expect(update.mock.calls[0]![3].aborted).toBe(true);
			expect(f.edits.canWrite()).toBe(false);
			pending.resolve(true);
			await settle();
			await f.edits.save();
			expect(update).toHaveBeenCalledTimes(1);
			expect(f.edits.current().name).toBe(room.name);
		},
	);

	it("keeps the observed revision when the updater wrote nothing", async () => {
		const update = vi.fn<NonNullable<WorkspaceActions["updateGroup"]>>().mockResolvedValue(false);
		const f = setup(update);
		f.edits.change({ name: "Already in the file" });
		await settle();
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
		// The room's details at its own revision are still current: discarding reads them, and the next write names it.
		await f.edits.discardChanges();
		expect(f.edits.store.get()).toEqual({ status: "", failed: false });
		f.edits.change({ name: "Next title" });
		await settle();
		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls[1]![1].version).toBe(room.version);
	});

	it("retries a failed refresh without writing the accepted changes twice", async () => {
		const update = vi.fn<NonNullable<WorkspaceActions["updateGroup"]>>().mockResolvedValue(true);
		const f = setup(update);
		vi.mocked(f.company.groupDetails).mockRejectedValueOnce(new Error("offline"));
		f.edits.change({ name: "Saved title" });
		await settle();
		expect(f.edits.store.get().failed).toBe(true);
		await f.reopen().save();
		expect(update).toHaveBeenCalledTimes(1);
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("discards an invalid snapshot and reloads the revision before accepting a fresh edit", async () => {
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateGroup"]>>()
			.mockRejectedValueOnce(new Error("Choose at least two agents"))
			.mockResolvedValue(true);
		const f = setup(update);
		f.edits.change({ members: [] });
		await settle();
		f.edits.change({ name: "Abandoned queued name" });
		const fresh = deferred<GroupChatDetails>();
		vi.mocked(f.company.groupDetails).mockReturnValueOnce(fresh.promise);
		const reset = f.edits.discardChanges();
		await settle();
		expect(f.edits.canWrite()).toBe(false);
		f.edits.change({ name: "Ignored while reloading" });
		await f.edits.save();
		expect(update).toHaveBeenCalledTimes(1);
		fresh.resolve({ ...room, version: room.version + 2, purpose: "Canonical description" });
		await reset;
		expect(f.edits.canWrite()).toBe(true);
		expect(f.edits.current()).toMatchObject({ name: room.name, members: room.members });
		f.edits.change({ name: "Valid fresh name" });
		await settle();
		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls[1]![1].version).toBe(room.version + 2);
		expect(update.mock.calls[1]![2]).toMatchObject({
			name: "Valid fresh name",
			purpose: "Canonical description",
			members: room.members,
		});
	});

	it("keeps fresh writes blocked until a failed discard refresh succeeds", async () => {
		const update = vi.fn<NonNullable<WorkspaceActions["updateGroup"]>>().mockRejectedValue(new Error("conflict"));
		const f = setup(update);
		f.edits.change({ name: "Conflicting name" });
		await settle();
		vi.mocked(f.company.groupDetails).mockRejectedValueOnce(new Error("offline"));
		await f.edits.discardChanges();
		expect(f.edits.canWrite()).toBe(false);
		expect(f.edits.store.get().failed).toBe(true);
		f.edits.change({ name: "Do not save against stale details" });
		await f.edits.save();
		expect(f.edits.canWrite()).toBe(true);
		expect(f.edits.current().name).toBe(room.name);
		expect(update).toHaveBeenCalledTimes(1);
	});
});
