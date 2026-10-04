// @vitest-environment jsdom
import { type GroupFile, parseCompanyStateFile, writeGroupFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import {
	createGroupDeleter,
	createGroupUpdater,
	GroupParticipantsError,
	GroupUpdateNotWrittenError,
} from "../src/app/update-group.ts";
import { GroupEdits } from "../src/app/views/group-edits.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import type { GroupChatDetails, GroupChatDraft } from "../src/cloud/group-details.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

/* A group chat's details on the company folder (P34a-2): agents/groups/<handle>/group.md, rewritten (only what the
 * member changed) and deleted with its folder through the member commit route. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
});

const FOLDER = "agents/groups/original-group";
const PATH = `${FOLDER}/group.md`;

function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => company.stop());
	const other = { ...staff, id: id(20), displayName: "Other agent" };
	const third = { ...staff, id: id(21), displayName: "Third agent" };
	const group = { ...session, executionScope: { roomId: id(79) } };
	company.store.set({
		team: {
			...team,
			members: [
				{ userId: userA.id, email: userA.email!, displayName: "Owner", role: "owner", joinedAt: timestamp },
				{ userId: userB.id, email: userB.email!, displayName: "Member", role: "contributor", joinedAt: timestamp },
			],
		},
		staff: [staff, other, third],
		sessions: [group],
		loading: false,
	});
	const observed: GroupChatDetails = {
		roomId: id(79),
		sessionId: session.sessionId,
		environmentId: profileA.environmentId,
		version: 4,
		name: "Original group",
		purpose: "Original description",
		status: "active",
		members: [
			{ kind: "member", id: userA.id },
			{ kind: "staff_agent", id: staff.id },
			{ kind: "staff_agent", id: other.id },
		],
	};
	const fake = folderFake();
	fake.put(
		PATH,
		writeGroupFile(
			{
				id: observed.roomId,
				name: observed.name,
				subtitle: null,
				agents: [staff.id, other.id],
				people: [userA.id],
				purpose: observed.purpose,
			},
			new Map([
				[staff.id, staff.displayName],
				[other.id, other.displayName],
			]),
		),
	);
	const folder = vi.fn((_signal: AbortSignal) => fake.folder);
	const current = vi.fn();
	const update = createGroupUpdater({ company, folder, current });
	const draft: GroupChatDraft = {
		name: "Planning",
		purpose: "Plan the launch",
		members: [observed.members[0]!, observed.members[1]!, { kind: "staff_agent", id: third.id }],
	};
	const signal = new AbortController().signal;
	return { company, other, third, group, observed, fake, folder, current, update, draft, signal };
}

function groupFile(fake: ReturnType<typeof folderFake>): GroupFile {
	const parsed = parseCompanyStateFile(PATH, fake.text(PATH) ?? "");
	if (!parsed?.ok || parsed.file.kind !== "group") throw new Error("group.md does not parse");
	return parsed.file;
}

/** Inline edits through the real updater; the room's details are read back from group.md. */
function setupInlineEdits() {
	const f = setup();
	const scope = new AbortController();
	cleanup.push(() => scope.abort());
	vi.spyOn(f.company, "refreshSessions").mockResolvedValue();
	vi.spyOn(f.company, "groupDetails").mockImplementation(async () => {
		const file = groupFile(f.fake);
		return {
			...f.observed,
			// Each change set that reached the folder raised the room's version by one.
			version: f.observed.version + f.fake.commits.length,
			name: file.name,
			...(file.subtitle !== null ? { subtitle: file.subtitle } : {}),
			purpose: file.purpose,
			members: [
				...file.people.map((person) => ({ kind: "member" as const, id: person })),
				...file.agents.map((agent) => ({ kind: "staff_agent" as const, id: agent })),
			],
		};
	});
	const update = vi.fn(f.update);
	const edits = new GroupEdits(f.company, f.observed, { updateGroup: update }, scope.signal);
	return { ...f, update, edits };
}

describe("inline group edits through the real updater", () => {
	it("saves a corrected multibyte description and keeps another pending field", async () => {
		const f = setupInlineEdits();
		f.edits.change({ purpose: "界".repeat(12_000) });
		f.edits.change({ subtitle: "Keep this subtitle" });
		await settle();
		expect(f.edits.store.get()).toEqual({
			failed: true,
			status: "The group chat changes could not be saved: what the group is for is longer than 32768 bytes.",
		});
		expect(f.fake.commits).toHaveLength(0);
		f.edits.change({ purpose: "Corrected short description" });
		expect(f.update).toHaveBeenCalledOnce();
		await f.edits.save();
		expect(f.fake.commits).toHaveLength(1);
		expect(groupFile(f.fake)).toMatchObject({
			purpose: "Corrected short description",
			subtitle: "Keep this subtitle",
			name: "Original group",
		});
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("accepts corrected participants after validation fails before a write", async () => {
		const f = setupInlineEdits();
		f.edits.change({ members: f.observed.members.slice(0, 2) });
		await settle();
		expect(f.edits.store.get().status).toContain("Choose at least two active agents");
		expect(f.folder).not.toHaveBeenCalled();
		f.edits.change({ members: f.draft.members });
		await f.edits.save();
		expect(f.fake.commits).toHaveLength(1);
		expect(groupFile(f.fake)).toMatchObject({ agents: [staff.id, f.third.id], people: [userA.id] });
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("retains an uncertain write through a retry read failure before applying newer edits", async () => {
		const f = setupInlineEdits();
		f.fake.loseAnswer();
		f.edits.change({ name: "First title" });
		await settle();
		expect(f.edits.store.get().failed).toBe(true);
		expect(groupFile(f.fake).name).toBe("First title");
		f.edits.change({ name: "Newer title", subtitle: "Queued subtitle" });
		f.fake.folder.stateFolders.mockRejectedValueOnce(new Error("Temporary read failure"));
		await f.edits.save();
		expect(f.edits.store.get().failed).toBe(true);
		expect(f.fake.commits).toHaveLength(1);
		await f.edits.save();
		expect(f.update).toHaveBeenCalledTimes(4);
		for (const retry of f.update.mock.calls.slice(1, 3)) {
			expect(retry[1]).toEqual(f.update.mock.calls[0]![1]);
			expect(retry[2]).toEqual(f.update.mock.calls[0]![2]);
		}
		expect(f.update.mock.calls[3]![1].version).toBe(f.observed.version + 1);
		// The retry found its write in the file and sent nothing; the newer edits are the second change set.
		expect(f.fake.commits).toHaveLength(2);
		expect(groupFile(f.fake)).toMatchObject({ name: "Newer title", subtitle: "Queued subtitle" });
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});
});

describe("editing group details", () => {
	it("writes name, description and agents to group.md, naming the version it read", async () => {
		const f = setup();
		const version = f.fake.version(PATH);
		const before = f.fake.text(PATH)!;
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).resolves.toBe(true);
		expect(f.folder).toHaveBeenCalledOnce();
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.commits[0]?.operationKey).toMatch(
			new RegExp(`^web:group-update:${f.observed.roomId}:[0-9a-f-]{36}$`),
		);
		expect(f.fake.commits[0]?.units).toEqual([
			{ op: "write", path: PATH, text: expect.any(String), expectedVersion: version },
		]);
		expect(groupFile(f.fake)).toEqual({
			kind: "group",
			id: f.observed.roomId,
			name: "Planning",
			subtitle: null,
			agents: [staff.id, f.third.id],
			people: [userA.id],
			purpose: "Plan the launch",
		});
		// The people did not change: their lines, notes included, are kept as they were.
		const people = before.slice(before.indexOf("people:"), before.indexOf("\n---"));
		expect(f.fake.text(PATH)).toContain(people);
	});

	it("writes only what the member changed, so a change made meanwhile survives", async () => {
		const f = setup();
		f.fake.put(PATH, f.fake.text(PATH)!.replace("name: Original group", "name: Renamed elsewhere"));
		await f.update(
			session.sessionId,
			f.observed,
			{ ...f.draft, name: f.observed.name, members: f.observed.members },
			f.signal,
		);
		expect(groupFile(f.fake)).toMatchObject({
			name: "Renamed elsewhere",
			purpose: "Plan the launch",
			agents: [staff.id, f.other.id],
		});
	});

	it("writes the people and agents of a changed membership", async () => {
		const f = setup();
		await f.update(
			session.sessionId,
			f.observed,
			{
				...f.draft,
				members: [
					{ kind: "staff_agent", id: f.third.id },
					{ kind: "member", id: userA.id },
					{ kind: "member", id: userB.id },
					{ kind: "staff_agent", id: staff.id },
				],
			},
			f.signal,
		);
		expect(groupFile(f.fake)).toMatchObject({ agents: [f.third.id, staff.id], people: [userA.id, userB.id] });
	});

	it("writes only the participants list the member changed, so a change made meanwhile to the other survives", async () => {
		const f = setup();
		// Another admin added an agent meanwhile; this member adds a person only.
		f.fake.put(
			PATH,
			writeGroupFile({
				id: f.observed.roomId,
				name: f.observed.name,
				subtitle: null,
				agents: [staff.id, f.other.id, f.third.id],
				people: [userA.id],
				purpose: f.observed.purpose,
			}),
		);
		const { name, purpose, members } = f.observed;
		await f.update(
			session.sessionId,
			f.observed,
			{ name, purpose, members: [...members, { kind: "member", id: userB.id }] },
			f.signal,
		);
		expect(groupFile(f.fake)).toMatchObject({
			agents: [staff.id, f.other.id, f.third.id],
			people: [userA.id, userB.id],
		});
	});

	it.each(["  Launch coordination  ", ""])("writes and clears the subtitle (%j)", async (subtitle) => {
		const f = setup();
		f.fake.put(PATH, f.fake.text(PATH)!.replace("name: Original group", "name: Original group\nsubtitle: Old"));
		await f.update(session.sessionId, { ...f.observed, subtitle: "Old" }, { ...f.draft, subtitle }, f.signal);
		expect(groupFile(f.fake).subtitle).toBe(subtitle.trim());
	});

	it("writes nothing when the file already says it all", async () => {
		const f = setup();
		const { name, purpose, members } = f.observed;
		await expect(f.update(session.sessionId, f.observed, { name, purpose, members }, f.signal)).resolves.toBe(false);
		// Someone else made the same change meanwhile.
		f.fake.put(PATH, f.fake.text(PATH)!.replace("name: Original group", "name: Planning"));
		await expect(
			f.update(session.sessionId, f.observed, { name: "Planning", purpose, members }, f.signal),
		).resolves.toBe(false);
		expect(f.fake.commits).toHaveLength(0);
	});

	it("reads again and rewrites when group.md changed between the read and the write", async () => {
		const f = setup();
		const readFile = f.fake.folder.readFile.getMockImplementation()!;
		f.fake.folder.readFile.mockImplementationOnce(async (...args) => {
			const bytes = await readFile(...args);
			f.fake.put(PATH, f.fake.text(PATH)!.replace("name: Original group", "name: Original group\nsubtitle: New"));
			return bytes;
		});
		await f.update(session.sessionId, f.observed, f.draft, f.signal);
		expect(f.fake.commits).toHaveLength(2);
		expect(groupFile(f.fake)).toMatchObject({ name: "Planning", subtitle: "New", purpose: "Plan the launch" });
	});

	it("finds a lost answer's write in the file on the next try, and sends nothing", async () => {
		const f = setup();
		f.fake.loseAnswer();
		const lost = await f.update(session.sessionId, f.observed, f.draft, f.signal).catch((error: unknown) => error);
		// The write was sent: the failure is uncertain, never "not written".
		expect(lost).toBeInstanceOf(TypeError);
		expect(lost).not.toBeInstanceOf(GroupUpdateNotWrittenError);
		await f.update(session.sessionId, f.observed, f.draft, f.signal);
		expect(f.fake.commits).toHaveLength(1);
		expect(groupFile(f.fake)).toMatchObject({ name: "Planning", agents: [staff.id, f.third.id] });
	});

	it("reports a refused write as not written, with the hook's problems", async () => {
		const f = setup();
		f.fake.answer("refused", "hook", ["Agent 3 is not active"]);
		const error = await f.update(session.sessionId, f.observed, f.draft, f.signal).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GroupUpdateNotWrittenError);
		expect((error as Error).message).toBe("The group chat changes could not be saved: Agent 3 is not active.");
		expect((error as Error).cause).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(groupFile(f.fake).name).toBe("Original group");
	});

	it("says the group chat is gone when its folder is, without writing", async () => {
		const f = setup();
		f.fake.remove(FOLDER);
		const error = await f.update(session.sessionId, f.observed, f.draft, f.signal).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GroupUpdateNotWrittenError);
		expect((error as Error).message).toBe("This group chat is no longer available.");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("refuses a group.md of another room or kind under the room's path", async () => {
		const f = setup();
		vi.mocked(f.fake.folder.stateFolders).mockResolvedValueOnce({
			agents: [],
			groups: [{ roomId: f.observed.roomId, file: "agents/groups/other/group.md" }],
			routines: [],
		});
		f.fake.put(
			"agents/groups/other/group.md",
			writeGroupFile({
				id: id(80),
				name: "Other",
				subtitle: null,
				agents: [staff.id, f.other.id],
				people: [],
				purpose: "Another room.",
			}),
		);
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("no longer available");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("rejects inactive agents, missing people, duplicate participants and fewer than two agents before any read", async () => {
		const f = setup();
		const invalid: GroupChatDraft["members"][] = [
			[...f.draft.members, { kind: "member", id: id(80) }],
			[...f.draft.members, { kind: "staff_agent", id: id(81) }],
			[...f.draft.members, f.draft.members[1]!],
			f.draft.members.slice(0, 2),
		];
		for (const members of invalid) {
			const error = await f
				.update(session.sessionId, f.observed, { ...f.draft, members }, f.signal)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(GroupUpdateNotWrittenError);
			expect((error as Error).message).toContain("active agents");
			expect((error as Error).cause).toBeInstanceOf(GroupParticipantsError);
		}
		f.company.store.set({ staff: [staff, f.other, { ...f.third, employmentStatus: "archived" }] });
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("active agents");
		expect(f.folder).not.toHaveBeenCalled();
	});

	it("requires current owner or admin authority and an unbound open session", async () => {
		const f = setup();
		f.company.store.set({ team: { ...f.company.store.get().team!, role: "contributor" } });
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("owner or admin");
		f.company.store.set({
			team: { ...f.company.store.get().team!, role: "owner" },
			sessions: [{ ...f.group, staffAgentId: staff.id }],
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("no longer available");
		expect(f.folder).not.toHaveBeenCalled();
	});

	it("checks access again after reading and before the write", async () => {
		const f = setup();
		const readFile = f.fake.folder.readFile.getMockImplementation()!;
		f.fake.folder.readFile.mockImplementationOnce(async (...args) => {
			f.company.store.set({ accessLost: true });
			return readFile(...args);
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("owner or admin");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("checks the participants again after the write was answered", async () => {
		const f = setup();
		const commit = f.fake.folder.commit.getMockImplementation()!;
		f.fake.folder.commit.mockImplementationOnce(async (...args) => {
			const answer = await commit(...args);
			f.company.store.set({ staff: [staff] });
			return answer;
		});
		const error = await f.update(session.sessionId, f.observed, f.draft, f.signal).catch((caught: unknown) => caught);
		// Saved, then found out of date: the write is not undone, and the failure is not "not written".
		expect(error).toBeInstanceOf(GroupParticipantsError);
		expect(groupFile(f.fake).name).toBe("Planning");
	});

	it("validates the name, subtitle and description, and the file's size", async () => {
		const f = setup();
		await expect(f.update(session.sessionId, f.observed, { ...f.draft, name: " " }, f.signal)).rejects.toThrow(
			"group name",
		);
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, name: "x".repeat(257) }, f.signal),
		).rejects.toThrow("256 characters");
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, subtitle: "x".repeat(257) }, f.signal),
		).rejects.toThrow("256 characters");
		await expect(f.update(session.sessionId, f.observed, { ...f.draft, purpose: " " }, f.signal)).rejects.toThrow(
			"description",
		);
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, purpose: "é".repeat(17000) }, f.signal),
		).rejects.toThrow("longer than 32768 bytes");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("keeps one update in flight and cancels a closing view before writing", async () => {
		const f = setup();
		const listed = deferred<void>();
		const view = new AbortController();
		const stateFolders = f.fake.folder.stateFolders.getMockImplementation()!;
		f.fake.folder.stateFolders.mockImplementationOnce(async (...args) => {
			await listed.promise;
			return stateFolders(...args);
		});
		const pending = f.update(session.sessionId, f.observed, f.draft, view.signal);
		await expect(f.update(session.sessionId, f.observed, f.draft, view.signal)).rejects.toThrow("finish saving");
		view.abort();
		listed.resolve();
		await expect(pending).rejects.toThrow();
		expect(f.fake.commits).toHaveLength(0);
	});
});

describe("deleting a group chat", () => {
	it("deletes the group chat's folder at the version and seq it read", async () => {
		const f = setup();
		const remove = createGroupDeleter({ company: f.company, folder: f.folder, current: f.current });
		const version = f.fake.version(FOLDER);
		const seq = f.fake.seq;
		await remove(session.sessionId, f.observed.roomId, f.signal);
		expect(f.folder).toHaveBeenCalledWith(f.signal);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.commits[0]?.operationKey).toMatch(
			new RegExp(`^web:group-delete:${f.observed.roomId}:[0-9a-f-]{36}$`),
		);
		expect(f.fake.commits[0]?.units).toEqual([
			{ op: "delete", path: FOLDER, expectedVersion: version, asOfSeq: seq },
		]);
		expect(f.fake.has(FOLDER)).toBe(false);
	});

	it("reads again and retries when something under the folder changed in between", async () => {
		const f = setup();
		const read = f.fake.folder.read.getMockImplementation()!;
		f.fake.folder.read.mockImplementationOnce(async (...args) => {
			const answer = await read(...args);
			f.fake.put(`${FOLDER}/notes.md`, "Agreed.");
			return answer;
		});
		const remove = createGroupDeleter({ company: f.company, folder: f.folder, current: f.current });
		await remove(session.sessionId, f.observed.roomId, f.signal);
		expect(f.fake.commits).toHaveLength(2);
		expect(f.fake.has(FOLDER)).toBe(false);
	});

	it("is done when the group chat is already gone", async () => {
		const f = setup();
		f.fake.remove(FOLDER);
		const remove = createGroupDeleter({ company: f.company, folder: f.folder, current: f.current });
		await remove(session.sessionId, f.observed.roomId, f.signal);
		expect(f.fake.commits).toHaveLength(0);
	});

	it("leaves deleting to owners and admins, and never deletes another room's folder", async () => {
		const f = setup();
		const remove = createGroupDeleter({ company: f.company, folder: f.folder, current: f.current });
		await expect(remove(session.sessionId, id(80), f.signal)).rejects.toThrow("no longer available");
		f.company.store.set({
			team: { ...team, role: "contributor", capabilities: { ...team.capabilities, authorize: false } },
		});
		await expect(remove(session.sessionId, f.observed.roomId, f.signal)).rejects.toThrow("owner or admin");
		expect(f.folder).not.toHaveBeenCalled();
		expect(f.fake.has(FOLDER)).toBe(true);
	});

	it("says so when the delete is refused", async () => {
		const f = setup();
		f.fake.answer("refused", "hook", ["the group chat has a pending human task"]);
		const remove = createGroupDeleter({ company: f.company, folder: f.folder, current: f.current });
		const error = await remove(session.sessionId, f.observed.roomId, f.signal).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((error as Error).message).toBe(
			"The group chat could not be deleted: the group chat has a pending human task.",
		);
		expect(f.fake.has(FOLDER)).toBe(true);
	});
});
