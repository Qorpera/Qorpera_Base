// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { editsFor } from "../src/app/views/agent-edits.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { deferred, fixture, profileA, settle, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
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

describe("a figure being saved", () => {
	// The palette's real hex, as the roster's `qorpera-<colour>` names resolve to them.
	const gold = "#fcb51b";
	const coral = "#ff365e";
	const heartShade = "#ff2994";

	function railSetup(update: NonNullable<WorkspaceActions["updateAgent"]>) {
		const mount = stubFigureMotion();
		vi.stubGlobal("QORPERA_MOTION_MODEL", { avatars: [{ id: "heart", color: heartShade }] });
		vi.stubGlobal("QORPERA_AVATAR_APPEARANCE", {
			palette: [
				{ name: "Gold", color: gold },
				{ name: "Coral", color: coral },
			],
		});
		const f = setup(update);
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const rail = document.createElement("aside");
		document.body.append(rail);
		const drawn = () => {
			mount.mockClear();
			renderRail(rail, f.company, {
				profiles: [profileA],
				user: userA,
				auth,
				invitations: 0,
				route: { name: "company", profileId: profileA.profileId, section: "file" },
				openSettings() {},
				openFeedback() {},
				openFriends() {},
			});
			return mount.mock.calls.map(([, figure, color]) => ({ figure, color }));
		};
		return { ...f, drawn };
	}

	it.each([
		["a palette colour, saved as its name", gold, "qorpera-gold"],
		["the figure's own shade, saved as no colour", heartShade, ""],
	])("shows %s in the rail at once and keeps the row once the roster has it", async (_case, picked, stored) => {
		const write = deferred<number>();
		const f = railSetup(vi.fn<NonNullable<WorkspaceActions["updateAgent"]>>().mockReturnValueOnce(write.promise));
		f.company.store.set({
			staff: [{ ...staff, appearance: { color: "qorpera-coral", shape: "circle", creature: "crown" } }],
		});
		expect(f.drawn()).toEqual([{ figure: "crown", color: coral }]);

		f.edits.change({ figure: "heart", color: picked });
		await settle();
		expect(f.company.store.get().looks?.[staff.id]).toEqual({ figure: "heart", color: picked });
		expect(f.drawn()).toEqual([{ figure: "heart", color: picked }]);

		const saved = {
			...staff,
			version: staff.version + 1,
			appearance: { color: stored, shape: "circle", creature: "heart" },
		};
		vi.mocked(f.api.listStaff).mockResolvedValue([saved]);
		write.resolve(saved.version);
		await settle();
		expect(f.edits.store.get().status).toBe("Saved");
		expect(f.company.store.get().looks?.[staff.id]).toBeUndefined();
		// The saved roster draws the same row, so the row stays and its figure is not built again.
		expect(f.drawn()).toEqual([]);
	});

	it("leaves the rail as saved when the save fails, and when the card's edits end", async () => {
		const f = railSetup(
			vi
				.fn<NonNullable<WorkspaceActions["updateAgent"]>>()
				.mockRejectedValueOnce(new Error("offline"))
				.mockReturnValue(new Promise(() => {})),
		);
		f.company.store.set({
			staff: [{ ...staff, appearance: { color: "qorpera-coral", shape: "circle", creature: "crown" } }],
		});
		f.edits.change({ color: gold });
		await settle();
		expect(f.edits.store.get().failed).toBe(true);
		expect(f.company.store.get().looks?.[staff.id]).toBeUndefined();
		expect(f.drawn()).toEqual([{ figure: "crown", color: coral }]);

		void f.edits.save();
		await settle();
		expect(f.company.store.get().looks?.[staff.id]).toEqual({ figure: "crown", color: gold });
		expect(f.drawn()).toEqual([{ figure: "crown", color: gold }]);
		f.edits.dispose();
		await settle();
		expect(f.company.store.get().looks?.[staff.id]).toBeUndefined();
		expect(f.drawn()).toEqual([{ figure: "crown", color: coral }]);
	});
});
