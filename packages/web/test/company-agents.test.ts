import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type AgentFile, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it, vi } from "vitest";
import { AGENT_COLOUR_HEX, agentFileColour } from "../src/cloud/agent-colours.ts";
import {
	createWebCompanyAgents,
	prepareWebCompanyAgentCreation,
	type WebCompanyAgentDraft,
} from "../src/cloud/company-agents.ts";
import type { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import { UUID_PATTERN } from "../src/cloud/parse.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { staff } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* The agent editor on the company folder (P34a-2): an agent is agents/<handle>/agent.md, written through the member
 * commit route. The fake folder keeps the core's rules (folder-fake.ts). */

function setup() {
	const fake = folderFake();
	const stop = new AbortController();
	const current = vi.fn();
	const folder = vi.fn(() => fake.folder as never);
	const files = { signal: stop.signal, current, folder } as Pick<WebCompanyFiles, "signal" | "current" | "folder">;
	return { fake, stop, current, folder, files, signal: new AbortController().signal };
}

const draft: WebCompanyAgentDraft = {
	displayName: "Ledger",
	role: "Keeps the books",
	charter: "",
	figure: "owl",
	color: "#123456",
};

/** The figures' own shades, as the figure model has them (public/assets/avatars/motion-model.js). */
const NATIVE = {
	planet: "#5ec0b5",
	acorn: "#87674c",
	flame: "#fa752e",
	rocket: "#f96e2d",
	crown: "#fcb51b",
	heart: "#fb672a",
	ghost: "#312f2d",
} as const;
const native = (figure: keyof typeof NATIVE) => NATIVE[figure];

function agentFile(fake: FolderFake, path: string): AgentFile {
	const parsed = parseCompanyStateFile(path, fake.text(path) ?? "");
	if (!parsed?.ok || parsed.file.kind !== "agent") throw new Error(`${path} is not an agent file`);
	return parsed.file;
}

/** A created agent as the roster then shows it. */
async function created(f: ReturnType<typeof setup>, overrides: Partial<WebCompanyAgentDraft> = {}) {
	const creation = prepareWebCompanyAgentCreation({ ...draft, ...overrides });
	await createWebCompanyAgents(f.files).create(creation, f.signal);
	const path = "agents/ledger/agent.md";
	const file = agentFile(f.fake, path);
	const agent: HostedStaffAgent = {
		...staff,
		id: creation.id,
		displayName: file.name,
		role: file.role,
		charter: file.instructions,
		appearance: { color: creation.color, shape: "circle" },
		version: 3,
	};
	f.fake.commits.length = 0;
	return { creation, agent, path };
}

describe("preparing an agent", () => {
	it("gives the draft its identity and checks the agent.md it will write", () => {
		const creation = prepareWebCompanyAgentCreation(draft);
		expect(creation).toMatchObject(draft);
		expect(creation.id).toMatch(UUID_PATTERN);
		expect(Number.isFinite(Date.parse(creation.createdAt))).toBe(true);
		expect(prepareWebCompanyAgentCreation(draft).id).not.toBe(creation.id);
	});
	it.each([
		["a control character in the responsibilities", { charter: "Keep\u0001the books" }, "control character"],
		["a name past 160 characters", { displayName: "x".repeat(161) }, "name must be 1–160 characters"],
		["responsibilities past 32 KiB", { charter: "é".repeat(17_000) }, "longer than 32768 bytes"],
	])("refuses %s before anything is retained", (_what, change, problem) => {
		expect(() => prepareWebCompanyAgentCreation({ ...draft, ...change })).toThrow(
			"The agent cannot be saved as the company's files:",
		);
		expect(() => prepareWebCompanyAgentCreation({ ...draft, ...change })).toThrow(problem);
	});
});

describe("creating an agent", () => {
	it("creates agents/<handle> with its agent.md and the four folders a hired agent has", async () => {
		const f = setup();
		const creation = prepareWebCompanyAgentCreation(draft);
		await expect(createWebCompanyAgents(f.files).create(creation, f.signal)).resolves.toBe(creation.id);
		expect(f.fake.commits).toHaveLength(1);
		const [commit] = f.fake.commits;
		expect(commit?.operationKey).toBe(`web:staff-create:${creation.id}:ledger`);
		expect(commit?.units).toEqual([
			{
				op: "new_folder",
				path: "agents/ledger",
				contents: [
					{ path: "agent.md", kind: "file", text: expect.any(String) },
					{ path: "memory", kind: "folder" },
					{ path: "skills", kind: "folder" },
					{ path: "routines", kind: "folder" },
					{ path: "todos", kind: "folder" },
				],
			},
		]);
		expect(f.fake.children("agents/ledger")).toEqual([
			"agents/ledger/agent.md",
			"agents/ledger/memory",
			"agents/ledger/routines",
			"agents/ledger/skills",
			"agents/ledger/todos",
		]);
		const file = agentFile(f.fake, "agents/ledger/agent.md");
		expect(file).toMatchObject({
			id: creation.id,
			name: "Ledger",
			role: "Keeps the books",
			agentKind: "agent",
			status: "active",
			// "owl" is no figure, and #123456 no palette colour: neither is written.
			colour: null,
			figure: null,
			model: null,
			effort: null,
		});
		// The instructions are the agent's responsibilities: a placeholder, never the name (a rename would leave it stale).
		expect(file.instructions).toContain("No responsibilities have been written");
		expect(file.instructions).not.toContain("Ledger");
		expect(await f.fake.folder.stateFolders(f.signal)).toEqual({
			agents: [{ staffAgentId: creation.id, file: "agents/ledger/agent.md" }],
			groups: [],
		});
	});

	it("writes the responsibilities as the instructions, and the figure and colour the file knows", async () => {
		const f = setup();
		const creation = prepareWebCompanyAgentCreation({
			...draft,
			charter: "  Own the ledger.  ",
			figure: "rocket",
			color: "qorpera-coral",
		});
		await createWebCompanyAgents(f.files).create(creation, f.signal);
		expect(agentFile(f.fake, "agents/ledger/agent.md")).toMatchObject({
			instructions: "Own the ledger.",
			figure: "rocket",
			colour: "coral",
		});
	});

	it.each([
		["qorpera-teal", "teal"],
		["#2047BD", "blue"],
		[" #ff2994 ", "pink"],
		["#123456", null],
		["coral", null],
	])("writes the colour %s as %s", (color, colour) => {
		expect(agentFileColour(color)).toBe(colour);
	});

	it("names the vendored palette's colours (avatar-appearance.js)", () => {
		const source = readFileSync(new URL("../public/assets/avatars/avatar-appearance.js", import.meta.url), "utf8");
		const scope: {
			QORPERA_MOTION_MODEL: object;
			QORPERA_AVATAR_APPEARANCE?: { palette: { name: string; color: string }[] };
		} = { QORPERA_MOTION_MODEL: { avatars: [] } };
		runInNewContext(source, { window: scope });
		const palette = Array.from(scope.QORPERA_AVATAR_APPEARANCE?.palette ?? [], ({ name, color }) => [
			name.toLowerCase(),
			color,
		]);
		expect(palette).toEqual(Object.entries(AGENT_COLOUR_HEX));
	});

	it("writes no colour for the figure's own shade, and a picked palette colour by its name", async () => {
		const f = setup();
		const agents = createWebCompanyAgents(f.files, { native });
		// A new agent's default: the rocket in its own shade (new-conversation.ts), the palette's orange as well.
		await agents.create(
			prepareWebCompanyAgentCreation({ ...draft, figure: "rocket", color: NATIVE.rocket }),
			f.signal,
		);
		expect(agentFile(f.fake, "agents/ledger/agent.md")).toMatchObject({ figure: "rocket", colour: null });
		await agents.create(
			prepareWebCompanyAgentCreation({
				...draft,
				displayName: "Teal",
				figure: "rocket",
				color: AGENT_COLOUR_HEX.teal,
			}),
			f.signal,
		);
		expect(agentFile(f.fake, "agents/teal/agent.md")).toMatchObject({ figure: "rocket", colour: "teal" });
		// The crown's own gold, picked for the rocket, is the rocket's colour.
		await agents.create(
			prepareWebCompanyAgentCreation({ ...draft, displayName: "Gold", figure: "rocket", color: NATIVE.crown }),
			f.signal,
		);
		expect(agentFile(f.fake, "agents/gold/agent.md")).toMatchObject({ figure: "rocket", colour: "gold" });
	});

	it("takes the next handle when the name is listed, and never a reserved one", async () => {
		const f = setup();
		f.fake.mkdir("agents/ledger");
		const first = prepareWebCompanyAgentCreation(draft);
		await createWebCompanyAgents(f.files).create(first, f.signal);
		expect(f.fake.commits.map((commit) => commit.operationKey)).toEqual([`web:staff-create:${first.id}:ledger-2`]);
		const groups = prepareWebCompanyAgentCreation({ ...draft, displayName: "Groups" });
		await createWebCompanyAgents(f.files).create(groups, f.signal);
		expect(f.fake.commits.at(-1)?.units[0]).toMatchObject({ op: "new_folder", path: "agents/groups-2" });
		expect(agentFile(f.fake, "agents/groups-2/agent.md").id).toBe(groups.id);
	});

	/** Another writer makes these folders just after the member's listing of `agents/`. */
	function takenAfterListing(f: ReturnType<typeof setup>, ...paths: string[]) {
		const list = f.fake.folder.list.getMockImplementation()!;
		f.fake.folder.list.mockImplementationOnce(async (...args) => {
			const page = await list(...args);
			for (const path of paths) f.fake.mkdir(path);
			return page;
		});
	}

	it("takes the next handle, as a new change set, when the name was taken since the listing", async () => {
		const f = setup();
		takenAfterListing(f, "agents/ledger");
		const creation = prepareWebCompanyAgentCreation(draft);
		await createWebCompanyAgents(f.files).create(creation, f.signal);
		expect(f.fake.commits.map((commit) => [commit.operationKey, (commit.units[0] as { path: string }).path])).toEqual(
			[
				[`web:staff-create:${creation.id}:ledger`, "agents/ledger"],
				[`web:staff-create:${creation.id}:ledger-2`, "agents/ledger-2"],
			],
		);
		expect(agentFile(f.fake, "agents/ledger-2/agent.md").id).toBe(creation.id);
	});

	it("stops after three taken handles and says the agent was not created", async () => {
		const f = setup();
		takenAfterListing(f, "agents/ledger", "agents/ledger-2", "agents/ledger-3");
		const error = await createWebCompanyAgents(f.files)
			.create(prepareWebCompanyAgentCreation(draft), f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({
			outcome: "conflict",
			reason: "exists",
			message: "The agent could not be created.",
		});
		expect(f.fake.commits).toHaveLength(3);
	});

	it("reports a name closed to the member as denied, without trying another", async () => {
		const f = setup();
		// The core decides authority before existence: a folder the member may not read or write is `denied`.
		f.fake.mkdir("agents/ledger");
		f.fake.deny("agents/ledger");
		const error = await createWebCompanyAgents(f.files)
			.create(prepareWebCompanyAgentCreation(draft), f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({ outcome: "denied", reason: "denied", message: "The agent could not be created." });
		expect(f.fake.commits).toHaveLength(1);
	});

	it("finds the agent a lost answer created instead of creating a second one", async () => {
		const f = setup();
		const creation = prepareWebCompanyAgentCreation(draft);
		f.fake.loseAnswer();
		await expect(createWebCompanyAgents(f.files).create(creation, f.signal)).rejects.toThrow("Failed to fetch");
		// The application makes a new adapter for each call; the identity is the draft's.
		await expect(createWebCompanyAgents(f.files).create(creation, f.signal)).resolves.toBe(creation.id);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.children("agents")).toEqual(["agents/groups", "agents/ledger"]);
	});

	it("sends the same change set again when the first never reached the core", async () => {
		const f = setup();
		const creation = prepareWebCompanyAgentCreation(draft);
		f.fake.failCommit();
		await expect(createWebCompanyAgents(f.files).create(creation, f.signal)).rejects.toThrow("Failed to fetch");
		await createWebCompanyAgents(f.files).create(creation, f.signal);
		expect(f.fake.commits).toHaveLength(2);
		expect(f.fake.commits[1]).toEqual(f.fake.commits[0]);
		expect(agentFile(f.fake, "agents/ledger/agent.md").id).toBe(creation.id);
	});

	it.each([
		["refused", "hook"],
		["denied", "access"],
	] as const)("reports a %s change set as a rejection with its problems", async (outcome, reason) => {
		const f = setup();
		f.fake.answer(outcome, reason, ["agents may only be hired by an owner or admin "]);
		const error = await createWebCompanyAgents(f.files)
			.create(prepareWebCompanyAgentCreation(draft), f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({
			outcome,
			reason,
			message: "The agent could not be created: agents may only be hired by an owner or admin.",
		});
		expect(f.fake.has("agents/ledger")).toBe(false);
	});

	it("treats an answer waiting for review as uncertain, never as a rejection", async () => {
		const f = setup();
		f.fake.answer("waiting_for_review", "review");
		const error = await createWebCompanyAgents(f.files)
			.create(prepareWebCompanyAgentCreation(draft), f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(WebCompanyFolderRejectedError);
	});

	it("writes nothing when company access changed or the company closed", async () => {
		const f = setup();
		f.current.mockImplementation(() => {
			throw new Error("Company access changed.");
		});
		await expect(
			createWebCompanyAgents(f.files).create(prepareWebCompanyAgentCreation(draft), f.signal),
		).rejects.toThrow("Company access changed.");
		f.current.mockReset();
		f.stop.abort();
		await expect(
			createWebCompanyAgents(f.files).create(prepareWebCompanyAgentCreation(draft), f.signal),
		).rejects.toThrow();
		expect(f.fake.commits).toHaveLength(0);
	});

	it("checks access again after the listing, before the change set", async () => {
		const f = setup();
		const list = f.fake.folder.list.getMockImplementation()!;
		f.fake.folder.list.mockImplementationOnce(async (...args) => {
			const page = await list(...args);
			f.current.mockImplementation(() => {
				throw new Error("Company access changed.");
			});
			return page;
		});
		await expect(
			createWebCompanyAgents(f.files).create(prepareWebCompanyAgentCreation(draft), f.signal),
		).rejects.toThrow("Company access changed.");
		expect(f.fake.commits).toHaveLength(0);
	});
});

describe("changing an agent", () => {
	it("writes only the fields the member changed, naming the version it read", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		const before = f.fake.text(path)!;
		const version = f.fake.version(path);
		// The agent changed its own role meanwhile; the member changes the name only.
		f.fake.put(path, before.replace("role: Keeps the books", "role: Bookkeeper"));
		const read = f.fake.version(path);
		expect(read).not.toBe(version);
		await expect(
			createWebCompanyAgents(f.files).update(agent, { ...draft, displayName: "Ledger II" }, f.signal),
		).resolves.toBe(agent.version + 1);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.commits[0]?.operationKey).toMatch(new RegExp(`^web:staff-update:${agent.id}:[0-9a-f-]{36}$`));
		expect(f.fake.commits[0]?.units).toEqual([
			{ op: "write", path, text: expect.any(String), expectedVersion: read },
		]);
		const after = f.fake.text(path)!;
		expect(after).toBe(before.replace("name: Ledger", "name: Ledger II").replace("Keeps the books", "Bookkeeper"));
		expect(agentFile(f.fake, path)).toMatchObject({ name: "Ledger II", role: "Bookkeeper" });
	});

	it("rewrites the instructions and keeps the settings block as it was", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		const before = f.fake.text(path)!;
		await createWebCompanyAgents(f.files).update(agent, { ...draft, charter: "  Own the ledger.  " }, f.signal);
		const after = f.fake.text(path)!;
		const settings = before.slice(0, before.indexOf("\n---\n") + 5);
		expect(after).toBe(`${settings}Own the ledger.\n`);
		expect(agentFile(f.fake, path).instructions).toBe("Own the ledger.");
	});

	it("writes a chosen figure and palette colour, and removes a figure the file cannot hold", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		await createWebCompanyAgents(f.files).update(
			agent,
			{ ...draft, figure: "rocket", color: "qorpera-teal" },
			f.signal,
		);
		expect(agentFile(f.fake, path)).toMatchObject({ figure: "rocket", colour: "teal" });
		const saved = () => ({ ...draft, figure: "rocket", color: "qorpera-teal" });
		await createWebCompanyAgents(f.files, { saved }).update(
			agent,
			{ ...draft, figure: "owl", color: "#2047bd" },
			f.signal,
		);
		expect(agentFile(f.fake, path)).toMatchObject({ figure: null, colour: "blue" });
	});

	it("writes no colour for the figure's own shade, and a colour kept through a change of figure", async () => {
		const f = setup();
		const { agent, path } = await created(f, { figure: "rocket", color: "qorpera-teal" });
		const update = (before: Partial<WebCompanyAgentDraft>, after: Partial<WebCompanyAgentDraft>) =>
			createWebCompanyAgents(f.files, { saved: () => ({ ...draft, ...before }), native }).update(
				agent,
				{ ...draft, ...after },
				f.signal,
			);
		// Back to the rocket's own shade: no colour, so the agent follows its figure's shade again.
		await update({ figure: "rocket", color: AGENT_COLOUR_HEX.teal }, { figure: "rocket", color: NATIVE.rocket });
		expect(agentFile(f.fake, path)).toMatchObject({ figure: "rocket", colour: null });
		// The rocket's orange, kept for the crown, is the crown's colour.
		await update({ figure: "rocket", color: NATIVE.rocket }, { figure: "crown", color: NATIVE.rocket });
		expect(agentFile(f.fake, path)).toMatchObject({ figure: "crown", colour: "orange" });
		// A figure that brings its own shade has no colour.
		await update({ figure: "crown", color: NATIVE.rocket }, { figure: "planet", color: NATIVE.planet });
		expect(agentFile(f.fake, path)).toMatchObject({ figure: "planet", colour: null });
	});

	it("keeps a CRLF agent.md's line breaks, mark and notes when a setting and the body change", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		// The file as an editor on Windows saved it: a byte-order mark, CRLF line breaks and a note.
		const saved =
			`\ufeff${f.fake.text(path)!.replace("role: Keeps the books", "role: Keeps the books # in its own words")}`
				.split("\n")
				.join("\r\n");
		f.fake.put(path, saved);
		await createWebCompanyAgents(f.files).update(
			agent,
			{ ...draft, displayName: "Ledger II", charter: "Own the ledger." },
			f.signal,
		);
		const settings = saved.slice(0, saved.indexOf("\r\n---\r\n") + 7);
		expect(f.fake.text(path)).toBe(
			`${settings.replace("\r\nname: Ledger\r\n", "\r\nname: Ledger II\r\n")}Own the ledger.\n`,
		);
		expect(agentFile(f.fake, path)).toMatchObject({
			name: "Ledger II",
			role: "Keeps the books",
			instructions: "Own the ledger.",
		});
	});

	it("writes nothing when nothing changed, and answers the agent's own version", async () => {
		const f = setup();
		const { agent } = await created(f);
		// An emptied description keeps the instructions: an agent always has some.
		for (const change of [{}, { charter: "" }, { displayName: "  Ledger  " }])
			await expect(createWebCompanyAgents(f.files).update(agent, { ...draft, ...change }, f.signal)).resolves.toBe(
				agent.version,
			);
		expect(f.fake.commits).toHaveLength(0);
	});

	it("leaves a field the member did not touch as the file has it", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		f.fake.put(path, f.fake.text(path)!.replace("name: Ledger", "name: Ledger by the agent"));
		// The editor still shows the old name, untouched; the member changes the role.
		await createWebCompanyAgents(f.files).update(agent, { ...draft, role: "Books" }, f.signal);
		expect(agentFile(f.fake, path)).toMatchObject({ name: "Ledger by the agent", role: "Books" });
	});

	it("reads again and rewrites when the file changed between the read and the write", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		const readFile = f.fake.folder.readFile.getMockImplementation()!;
		let changed: string | undefined;
		f.fake.folder.readFile.mockImplementationOnce(async (...args) => {
			const bytes = await readFile(...args);
			// The agent's run writes its file meanwhile.
			changed = f.fake.put(path, f.fake.text(path)!.replace("role: Keeps the books", "role: Bookkeeper"));
			return bytes;
		});
		const first = f.fake.version(path);
		await expect(
			createWebCompanyAgents(f.files).update(agent, { ...draft, displayName: "Ledger II" }, f.signal),
		).resolves.toBe(agent.version + 1);
		expect(changed).toBeDefined();
		expect(f.fake.commits.map((commit) => commit.units[0])).toMatchObject([
			{ op: "write", expectedVersion: first },
			{ op: "write", expectedVersion: changed },
		]);
		expect(f.fake.commits[1]?.operationKey).not.toBe(f.fake.commits[0]?.operationKey);
		expect(agentFile(f.fake, path)).toMatchObject({ name: "Ledger II", role: "Bookkeeper" });
	});

	it("gives up after three more tries when the file keeps changing", async () => {
		const f = setup();
		const { agent, path } = await created(f);
		const readFile = f.fake.folder.readFile.getMockImplementation()!;
		let runs = 0;
		f.fake.folder.readFile.mockImplementation(async (...args) => {
			const bytes = await readFile(...args);
			f.fake.put(path, f.fake.text(path)!.replace(/role: .*/, `role: Run ${++runs}`));
			return bytes;
		});
		const error = await createWebCompanyAgents(f.files)
			.update(agent, { ...draft, displayName: "Ledger II" }, f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({ outcome: "conflict", reason: "version_changed" });
		expect(f.fake.commits).toHaveLength(4);
		expect(agentFile(f.fake, path).name).toBe("Ledger");
	});

	it("says the agent is gone when its folder is, and writes nothing", async () => {
		const f = setup();
		const { agent } = await created(f);
		f.fake.remove("agents/ledger");
		await expect(
			createWebCompanyAgents(f.files).update(agent, { ...draft, displayName: "Ledger II" }, f.signal),
		).rejects.toThrow("This agent is no longer available.");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("refuses a change the file cannot hold before sending it", async () => {
		const f = setup();
		const { agent } = await created(f);
		const error = await createWebCompanyAgents(f.files)
			.update(agent, { ...draft, displayName: "x".repeat(161) }, f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((error as Error).message).toContain("name must be 1–160 characters");
		expect(f.fake.commits).toHaveLength(0);
	});

	it("reports the hook's refusal with its problems", async () => {
		const f = setup();
		const { agent } = await created(f);
		f.fake.answer("refused", "hook", ["the Co-Founder's role cannot change"]);
		const error = await createWebCompanyAgents(f.files)
			.update(agent, { ...draft, role: "Anything" }, f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((error as Error).message).toBe(
			"The agent's changes could not be saved: the Co-Founder's role cannot change.",
		);
	});
});

describe("deleting an agent", () => {
	it("deletes the agent's folder at the version and seq it read", async () => {
		const f = setup();
		const { agent } = await created(f);
		const version = f.fake.version("agents/ledger");
		const seq = f.fake.seq;
		await createWebCompanyAgents(f.files).delete(agent, f.signal);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.commits[0]?.operationKey).toMatch(new RegExp(`^web:staff-delete:${agent.id}:[0-9a-f-]{36}$`));
		expect(f.fake.commits[0]?.units).toEqual([
			{ op: "delete", path: "agents/ledger", expectedVersion: version, asOfSeq: seq },
		]);
		expect(f.fake.has("agents/ledger")).toBe(false);
	});

	it("reads again and retries when the agent's run wrote under its folder in between", async () => {
		const f = setup();
		const { agent } = await created(f);
		const read = f.fake.folder.read.getMockImplementation()!;
		f.fake.folder.read.mockImplementationOnce(async (...args) => {
			const answer = await read(...args);
			f.fake.put("agents/ledger/memory/notes.md", "A note.");
			return answer;
		});
		const seq = f.fake.seq;
		await createWebCompanyAgents(f.files).delete(agent, f.signal);
		expect(f.fake.commits.map((commit) => commit.units[0])).toEqual([
			{ op: "delete", path: "agents/ledger", expectedVersion: expect.any(String), asOfSeq: seq },
			// The note came at seq + 1; the second read saw it.
			{ op: "delete", path: "agents/ledger", expectedVersion: expect.any(String), asOfSeq: seq + 1 },
		]);
		expect(f.fake.has("agents/ledger")).toBe(false);
	});

	it("is done when the agent is already gone", async () => {
		const f = setup();
		const { agent } = await created(f);
		f.fake.remove("agents/ledger");
		await createWebCompanyAgents(f.files).delete(agent, f.signal);
		expect(f.fake.commits).toHaveLength(0);
		// Gone between the read and the delete: the core answers missing, which is done as well.
		const g = setup();
		const other = await created(g);
		const read = g.fake.folder.read.getMockImplementation()!;
		g.fake.folder.read.mockImplementationOnce(async (...args) => {
			const answer = await read(...args);
			g.fake.remove("agents/ledger");
			return answer;
		});
		await createWebCompanyAgents(g.files).delete(other.agent, g.signal);
		expect(g.fake.commits).toHaveLength(1);
	});

	it("never deletes the Co-Founder", async () => {
		const f = setup();
		const { agent } = await created(f);
		f.folder.mockClear();
		await expect(
			createWebCompanyAgents(f.files).delete({ ...agent, templateId: "co-founder" }, f.signal),
		).rejects.toThrow("The Co-Founder cannot be deleted.");
		expect(f.folder).not.toHaveBeenCalled();
		expect(f.fake.has("agents/ledger")).toBe(true);
	});

	it("reports a refusal with its problems, and keeps the folder", async () => {
		const f = setup();
		const { agent } = await created(f);
		f.fake.answer("refused", "hook", ["the agent still has open human tasks"]);
		const error = await createWebCompanyAgents(f.files)
			.delete(agent, f.signal)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(error).toMatchObject({
			outcome: "refused",
			reason: "hook",
			message: "The agent could not be deleted: the agent still has open human tasks.",
		});
		expect(f.fake.has("agents/ledger")).toBe(true);
	});
});
