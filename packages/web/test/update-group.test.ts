// @vitest-environment jsdom
import type {
	CloudMemberCompanyEdit,
	CloudMemberCompanyFileClient,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { createGroupDeleter, createGroupUpdater } from "../src/app/update-group.ts";
import { GroupEdits } from "../src/app/views/group-edits.ts";
import type { GroupChatDetails, GroupChatDraft } from "../src/cloud/group-details.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.restoreAllMocks();
});

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
			members: [{ userId: userA.id, email: userA.email!, displayName: "Owner", role: "owner", joinedAt: timestamp }],
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
	const room = {
		schema: "qorpera.company-room/v1",
		roomId: observed.roomId,
		key: "project-discussion",
		name: observed.name,
		purpose: observed.purpose,
		status: observed.status,
		projectId: id(60),
		members: observed.members,
		version: observed.version,
	};
	const path = `organization/rooms/${observed.roomId}.json`;
	const currentFile = { path, version: id(100), kind: "file", executable: false, text: JSON.stringify(room) };
	let pending: string | undefined;
	const editor = {
		read: vi.fn(async () => ({ ...currentFile })),
		edit: vi.fn(async (input: CloudMemberCompanyEdit) => {
			if (input.operation === "write") pending = input.text;
			return { commandId: id(101), state: "review_required", result: null };
		}),
		review: vi.fn(async () => {
			if (pending) currentFile.text = pending;
			return { commandId: id(101), state: "applied", result: { snapshotId: id(102), version: id(103) } };
		}),
	};
	const getEditor = vi.fn(async () => editor as unknown as CloudMemberCompanyFileClient);
	const current = vi.fn();
	const update = createGroupUpdater({ company, editor: getEditor, current });
	const draft: GroupChatDraft = {
		name: "Planning",
		purpose: "Plan the launch",
		members: [observed.members[0]!, observed.members[1]!, { kind: "staff_agent", id: third.id }],
	};
	const signal = new AbortController().signal;
	return {
		company,
		other,
		third,
		group,
		observed,
		room,
		path,
		currentFile,
		editor,
		getEditor,
		current,
		update,
		draft,
		signal,
	};
}

function setupInlineEdits() {
	const f = setup();
	const scope = new AbortController();
	cleanup.push(() => scope.abort());
	vi.spyOn(f.company, "refreshSessions").mockResolvedValue();
	vi.spyOn(f.company, "groupDetails").mockImplementation(async () => {
		const document: typeof f.room & { subtitle?: string } = JSON.parse(f.currentFile.text);
		return { ...f.observed, ...document };
	});
	const update = vi.fn(f.update);
	const edits = new GroupEdits(f.company, f.observed, { updateGroup: update }, scope.signal);
	return { ...f, update, edits };
}

