import { writeGroupFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it, vi } from "vitest";
import {
	createStateFolder,
	deleteStateFolder,
	folderNames,
	parentPath,
	readStateFile,
	rewriteStateFile,
	WebCompanyFolderRejectedError,
	type WebMemberFolder,
	withProblems,
	withStateBody,
} from "../src/cloud/company-folder-writes.ts";
import { id } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

/* The shared steps of the web's folder writers (P34a-2), on their own; company-agents, update-group and
 * start-conversation test them through the editors. */

const signal = () => new AbortController().signal;
const check = () => {};
const group = (name: string) =>
	writeGroupFile({
		id: id(79),
		name,
		subtitle: null,
		agents: [id(9), id(20)],
		people: [],
		purpose: "Plan the launch.",
	});

describe("the folder writers' text helpers", () => {
	it("replaces the body after the settings block, keeping every byte of the block", () => {
		expect(withStateBody("---\nid: a\n---\nOld body.\n", "  New body.  ")).toBe("---\nid: a\n---\nNew body.\n");
		expect(withStateBody("\ufeff---\r\nid: a # note\r\n---\r\nOld.\r\n", "New.")).toBe(
			"\ufeff---\r\nid: a # note\r\n---\r\nNew.\n",
		);
		expect(withStateBody("---\nid: a\n---\nOld.\n", "  ")).toBe("---\nid: a\n---\n");
		expect(() => withStateBody("# A heading\n", "Body.")).toThrow("no settings block");
	});

	it("puts the problems' messages after the failure", () => {
		expect(withProblems("The agent could not be created.", [" name is empty ", "", "role is empty"])).toBe(
			"The agent could not be created: name is empty; role is empty.",
		);
		expect(withProblems("The agent could not be created.", [])).toBe("The agent could not be created.");
	});

	it("finds a path's parent", () => {
		expect(parentPath("agents/ledger/agent.md")).toBe("agents/ledger");
		expect(parentPath("agents")).toBe("");
	});
});

describe("reading a state file", () => {
	function single(bytes: Uint8Array, kind: "file" | "folder" = "file"): WebMemberFolder {
		return {
			read: vi.fn(async (path: string) => ({
				asOfSeq: 1,
				entry: {
					path,
					kind,
					version: id(40),
					seq: 1,
					updatedAt: "2026-10-04T09:00:00Z",
					file:
						kind === "file"
							? {
									manifestSha256: "a".repeat(64),
									fileSha256: "b".repeat(64),
									bytes: bytes.byteLength,
									mediaType: "text/markdown",
									executable: false,
								}
							: null,
					target: null,
				},
			})),
			readFile: vi.fn(async () => bytes),
			list: vi.fn(),
			stateFolders: vi.fn(),
			commit: vi.fn(),
		} as unknown as WebMemberFolder;
	}

	it("decodes strict UTF-8 and keeps a byte-order mark", async () => {
		const text = "\ufeff---\nid: a\n---\nÆble.\n";
		const read = await readStateFile(single(new TextEncoder().encode(text)), "agents/a/agent.md", signal());
		expect(read?.text).toBe(text);
		expect(read?.entry.version).toBe(id(40));
	});

	it("refuses bytes that are not UTF-8, a folder, and a file past 64 KiB, and answers null for a missing path", async () => {
		await expect(
			readStateFile(single(Uint8Array.from([0x2d, 0xff, 0x2d])), "agents/a/agent.md", signal()),
		).rejects.toThrow();
		await expect(readStateFile(single(new Uint8Array(), "folder"), "agents/a/agent.md", signal())).rejects.toThrow(
			"not a company state file",
		);
		await expect(readStateFile(single(new Uint8Array(64 * 1024 + 1)), "agents/a/agent.md", signal())).rejects.toThrow(
			"not a company state file",
		);
		expect(await readStateFile(folderFake().folder, "agents/a/agent.md", signal())).toBeNull();
	});
});

describe("listing a folder's names", () => {
	it("reads every page, in lowercase", async () => {
		const fake = folderFake();
		for (let index = 0; index < 1000; index++) fake.mkdir(`agents/a-${String(index).padStart(4, "0")}`);
		fake.mkdir("agents/Ledger");
		const names = await folderNames(fake.folder, "agents", signal());
		// The 1,000 made here, Ledger and the seeded groups.
		expect(names.size).toBe(1002);
		expect(names.has("ledger")).toBe(true);
		expect(fake.folder.list).toHaveBeenCalledTimes(2);
	});
});

