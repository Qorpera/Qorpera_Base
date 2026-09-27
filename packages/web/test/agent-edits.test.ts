// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { editsFor } from "../src/app/views/agent-edits.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { deferred, fixture, profileA, settle, staff, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

function setup(updateAgent: NonNullable<WorkspaceActions["updateAgent"]>) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], loading: false });
	const scope = new AbortController();
	cleanup.push(() => {
		scope.abort();
		company.stop();
	});
	const reopen = () => editsFor(company, staff, { updateAgent }, scope.signal);
	const observe = (version: number, displayName: string) =>
		company.store.set({ staff: [{ ...staff, version, displayName }] });
	return { ...f, company, edits: reopen(), reopen, observe };
}

describe("agent edit reconciliation", () => {
	it.each([
		["stale", false],
		["failed", false],
		["stale", true],
		["failed", true],
	] as const)(
		"retires accepted edits after a %s refresh, skipped accepted projection: %s",
		async (refresh, skipped) => {
			const acceptedVersion = staff.version + 4;
			const update = vi.fn<NonNullable<WorkspaceActions["updateAgent"]>>(async () => acceptedVersion);
			const f = setup(update);
			if (refresh === "failed") vi.mocked(f.api.listStaff).mockRejectedValueOnce(new Error("offline"));
			f.edits.change({ displayName: "Accepted name" });
			await settle();
			expect(f.edits.store.get().status).toBe("Saved");
			// A revision newer than the starting roster can still precede our write.
			f.observe(acceptedVersion - 1, "Earlier remote name");
			await settle();
			expect(f.reopen().current().displayName).toBe("Accepted name");
			if (!skipped) {
				f.observe(acceptedVersion, "Accepted name");
				await settle();
			}
			f.observe(acceptedVersion + 1, "Later remote name");
			await settle();
			expect(f.reopen().current().displayName).toBe("Later remote name");
			f.reopen().change({ role: "Only change the title" });
			await settle();
			expect(update.mock.calls[1]![1]).toMatchObject({
				displayName: "Later remote name",
				role: "Only change the title",
			});
		},
	);

	it("keeps a newer same-field edit when the earlier write and roster settle, including after failure", async () => {
		const first = deferred<number>();
		const second = deferred<number>();
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateAgent"]>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise)
			.mockResolvedValue(staff.version + 4);
		const f = setup(update);
		f.edits.change({ displayName: "First name" });
		f.reopen().change({ displayName: "Newer draft" });
		f.observe(staff.version + 1, "First name");
		await settle();
		first.resolve(staff.version + 1);
		await settle();
		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls[1]![1].displayName).toBe("Newer draft");
		second.reject(new Error("lost reply"));
		await settle();
		f.observe(staff.version + 3, "Remote after failure");
		await settle();
		expect(f.reopen().current().displayName).toBe("Newer draft");
		expect(f.reopen().store.get().failed).toBe(true);
		expect(update).toHaveBeenCalledTimes(2);
		await f.reopen().save();
		expect(update.mock.calls[2]![1].displayName).toBe("Newer draft");
	});

	it("retires an accepted field while keeping a different failed field for explicit retry", async () => {
		const second = deferred<number>();
		const update = vi
			.fn<NonNullable<WorkspaceActions["updateAgent"]>>()
			.mockResolvedValueOnce(staff.version + 1)
			.mockReturnValueOnce(second.promise)
			.mockResolvedValue(staff.version + 3);
		const f = setup(update);
		f.edits.change({ displayName: "Accepted name" });
		await settle();
		f.edits.change({ role: "Unsaved title" });
		f.observe(staff.version + 1, "Accepted name");
		await settle();
		second.reject(new Error("offline"));
		await settle();
		f.observe(staff.version + 2, "New remote name");
		await settle();
		expect(f.reopen().current()).toMatchObject({ displayName: "New remote name", role: "Unsaved title" });
		expect(update).toHaveBeenCalledTimes(2);
		await f.reopen().save();
		expect(update.mock.calls[2]![1]).toMatchObject({ displayName: "New remote name", role: "Unsaved title" });
	});
});