describe("inline group edits through the real updater", () => {
	it("saves a corrected multibyte description and preserves another pending field", async () => {
		const f = setupInlineEdits();
		f.edits.change({ purpose: "界".repeat(12_000) });
		f.edits.change({ subtitle: "Keep this subtitle" });
		await settle();
		expect(f.edits.store.get()).toEqual({
			failed: true,
			status: "The group details are too long. Shorten the description.",
		});
		expect(f.editor.edit).not.toHaveBeenCalled();
		f.edits.change({ purpose: "Corrected short description" });
		expect(f.update).toHaveBeenCalledOnce();
		await f.edits.save();
		expect(f.editor.edit).toHaveBeenCalledOnce();
		expect(JSON.parse(f.currentFile.text)).toMatchObject({
			purpose: "Corrected short description",
			subtitle: "Keep this subtitle",
			version: f.observed.version + 1,
		});
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("accepts corrected participants after validation fails before a write", async () => {
		const f = setupInlineEdits();
		f.edits.change({ members: f.observed.members.slice(0, 2) });
		await settle();
		expect(f.edits.store.get().status).toContain("Choose at least two active agents");
		expect(f.getEditor).not.toHaveBeenCalled();
		f.edits.change({ members: f.draft.members });
		await f.edits.save();
		expect(f.editor.edit).toHaveBeenCalledOnce();
		expect(JSON.parse(f.currentFile.text)).toMatchObject({
			members: f.draft.members,
			version: f.observed.version + 1,
		});
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});

	it("retains an uncertain write through a retry read failure before applying newer edits", async () => {
		const f = setupInlineEdits();
		f.editor.review.mockImplementationOnce(async () => {
			const edit = f.editor.edit.mock.calls[0]![0];
			if (edit.operation !== "write") throw new Error("Expected room write");
			f.currentFile.text = edit.text;
			throw new Error("Lost approval response");
		});
		f.edits.change({ name: "First title" });
		await settle();
		expect(f.edits.store.get().failed).toBe(true);
		f.edits.change({ name: "Newer title", subtitle: "Queued subtitle" });
		f.editor.read.mockRejectedValueOnce(new Error("Temporary read failure"));
		await f.edits.save();
		expect(f.edits.store.get().failed).toBe(true);
		expect(f.editor.edit).toHaveBeenCalledOnce();
		await f.edits.save();
		expect(f.update).toHaveBeenCalledTimes(4);
		for (const retry of f.update.mock.calls.slice(1, 3)) {
			expect(retry[1]).toEqual(f.update.mock.calls[0]![1]);
			expect(retry[2]).toEqual(f.update.mock.calls[0]![2]);
		}
		expect(f.update.mock.calls[3]![1].version).toBe(f.observed.version + 1);
		expect(f.editor.edit).toHaveBeenCalledTimes(2);
		expect(JSON.parse(f.currentFile.text)).toMatchObject({
			name: "Newer title",
			subtitle: "Queued subtitle",
			version: f.observed.version + 2,
		});
		expect(f.edits.store.get()).toEqual({ status: "Saved", failed: false });
	});
});

describe("editing group details", () => {
	it.each(["  Launch coordination  ", ""])("persists and clears canonical subtitles (%s)", async (subtitle) => {
		const f = setup();
		f.currentFile.text = JSON.stringify({ ...f.room, subtitle: "Old subtitle" });
		await f.update(session.sessionId, f.observed, { ...f.draft, subtitle }, f.signal);
		const edit = f.editor.edit.mock.calls[0]![0];
		if (edit.operation !== "write") throw new Error("Expected room write");
		expect(JSON.parse(edit.text)).toEqual({ ...f.room, ...f.draft, subtitle: subtitle.trim(), version: 5 });
	});

	it("preserves the canonical subtitle when editing other group fields", async () => {
		const f = setup();
		f.currentFile.text = JSON.stringify({ ...f.room, subtitle: "Launch coordination" });
		await f.update(session.sessionId, f.observed, f.draft, f.signal);
		const edit = f.editor.edit.mock.calls[0]![0];
		if (edit.operation !== "write") throw new Error("Expected room write");
		expect(JSON.parse(edit.text).subtitle).toBe("Launch coordination");
	});

	it("does not mistake a conflicting subtitle for a previously applied edit", async () => {
		const f = setup();
		f.currentFile.text = JSON.stringify({ ...f.room, ...f.draft, subtitle: "Other editor", version: 5 });
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, subtitle: "Launch coordination" }, f.signal),
		).rejects.toThrow("changed while you were editing");
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("rejects oversized subtitle drafts and malformed canonical subtitles", async () => {
		const f = setup();
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, subtitle: "x".repeat(257) }, f.signal),
		).rejects.toThrow("256 characters");
		for (const subtitle of [null, 1, "x".repeat(257)]) {
			f.currentFile.text = JSON.stringify({ ...f.room, subtitle });
			await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow(
				"document has changed",
			);
		}
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("writes name, description and membership through the governed document, preserving project and identity", async () => {
		const f = setup();
		await f.update(session.sessionId, f.observed, f.draft, f.signal);
		expect(f.editor.read).toHaveBeenCalledWith(f.path, expect.any(AbortSignal));
		const edit = f.editor.edit.mock.calls[0]![0];
		expect(edit).toMatchObject({ operation: "write", expectedVersion: id(100), path: f.path });
		if (edit.operation !== "write") throw new Error("Expected room write");
		expect(JSON.parse(edit.text)).toEqual({ ...f.room, ...f.draft, version: 5 });
		expect(f.editor.review).toHaveBeenCalledWith(
			expect.objectContaining({ commandId: id(101) }),
			"approve",
			expect.any(AbortSignal),
		);
	});

	it("recognizes an applied edit after the approval response was lost without writing a second revision", async () => {
		const f = setup();
		f.editor.review.mockImplementationOnce(async () => {
			const edit = f.editor.edit.mock.calls[0]![0];
			if (edit.operation === "write") f.currentFile.text = edit.text;
			throw new Error("Lost approval response");
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow(
			"Lost approval response",
		);
		await f.update(session.sessionId, f.observed, { ...f.draft, members: [...f.draft.members].reverse() }, f.signal);
		expect(f.editor.edit).toHaveBeenCalledOnce();
	});

	it.each(["conflict", "newer"])("rejects %s changes instead of overwriting a newer room document", async (kind) => {
		const f = setup();
		f.currentFile.text = JSON.stringify({
			...f.room,
			...f.draft,
			name: kind === "conflict" ? "Someone else's edit" : f.draft.name,
			version: kind === "newer" ? 6 : 5,
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow(
			"changed while you were editing",
		);
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it.each(["absent", "directory"])("does not recreate a room whose document is %s", async (kind) => {
		const f = setup();
		f.currentFile.kind = kind;
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("no longer available");
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("rejects mismatched room identities and unsupported document fields", async () => {
		const f = setup();
		for (const changed of [{ roomId: id(80) }, { appearance: { figure: "crown" } }]) {
			f.currentFile.text = JSON.stringify({ ...f.room, ...changed });
			await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow(
				"document has changed",
			);
		}
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("rejects inactive agents, missing human members, duplicate participants and groups with fewer than two agents", async () => {
		const f = setup();
		const invalid: GroupChatDraft["members"][] = [
			[...f.draft.members, { kind: "member", id: id(80) }],
			[...f.draft.members, { kind: "staff_agent", id: id(81) }],
			[...f.draft.members, f.draft.members[1]!],
			f.draft.members.slice(0, 2),
		];
		for (const members of invalid)
			await expect(f.update(session.sessionId, f.observed, { ...f.draft, members }, f.signal)).rejects.toThrow(
				"active agents",
			);
		f.company.store.set({ staff: [staff, { ...f.third, employmentStatus: "archived" }] });
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("active agents");
		expect(f.getEditor).not.toHaveBeenCalled();
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
		expect(f.getEditor).not.toHaveBeenCalled();
	});

	it("checks revocation after reading and before the write", async () => {
		const f = setup();
		f.editor.read.mockImplementationOnce(async () => {
			f.company.store.set({ accessLost: true });
			return { ...f.currentFile };
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("owner or admin");
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("does not approve a staged edit after an agent becomes unavailable", async () => {
		const f = setup();
		f.editor.edit.mockImplementationOnce(async () => {
			f.company.store.set({ staff: [staff] });
			return { commandId: id(101), state: "review_required", result: null };
		});
		await expect(f.update(session.sessionId, f.observed, f.draft, f.signal)).rejects.toThrow("active agents");
		expect(f.editor.review).not.toHaveBeenCalled();
	});

	it("validates text and the full serialized UTF-8 document size", async () => {
		const f = setup();
		await expect(f.update(session.sessionId, f.observed, { ...f.draft, name: " " }, f.signal)).rejects.toThrow(
			"group name",
		);
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, name: "x".repeat(257) }, f.signal),
		).rejects.toThrow("256 characters");
		await expect(f.update(session.sessionId, f.observed, { ...f.draft, purpose: " " }, f.signal)).rejects.toThrow(
			"description",
		);
		await expect(
			f.update(session.sessionId, f.observed, { ...f.draft, purpose: "é".repeat(17000) }, f.signal),
		).rejects.toThrow("too long");
		expect(f.editor.edit).not.toHaveBeenCalled();
	});

	it("keeps one update in flight and cancels a closing view before writing", async () => {
		const f = setup();
		const read = deferred<typeof f.currentFile>();
		const view = new AbortController();
		f.editor.read.mockReturnValueOnce(read.promise);
		const pending = f.update(session.sessionId, f.observed, f.draft, view.signal);
		await expect(f.update(session.sessionId, f.observed, f.draft, view.signal)).rejects.toThrow("finish saving");
		view.abort();
		read.resolve(f.currentFile);
		await expect(pending).rejects.toThrow();
		expect(f.editor.edit).not.toHaveBeenCalled();
	});
});

describe("deleting a group chat", () => {
	it("deletes the room document at its current version and approves the review", async () => {
		const f = setup();
		const remove = createGroupDeleter({ company: f.company, editor: f.getEditor, current: f.current });
		await remove(session.sessionId, f.observed.roomId, f.signal);
		expect(f.editor.read).toHaveBeenCalledWith(f.path, f.signal);
		expect(f.editor.edit).toHaveBeenCalledWith(
			{
				operation: "delete",
				operationKey: expect.stringMatching(new RegExp(`^group-delete:${f.observed.roomId}:`)),
				path: f.path,
				expectedVersion: f.currentFile.version,
			},
			f.signal,
		);
		expect(f.editor.review).toHaveBeenCalledWith(
			expect.objectContaining({ state: "review_required" }),
			"approve",
			f.signal,
		);
	});
	it("is done when the document is already gone", async () => {
		const f = setup();
		f.editor.read.mockResolvedValueOnce({ path: f.path, kind: "absent" } as never);
		const remove = createGroupDeleter({ company: f.company, editor: f.getEditor, current: f.current });
		await remove(session.sessionId, f.observed.roomId, f.signal);
		expect(f.editor.edit).not.toHaveBeenCalled();
	});
	it("leaves deleting to owners and admins, and never deletes another room's document", async () => {
		const f = setup();
		const remove = createGroupDeleter({ company: f.company, editor: f.getEditor, current: f.current });
		await expect(remove(session.sessionId, id(80), f.signal)).rejects.toThrow("no longer available");
		f.editor.read.mockResolvedValueOnce({ ...f.currentFile, text: JSON.stringify({ ...f.room, roomId: id(80) }) });
		await expect(remove(session.sessionId, f.observed.roomId, f.signal)).rejects.toThrow("no longer available");
		f.company.store.set({
			team: { ...team, role: "contributor", capabilities: { ...team.capabilities, authorize: false } },
		});
		await expect(remove(session.sessionId, f.observed.roomId, f.signal)).rejects.toThrow("owner or admin");
		expect(f.editor.edit).not.toHaveBeenCalled();
	});
	it("says so when the delete does not apply", async () => {
		const f = setup();
		f.editor.review.mockResolvedValueOnce({ commandId: id(101), state: "rejected", result: null } as never);
		const remove = createGroupDeleter({ company: f.company, editor: f.getEditor, current: f.current });
		await expect(remove(session.sessionId, f.observed.roomId, f.signal)).rejects.toThrow("could not be deleted");
	});
});