describe("creating a state folder", () => {
	it("refuses contents whose state file would not parse, before sending anything", async () => {
		const fake = folderFake();
		const error = await createStateFolder(
			fake.folder,
			{
				parent: "agents/groups",
				name: "Launch",
				fallback: "group",
				key: (handle) => `web:test:${handle}`,
				contents: [{ path: "group.md", kind: "file", text: "---\nid: not-an-id\n---\n" }],
				failure: "The group chat could not be created.",
			},
			signal(),
			check,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({ outcome: "refused", reason: "invalid" });
		expect((error as Error).message).toMatch(/^The group chat could not be created: .+\.$/);
		expect(fake.commits).toHaveLength(0);
	});

	it("falls back to its handle when the name leaves none", async () => {
		const fake = folderFake();
		const path = await createStateFolder(
			fake.folder,
			{
				parent: "agents/groups",
				name: "東京",
				fallback: "group",
				key: (handle) => `web:test:${handle}`,
				contents: [{ path: "group.md", kind: "file", text: group("東京") }],
				failure: "The group chat could not be created.",
			},
			signal(),
			check,
		);
		expect(path).toBe("agents/groups/group");
		expect(fake.kind("agents/groups/group/group.md")).toBe("file");
	});
});

describe("rewriting a state file", () => {
	const PATH = "agents/groups/launch/group.md";

	it("sends nothing when the rewrite has nothing to write", async () => {
		const fake = folderFake();
		fake.put(PATH, group("Launch"));
		const sent = vi.fn();
		const written = await rewriteStateFile(
			fake.folder,
			{
				locate: async () => PATH,
				rewrite: () => null,
				key: () => "web:test:1",
				gone: "Gone.",
				failure: "Not saved.",
				sent,
			},
			signal(),
			check,
		);
		expect(written).toBe(false);
		expect(sent).not.toHaveBeenCalled();
		expect(fake.commits).toHaveLength(0);
	});

	it("says when the write was sent, and when its answer said it was not saved", async () => {
		const fake = folderFake();
		fake.put(PATH, group("Launch"));
		const sent = vi.fn();
		const options = {
			locate: async () => PATH,
			rewrite: (text: string) => text.replace("name: Launch", "name: Launch day"),
			key: () => `web:test:${crypto.randomUUID()}`,
			gone: "Gone.",
			failure: "Not saved.",
			sent,
		};
		fake.answer("denied", "path_authority");
		await expect(rewriteStateFile(fake.folder, options, signal(), check)).rejects.toMatchObject({
			outcome: "denied",
			reason: "path_authority",
			message: "Not saved.",
		});
		expect(sent.mock.calls).toEqual([[true], [false]]);
		sent.mockClear();
		await expect(rewriteStateFile(fake.folder, options, signal(), check)).resolves.toBe(true);
		expect(sent.mock.calls).toEqual([[true]]);
		expect(fake.text(PATH)).toContain("name: Launch day");
	});

	it("says the file is gone when it has no path or no entry", async () => {
		const fake = folderFake();
		const options = {
			rewrite: (text: string) => text,
			key: () => "web:test:1",
			gone: "Gone.",
			failure: "Not saved.",
		};
		await expect(
			rewriteStateFile(fake.folder, { ...options, locate: async () => null }, signal(), check),
		).rejects.toThrow("Gone.");
		await expect(
			rewriteStateFile(fake.folder, { ...options, locate: async () => PATH }, signal(), check),
		).rejects.toThrow("Gone.");
		expect(fake.commits).toHaveLength(0);
	});
});

describe("deleting a state folder", () => {
	it("refuses a file where the folder should be", async () => {
		const fake = folderFake();
		fake.put("agents/groups/launch", "Not a folder.");
		await expect(
			deleteStateFolder(
				fake.folder,
				{ locate: async () => "agents/groups/launch", key: () => "web:test:1", failure: "Not deleted." },
				signal(),
				check,
			),
		).rejects.toThrow("Not deleted.");
		expect(fake.commits).toHaveLength(0);
	});

	it("gives up after three more tries when something keeps changing under the folder", async () => {
		const fake = folderFake();
		fake.put("agents/groups/launch/group.md", group("Launch"));
		const read = fake.folder.read.getMockImplementation()!;
		let notes = 0;
		fake.folder.read.mockImplementation(async (...args) => {
			const answer = await read(...args);
			fake.put(`agents/groups/launch/note-${++notes}.md`, "A note.");
			return answer;
		});
		const error = await deleteStateFolder(
			fake.folder,
			{
				locate: async () => "agents/groups/launch",
				key: () => `web:test:${crypto.randomUUID()}`,
				failure: "Not deleted.",
			},
			signal(),
			check,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({ outcome: "conflict", reason: "unseen_change", message: "Not deleted." });
		expect(fake.commits).toHaveLength(4);
		expect(fake.has("agents/groups/launch")).toBe(true);
	});
});
