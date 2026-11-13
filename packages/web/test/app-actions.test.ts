// @vitest-environment jsdom
import { createHash } from "node:crypto";
import type {
	CloudMemberFolderCommit,
	CloudMemberFolderEntry,
	CloudMemberFolderUnit,
} from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { parseTableFile, type TableFile } from "@qorpera/cloud-client/interfaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppActionRefused,
	type AppAsk,
	type AppGate,
	type AppNoteSent,
	type AppTellSource,
	type HeldNote,
	planRowChange,
} from "../src/app/app-actions.ts";
import { AppBridge, type AppBridgeHost, type CompanyApp, TELL_AGAIN_MS } from "../src/app/interface-apps.ts";
import type { OpenQuestionsState } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import { AppAskBar, ASK_ALLOW_AFTER_MS } from "../src/app/views/app-ask-bar.ts";
import type { WebMemberFolder } from "../src/cloud/company-folder-writes.ts";
import { type OpenQuestion, parseOpenQuestions } from "../src/cloud/open-questions.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { AppFrame } from "../src/ui/app-frame.ts";
import { PAGE_ESCAPE, PAGE_READY } from "../src/ui/page-frame.ts";
import { staff } from "./fixtures.ts";

/* What a member can do from an interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §5 "Writes"): the page asks,
 * the bar outside its frame is the member's yes, and the change is the member's own. */

const ORDERS = `format = "qorpera.table/v0"

[table]
id = "1d6e4a57-8b3c-4f21-9e6d-0a7c5b2f8e15"
name = "Orders"
rows = "file"
key = ["order"]
holder = "packer"

[[column]]
name = "order"
type = "text"
max = 20

[[column]]
name = "customer"
type = "text"

[[column]]
name = "status"
type = "choice"
choices = ["new", "packed", "shipped"]

[[column]]
name = "shipped_on"
type = "date"
optional = true

[[column]]
name = "boxes"
type = "number"
optional = true

[[column]]
name = "gift"
type = "yes-no"
optional = true

[[column]]
name = "packer"
type = "member"
optional = true
needs_yes = true

[[column]]
name = "agent"
type = "agent"
optional = true

[write]
agents = "all"
members = "all"
`;
const ROWS =
	'order,customer,status,shipped_on,boxes,gift,packer,agent\n1042,Hansen,packed,,2,,,\n1043,"Lund, A",new,,,,,\n';
const TABLE = "QorperaOS/tables/orders/table.toml";
const FILE = "QorperaOS/tables/orders/rows.csv";

function orders(): TableFile {
	const parsed = parseTableFile(ORDERS);
	if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.message).join("; "));
	return parsed.file;
}

describe("a change to a table's row, read against the rows as they are", () => {
	const set = (key: unknown, cells: Record<string, unknown>, text = ROWS) =>
		planRowChange(orders(), text, { add: false, key, cells });
	const add = (cells: Record<string, unknown>, text = ROWS) =>
		planRowChange(orders(), text, { add: true, key: undefined, cells });

	it("changes only the cells named, shows each as it is and as it will be, and keeps every other byte", () => {
		expect(set("1042", { status: "shipped", shipped_on: "2026-11-10", boxes: 3, gift: true })).toEqual({
			ok: true,
			row: "1042",
			changes: [
				{ column: "status", before: "packed", after: "shipped" },
				{ column: "shipped_on", before: null, after: "2026-11-10" },
				{ column: "boxes", before: "2", after: "3" },
				{ column: "gift", before: null, after: "yes" },
			],
			text: 'order,customer,status,shipped_on,boxes,gift,packer,agent\n1042,Hansen,shipped,2026-11-10,3,yes,,\n1043,"Lund, A",new,,,,,\n',
		});
		// A cell that already says it is no change; a key as an object reads the same; null empties an optional cell.
		expect(set({ order: "1042" }, { status: "packed", boxes: null })).toMatchObject({
			ok: true,
			changes: [{ column: "boxes", before: "2", after: null }],
		});
		expect(set("1042", { status: "packed" })).toEqual({ ok: false, error: "That row already says this" });
	});

	it("refuses what a page may not change: a key, who holds or does something, and what does not fit", () => {
		const refused = (plan: ReturnType<typeof set>) => (plan.ok ? "saved" : plan.error);
		expect(refused(set("1042", { order: "9" }))).toBe("order is the row's key: a key does not change");
		expect(refused(set("1042", { packer: "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f" }))).toContain("names a member");
		expect(refused(set("1042", { agent: null }))).toContain("names a member or an agent");
		expect(refused(set("1042", { colour: "red" }))).toBe("colour is not a column of that table");
		expect(refused(set("1042", { status: "lost" }))).toBe("status is not one of its choices");
		expect(refused(set("1042", { status: null }))).toBe("status is empty");
		expect(refused(set("1042", { boxes: "many" }))).toBe("boxes is not a number");
		expect(refused(set("1042", { customer: 7 }))).toBe("customer does not take a number");
		expect(refused(set("1042", { status: true }))).toBe("status is not a yes-no column");
		expect(refused(set("1042", { customer: { a: 1 } }))).toContain("customer takes text");
		expect(refused(set("1042", { customer: "x".repeat(501) }))).toContain("longer than 500");
		expect(refused(set("9999", { status: "new" }))).toBe("No row has that key");
		expect(refused(set(undefined, { status: "new" }))).toContain("setRow takes the row's key");
		expect(refused(set("1042", {}))).toBe("setRow takes 1 to 12 cells");
		// Rows that do not fit their table would be lost by a rewrite: nothing is planned over them.
		expect(refused(set("1042", { status: "new" }, `${ROWS}1044,Broken,nowhere,,,,,\n`))).toContain("have problems");
	});

	it("adds a row at the end, in the file's own column order, and never a second one with the same key", () => {
		expect(add({ order: "1044", customer: 'Berg "B"', status: "new" })).toEqual({
			ok: true,
			row: null,
			changes: [
				{ column: "order", before: null, after: "1044" },
				{ column: "customer", before: null, after: 'Berg "B"' },
				{ column: "status", before: null, after: "new" },
			],
			text: `${ROWS}1044,"Berg ""B""",new,,,,,\n`,
		});
		expect(add({ order: "1042", customer: "Again", status: "new" })).toEqual({
			ok: false,
			error: "A row with that key is already there",
		});
		expect(add({ order: "1044", status: "new" })).toEqual({ ok: false, error: "A new row needs customer" });
		expect(add({ order: "1044", customer: "Berg", status: "new", packer: null })).toMatchObject({ ok: false });
		// A first line that leaves an optional column out gets it, as a claim adds one.
		const short = "order,customer,status\n1042,Hansen,packed\n";
		expect(add({ order: "1044", customer: "Berg", status: "new", boxes: 1 }, short)).toMatchObject({
			ok: true,
			text: "order,customer,status,boxes\n1042,Hansen,packed,\n1044,Berg,new,1\n",
		});
	});
});

/** A member's folder that can be written: read, readFile and commit as the cloud client answers them. */
function memberFolder(files: Record<string, string>) {
	let versions = 0;
	const version = () => `00000000-0000-4000-8000-${String(++versions).padStart(12, "0")}`;
	const store = new Map(Object.entries(files).map(([path, text]) => [path, { text, version: version() }]));
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	const reads: string[] = [];
	const commits: CloudMemberFolderUnit[] = [];
	const entry = (path: string): CloudMemberFolderEntry | null => {
		const file = store.get(path);
		if (!file) return null;
		return {
			path,
			kind: "file",
			version: file.version,
			seq: 1,
			updatedAt: "2026-11-10T00:00:00Z",
			file: {
				manifestSha256: sha(`${path}:${file.version}`),
				fileSha256: sha(file.text),
				bytes: new TextEncoder().encode(file.text).byteLength,
				mediaType: "text/plain",
				executable: false,
			},
			target: null,
		};
	};
	const folder = {
		read: async (path: string) => {
			reads.push(path);
			return { asOfSeq: 1, entry: entry(path) };
		},
		list: async () => ({ asOfSeq: 1, entries: [], next: null }),
		readFile: async (file: { fileSha256: string }) => {
			const found = [...store.values()].find((each) => sha(each.text) === file.fileSha256);
			if (!found) throw new Error("no such file");
			return new TextEncoder().encode(found.text);
		},
		stateFolders: async () => {
			throw new Error("not read here");
		},
		commit: async (_key: string, units: readonly CloudMemberFolderUnit[]): Promise<CloudMemberFolderCommit> => {
			const results = units.map((unit, index) => {
				commits.push(unit);
				if (unit.op !== "write" || !("text" in unit)) throw new Error("only text writes here");
				const now = store.get(unit.path);
				const saved = now !== undefined && now.version === unit.expectedVersion;
				if (saved) store.set(unit.path, { text: unit.text, version: version() });
				return {
					unit: index + 1,
					op: unit.op,
					path: unit.path,
					to: null,
					version: saved ? (store.get(unit.path)?.version ?? null) : null,
					outcome: saved ? ("saved" as const) : ("conflict" as const),
					reason: saved ? null : "version_changed",
					problems: [],
				};
			});
			return { commitId: version(), seq: 2, replay: false, units: results };
		},
	};
	return {
		folder: folder as never as WebMemberFolder,
		reads,
		commits,
		text: (path: string) => store.get(path)?.text,
		/** Another writer's save. */
		put: (path: string, text: string) => store.set(path, { text, version: version() }),
	};
}

/** A gate that answers as a member would, without a screen: what it was asked, then yes or not now. A note goes with
 * `words`, as the member left them in the bar's field. */
function gateThat(decide: "allow" | "decline", before?: () => void, words = "") {
	const asked: AppAsk[] = [];
	const gate: AppGate = {
		closed: () => null,
		ask: async (ask, perform) => {
			asked.push(ask);
			if (decide === "decline") return { outcome: "declined" };
			before?.();
			try {
				const note = await perform(words);
				return note ? { outcome: "told", sent: note.sent } : { outcome: "saved" };
			} catch (error) {
				return { outcome: "failed", message: error instanceof AppActionRefused ? error.message : "failed" };
			}
		},
	};
	return { gate, asked };
}

const AGENT = "22222222-2222-4222-8222-222222222222";
const CARD = "44444444-4444-4444-8444-00000000000a";
const OTHER = "44444444-4444-4444-8444-00000000000b";

function card(id: string, app: string, more: Record<string, unknown> = {}): OpenQuestion {
	const listed = {
		sessionId: "11111111-1111-4111-8111-111111111111",
		interactionId: id,
		sequence: 7,
		actorUserId: "33333333-3333-4333-8333-333333333333",
		staffAgentId: AGENT,
		body: {
			entry: {
				type: "custom",
				customType: "interaction_request",
				data: {
					schema: "qorpera.interaction/v1",
					surface: "question",
					title: "Which launch price?",
					body: `See [the prices](app:${app}).`,
					payload: {
						options: [
							{ label: "99 kr a month", value: "99" },
							{ label: "149 kr a month", value: "149", description: "With support" },
						],
						...more,
					},
				},
			},
		},
		createdAt: "2026-11-10T10:00:00Z",
	};
	const parsed = parseOpenQuestions({ schema: "qorpera.open-questions/v1", questions: [listed] })[0];
	if (!parsed) throw new Error("card");
	return parsed;
}

function questionsOf(cards: OpenQuestion[]) {
	const store = new Store<OpenQuestionsState>({ questions: cards, read: true, unavailable: false });
	const questions = {
		store,
		refresh: vi.fn(async () => {}),
		answer: vi.fn(async () => {}),
		forget: vi.fn((id: string) =>
			store.set({ questions: store.get().questions.filter((each) => each.interactionId !== id) }),
		),
	};
	return {
		questions,
		host: {
			questions,
			agent: () => ({ displayName: "Bob" }),
			conversation: () => ({ get: () => ({ interactionError: "No model account is connected for this chat." }) }),
		} as never as NonNullable<AppBridgeHost["questions"]>,
	};
}

describe("the bridge's requests for a change", () => {
	const app = (toml: string): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest(`name = "Orders"\n${toml}`);
		if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.message).join("; "));
		return {
			name: "orders-board",
			path: "apps/orders-board",
			manifest: parsed.manifest,
			problems: [],
			version: null,
		};
	};
	const bridge = (
		toml: string,
		parts: {
			folder?: ReturnType<typeof memberFolder>;
			gate?: AppGate;
			questions?: AppBridgeHost["questions"];
			tell?: AppTellSource;
		},
	) => {
		const folder = parts.folder ?? memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		return new AppBridge(
			{
				folder: () => folder.folder,
				agents: () => [],
				writer: () => folder.folder,
				current: () => {},
				...(parts.questions ? { questions: parts.questions } : {}),
				...(parts.tell ? { tell: parts.tell } : {}),
			},
			app(toml),
			crypto.randomUUID(),
			new AbortController().signal,
			parts.gate,
		);
	};
	const ship = { method: "setRow", params: { table: "orders", key: "1042", cells: { status: "shipped" } } };

	it("asks for nothing the manifest's writes does not name", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const { gate, asked } = gateThat("allow");
		for (const toml of ["", 'reads = ["tables"]\n', 'writes = ["answers"]\n', 'writes = ["table:leads"]\n'])
			expect(await bridge(toml, { folder, gate }).answer(ship)).toEqual({
				ok: false,
				error: 'Add "table:<name>" to writes in app.toml to change rows of that table',
			});
		expect(
			await bridge('writes = ["table:orders"]\n', { folder, gate }).answer({
				method: "answer",
				params: { id: CARD, value: "149" },
			}),
		).toEqual({ ok: false, error: 'Add "answers" to writes in app.toml to answer a question from the page' });
		// Nothing was read for it, nothing shown, nothing written.
		expect(folder.reads).toEqual([]);
		expect(asked).toEqual([]);
		expect(folder.commits).toEqual([]);
		// A page with no gate (a Company File page, a test harness) changes nothing either.
		expect(await bridge('writes = ["table:orders"]\n', { folder }).answer(ship)).toEqual({
			ok: false,
			error: "Nothing can be changed from this page",
		});
	});

	it("shows the member the row's change and saves it as their own once they allow it", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const { gate, asked } = gateThat("allow");
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate }).answer(ship)).toEqual({
			ok: true,
			value: { saved: true },
		});
		expect(asked).toEqual([
			{
				kind: "row",
				add: false,
				table: "Orders",
				folder: "orders",
				row: "1042",
				changes: [{ column: "status", before: "packed", after: "shipped" }],
			},
		]);
		expect(folder.text(FILE)).toBe(ROWS.replace("1042,Hansen,packed", "1042,Hansen,shipped"));
		// One write of the rows file, over the version that was read.
		expect(folder.commits).toHaveLength(1);
		expect(folder.commits[0]).toMatchObject({ op: "write", path: FILE });
	});

	it("saves nothing when the member says not now, and tells the page so", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const { gate, asked } = gateThat("decline");
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate }).answer(ship)).toEqual({
			ok: false,
			error: "The member said not now",
		});
		expect(asked).toHaveLength(1);
		expect(folder.commits).toEqual([]);
		expect(folder.text(FILE)).toBe(ROWS);
	});

	it("saves nothing when the row is no longer what the member said yes to", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		// Someone else ships the order while the bar is open.
		const { gate } = gateThat("allow", () => folder.put(FILE, ROWS.replace("packed", "new")));
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate }).answer(ship)).toEqual({
			ok: false,
			error: "The row changed while you were deciding. Nothing was saved.",
		});
		expect(folder.commits).toEqual([]);
		expect(folder.text(FILE)).toBe(ROWS.replace("packed", "new"));
	});

	it("still saves when another row changed meanwhile, over the file as it is now", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const { gate } = gateThat("allow", () => folder.put(FILE, ROWS.replace(",new,", ",packed,")));
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate }).answer(ship)).toMatchObject({ ok: true });
		expect(folder.text(FILE)).toBe(
			'order,customer,status,shipped_on,boxes,gift,packer,agent\n1042,Hansen,shipped,,2,,,\n1043,"Lund, A",packed,,,,,\n',
		);
	});

	it("refuses a second request while one waits, before anything is read", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const busy: AppGate = { closed: () => "busy", ask: async () => ({ outcome: "busy" }) };
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate: busy }).answer(ship)).toEqual({
			ok: false,
			error: "Another request is waiting for the member's answer",
		});
		const quiet: AppGate = { closed: () => "quiet", ask: async () => ({ outcome: "quiet" }) };
		expect(await bridge('writes = ["table:orders"]\n', { folder, gate: quiet }).answer(ship)).toMatchObject({
			ok: false,
			error: expect.stringContaining("three times"),
		});
		expect(folder.reads).toEqual([]);
	});

	it("adds a row, and never writes the table the Members page keeps", async () => {
		const folder = memberFolder({ [TABLE]: ORDERS, [FILE]: ROWS });
		const { gate, asked } = gateThat("allow");
		const made = await bridge('writes = ["table:orders"]\n', { folder, gate }).answer({
			method: "addRow",
			params: { table: "orders", cells: { order: "1044", customer: "Berg", status: "new" } },
		});
		expect(made).toEqual({ ok: true, value: { saved: true } });
		expect(asked[0]).toMatchObject({ kind: "row", add: true, row: null });
		expect(folder.text(FILE)).toBe(`${ROWS}1044,Berg,new,,,,,\n`);
		// `areas` cannot be listed in a manifest, so no request for it ever passes the first check.
		expect(parseAppManifest('name = "A"\nwrites = ["table:areas"]\n').ok).toBe(false);
	});

	it("hands a page the open questions that point at it, and nothing about who the member is", async () => {
		const { host } = questionsOf([card(CARD, "orders-board"), card(OTHER, "another-app")]);
		expect(await bridge("", { questions: host }).answer({ method: "questions", params: {} })).toMatchObject({
			ok: false,
		});
		expect(
			await bridge('reads = ["questions"]\n', { questions: host }).answer({ method: "questions", params: {} }),
		).toEqual({
			ok: true,
			value: [
				{
					id: CARD,
					agent: "Bob",
					title: "Which launch price?",
					body: "See [the prices](app:orders-board).",
					options: [
						{ label: "99 kr a month", value: "99", description: "" },
						{ label: "149 kr a month", value: "149", description: "With support" },
					],
					multiSelect: false,
					askedAt: "2026-11-10T10:00:00Z",
				},
			],
		});
	});

	it("answers a question that points at the app with one of its own options, once the member allows it", async () => {
		const { host, questions } = questionsOf([card(CARD, "orders-board"), card(OTHER, "another-app")]);
		const { gate, asked } = gateThat("allow");
		const answer = (id: string, value: unknown) =>
			bridge('writes = ["answers"]\n', { gate, questions: host }).answer({
				method: "answer",
				params: { id, value },
			});
		// Not a card of another app, not a typed answer, not two answers to a card that takes one.
		expect(await answer(OTHER, "149")).toEqual({
			ok: false,
			error: "No open question with that id points at this app",
		});
		expect(await answer(CARD, "free of charge")).toEqual({
			ok: false,
			error: "An answer from a page is one of the question's own options",
		});
		expect(await answer(CARD, ["99", "149"])).toEqual({ ok: false, error: "That question takes one answer" });
		expect(await answer("not-an-id", "149")).toMatchObject({ ok: false });
		expect(asked).toEqual([]);
		expect(questions.answer).not.toHaveBeenCalled();

		expect(await answer(CARD, "149")).toEqual({ ok: true, value: { saved: true } });
		// The bar's words are the card's own: its title and the option's label.
		expect(asked).toEqual([
			{ kind: "answer", agentId: AGENT, question: "Which launch price?", answers: ["149 kr a month"] },
		]);
		expect(questions.answer).toHaveBeenCalledWith(expect.objectContaining({ interactionId: CARD }), "answered", {
			values: ["149"],
		});
		// Off the list at once, for the page and for the dock beside it.
		expect(questions.forget).toHaveBeenCalledWith(CARD);
	});

	it("says why an answer was refused, in the thread's own words", async () => {
		const { host, questions } = questionsOf([card(CARD, "orders-board")]);
		questions.answer.mockRejectedValueOnce(new Error("refused"));
		const { gate } = gateThat("allow");
		expect(
			await bridge('writes = ["answers"]\n', { gate, questions: host }).answer({
				method: "answer",
				params: { id: CARD, value: "99" },
			}),
		).toEqual({ ok: false, error: "No model account is connected for this chat." });
		expect(questions.forget).not.toHaveBeenCalled();
	});

	/** Who hears a note and how its send goes, as app/tell-agent.ts answers for the open company. */
	const notes = (
		receiver: ReturnType<AppTellSource["receiver"]> = { agentId: AGENT },
		went: AppNoteSent | Error = { sent: true, href: `#/c/p/staff/${AGENT}` },
	) => {
		const kept = new Map<string, HeldNote>();
		const source = {
			receiver: vi.fn((_owner: string | null) => receiver),
			agent: () => undefined,
			send: vi.fn(async (_agentId: string, _note: { header: string; text: string }) => {
				if (went instanceof Error) throw went;
				return went;
			}),
			held: (app: string) => kept.get(app),
			hold: (app: string, note: HeldNote | undefined) => {
				if (note) kept.set(app, note);
				else kept.delete(app);
			},
			listen: () => () => {},
			kept,
		} satisfies AppTellSource & { kept: Map<string, HeldNote> };
		return source;
	};
	const tell = (params: Record<string, unknown>) => ({ method: "tell", params });
	const lund = { about: "Lund, A", at: "1043", text: "Get a quote from this one." };

	it("lets any app ask the member to send its owner a note, with no word in writes, and sends what the member wrote", async () => {
		const source = notes();
		const { gate, asked } = gateThat("allow", undefined, "  Get two quotes, please.\n");
		const owned = 'owner = "22222222-2222-4222-8222-222222222222"\n';
		expect(await bridge(owned, { gate, tell: source }).answer(tell(lund))).toEqual({
			ok: true,
			value: { sent: true },
		});
		// Who hears it comes from the manifest's owner, never from the page.
		expect(source.receiver).toHaveBeenCalledWith(AGENT);
		// The bar shows the page's words only as what the note is about, and its draft only in the member's field.
		expect(asked).toEqual([
			{ kind: "tell", agentId: AGENT, app: "Orders", about: "Lund, A", draft: "Get a quote from this one." },
		]);
		// What goes is what the field held, under the line it answers: the app, the thing and what it is about, which the
		// message opens with once sent (app/tell-agent.ts).
		expect(source.send).toHaveBeenCalledExactlyOnceWith(AGENT, {
			header: "app:orders-board#1043 · Lund, A",
			text: "Get two quotes, please.",
		});
		// With no thing named, the first line names the app alone; an app with no owner is the receiver's to place.
		const other = notes();
		const words = gateThat("allow", undefined, "Why so many?");
		expect(await bridge("", { gate: words.gate, tell: other }).answer(tell({ about: "Returns" }))).toMatchObject({
			ok: true,
		});
		expect(other.receiver).toHaveBeenCalledWith(null);
		expect(other.send).toHaveBeenCalledWith(AGENT, { header: "app:orders-board · Returns", text: "Why so many?" });
		// Nothing goes where no note can be sent (a Company File page, a test harness).
		expect(await bridge("", { tell: notes() }).answer(tell(lund))).toEqual({
			ok: false,
			error: "Nothing can be sent from this page",
		});
		expect(await bridge("", { gate }).answer(tell(lund))).toEqual({
			ok: false,
			error: "Nothing can be sent from this page",
		});
	});

	it("refuses a note the page shaped wrong before any bar: what it is about, the thing's id, a long draft", async () => {
		const source = notes();
		const { gate, asked } = gateThat("allow", undefined, "Yes");
		const answer = (params: Record<string, unknown>) => bridge("", { gate, tell: source }).answer(tell(params));
		const about = "tell takes about: what the note is about, 1 to 60 characters";
		for (const wrong of [{}, { about: "" }, { about: " @«»\n " }, { about: 7 }, { about: "x".repeat(61) }])
			expect(await answer(wrong)).toEqual({ ok: false, error: about });
		for (const at of ["not an id", "-first", "x".repeat(65), 1043])
			expect(await answer({ about: "Lund", at })).toEqual({
				ok: false,
				error: "tell's at is the thing's id: up to 64 letters, digits and _ . : -",
			});
		expect(await answer({ about: "Lund", text: "x".repeat(281) })).toEqual({
			ok: false,
			error: "tell's text is at most 280 characters",
		});
		expect(await answer({ about: "Lund", text: ["words"] })).toEqual({
			ok: false,
			error: "tell's text is a draft of the member's words",
		});
		expect(asked).toEqual([]);
		expect(source.send).not.toHaveBeenCalled();
		// At the bounds, and as the frame document hands it over (an absent `at` and `text` come as null).
		expect(await answer({ about: "é".repeat(60), at: "lane:step.2_b-1", text: "x".repeat(280) })).toMatchObject({
			ok: true,
		});
		expect(await answer({ about: "Lund", at: null, text: null })).toMatchObject({ ok: true });
		expect(asked.map((ask) => ask.kind === "tell" && ask.draft.length)).toEqual([280, 0]);
	});

	it("makes what a note is about one line that names nobody, quotes nothing and turns no text around", async () => {
		const source = notes();
		const { gate, asked } = gateThat("allow", undefined, "Yes");
		await bridge("", { gate, tell: source }).answer(
			tell({ about: "  Ask @Bea\nabout «this»‮\tnow\u0007 ", text: "Hi @Bea «quoted»" }),
		);
		expect(asked).toEqual([
			{ kind: "tell", agentId: AGENT, app: "Orders", about: "Ask Bea about this now", draft: "Hi @Bea «quoted»" },
		]);
		expect(source.send).toHaveBeenCalledWith(AGENT, {
			header: "app:orders-board · Ask Bea about this now",
			text: "Yes",
		});
	});

	it("tells the page whether the note went or waits in the agent's thread, and why one did not go", async () => {
		const answer = (source: AppTellSource, gate: AppGate) => bridge("", { gate, tell: source }).answer(tell(lund));
		const yes = gateThat("allow", undefined, "Please").gate;
		// Waiting in the thread, the note is no longer the app's to keep; nor is a new note that did not go.
		const waits = notes(undefined, { sent: false, href: "#/c/p/staff/a" });
		expect(await answer(waits, yes)).toEqual({
			ok: true,
			value: { sent: false, waiting: true },
		});
		expect(waits.kept.size).toBe(0);
		const failing = notes(undefined, new Error("That agent is no longer at work."));
		expect(await answer(failing, yes)).toEqual({
			ok: false,
			error: "That agent is no longer at work.",
		});
		expect(failing.kept.size).toBe(0);
		// The Send is off while the field is empty; were it pressed, nothing would go.
		const empty = notes();
		expect(await answer(empty, gateThat("allow", undefined, "  \n").gate)).toEqual({
			ok: false,
			error: "Write your note first.",
		});
		expect(empty.send).not.toHaveBeenCalled();
		expect(await answer(notes(), gateThat("decline").gate)).toEqual({ ok: false, error: "The member said not now" });
		// Nobody to hear it, or a member who may not write: refused before any bar.
		const { gate, asked } = gateThat("allow");
		expect(await answer(notes({ refused: "The member may not send messages in this company" }), gate)).toEqual({
			ok: false,
			error: "The member may not send messages in this company",
		});
		expect(asked).toEqual([]);
		// One request at a time, as for every request.
		const busy: AppGate = { closed: () => "busy", ask: async () => ({ outcome: "busy" }) };
		const waiting = notes();
		expect(await answer(waiting, busy)).toEqual({
			ok: false,
			error: "Another request is waiting for the member's answer",
		});
		expect(waiting.receiver).not.toHaveBeenCalled();
	});

	it("keeps a note its thread can't take for the app, and refuses the page's next note while it is kept", async () => {
		const source = notes(undefined, { sent: false, href: "#/c/p/staff/a", held: true });
		const { gate } = gateThat("allow", undefined, "Two quotes");
		expect(await bridge("", { gate, tell: source }).answer(tell(lund))).toEqual({
			ok: true,
			value: { sent: false, waiting: true },
		});
		expect(source.kept.get("orders-board")).toEqual({
			agentId: AGENT,
			app: "Orders",
			about: "Lund, A",
			header: "app:orders-board#1043 · Lund, A",
			words: "Two quotes",
		});
		// One note an app: the page's next one, about this thing or another, is refused while that one is kept (a held
		// note leaves no pause, so this is not the pause speaking), and the kept note is the bar's again.
		const shown = gateThat("decline");
		const again = bridge("", { gate: shown.gate, tell: source });
		for (const params of [lund, { about: "Hansen", at: "1042" }])
			expect(await again.answer(tell(params))).toEqual({
				ok: false,
				error: "An earlier note from this app is still waiting above the page: send it or say not now first",
			});
		expect(shown.asked).toContainEqual(
			expect.objectContaining({ kind: "tell", about: "Lund, A", draft: "Two quotes", held: true }),
		);
		expect(source.send).toHaveBeenCalledOnce();
		// On its way, it is said so.
		source.kept.set("orders-board", { ...source.kept.get("orders-board")!, sending: true });
		expect(await again.answer(tell(lund))).toEqual({
			ok: false,
			error: "A note from this app is on its way: ask again in a moment",
		});
	});

	it("costs five calls, and after a sent note refuses the app's next one for ten seconds", async () => {
		vi.useFakeTimers({ now: Date.parse("2026-11-13T10:00:05Z") });
		try {
			const source = notes();
			const { gate, asked } = gateThat("allow", undefined, "Please");
			const one = bridge("", { gate, tell: source });
			expect(await one.answer(tell(lund))).toMatchObject({ ok: true });
			expect(await one.answer(tell(lund))).toEqual({
				ok: false,
				error: "A note was sent from this app a moment ago: ask again in a few seconds",
			});
			vi.advanceTimersByTime(TELL_AGAIN_MS - 1);
			expect(await one.answer(tell(lund))).toMatchObject({ ok: false });
			vi.advanceTimersByTime(1);
			expect(await one.answer(tell(lund))).toMatchObject({ ok: true });
			expect(asked).toHaveLength(2);
			// A note said not now leaves no pause.
			const declined = bridge("", { gate: gateThat("decline").gate, tell: notes() });
			expect(await declined.answer(tell(lund))).toMatchObject({ error: "The member said not now" });
			expect(await declined.answer(tell(lund))).toMatchObject({ error: "The member said not now" });
			// Five of the minute's 120 calls each: the 25th in a minute is over the budget, before anything is checked.
			const many = notes({ refused: "nobody" });
			const spent = bridge("", { gate, tell: many });
			for (let call = 1; call <= 24; call++)
				expect(await spent.answer(tell(lund))).toMatchObject({ error: "nobody" });
			expect(await spent.answer(tell(lund))).toEqual({
				ok: false,
				error: "Too many calls: wait a moment and try again",
			});
			expect(many.receiver).toHaveBeenCalledTimes(24);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('a link the member clicks in an app\'s page (Jonas, 13 November 2026: "Show the address first")', () => {
	const app = (): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest('name = "Concepts"\n');
		if (!parsed.ok) throw new Error("manifest");
		return { name: "concepts", path: "apps/concepts", manifest: parsed.manifest, problems: [], version: null };
	};
	/** A bridge whose links are followed into `followed`, with a gate that answers as the member would on the bar. */
	const linked = (decide: "open" | "decline" | "busy" = "open") => {
		const followed: unknown[] = [];
		const asked: AppAsk[] = [];
		let opened = 0;
		const gate: AppGate = {
			closed: () => (decide === "busy" ? "busy" : null),
			ask: async (ask, perform) => {
				asked.push(ask);
				if (decide !== "open") return { outcome: "declined" };
				// Nothing of this request is followed before the member's press: the press is perform.
				expect(followed).toHaveLength(opened);
				opened++;
				await perform("");
				return { outcome: "opened" };
			},
		};
		const key = crypto.randomUUID();
		const bridge = new AppBridge(
			{ folder: () => memberFolder({}).folder, agents: () => [] },
			app(),
			key,
			new AbortController().signal,
			gate,
			(link) => followed.push(link),
		);
		return { bridge, followed, asked, opened: () => opened };
	};
	const click = (bridge: AppBridge, href: string) => bridge.answer({ method: "open", params: { href } });
	const whole = "https://example.com/pricing?plan=team&email=ada%40lund.dk#top";

	it("puts a web page on the bar with its whole address, and opens it only when the member pressed Open", async () => {
		const { bridge, followed, asked } = linked();
		expect(await click(bridge, whole)).toEqual({ ok: true, value: null });
		expect(asked).toEqual([{ kind: "link", href: whole }]);
		expect(followed).toEqual([{ kind: "web", href: whole }]);
	});

	it("opens nothing when the member says not now, or while another request waits", async () => {
		for (const decide of ["decline", "busy"] as const) {
			const { bridge, followed } = linked(decide);
			expect(await click(bridge, whole), decide).toMatchObject({ ok: false });
			expect(followed).toEqual([]);
		}
	});

	it("refuses an address with a name or password in it before any bar, as before", async () => {
		const { bridge, followed, asked } = linked();
		for (const href of [
			"https://ada:secret@example.com/",
			"https://ada@example.com/",
			"javascript:alert(1)",
			"mailto:a@b.dk",
		])
			expect(await click(bridge, href), href).toMatchObject({ ok: false });
		expect(asked).toEqual([]);
		expect(followed).toEqual([]);
	});

	it("opens another app and a company file at once, with no bar, as before", async () => {
		const { bridge, followed, asked } = linked();
		expect(await click(bridge, "app:sales")).toEqual({ ok: true, value: null });
		expect(await click(bridge, "folder:strategy/plan%202027.md")).toEqual({ ok: true, value: null });
		expect(asked).toEqual([]);
		expect(followed).toEqual([
			{ kind: "app", name: "sales" },
			{ kind: "file", path: "strategy/plan 2027.md" },
		]);
	});

	it("costs a web page's link what any request costs: five calls of the minute's budget", async () => {
		const { bridge, opened } = linked();
		// 120 calls a minute: 24 web links fit, and the 25th is refused before any bar.
		for (let index = 0; index < 24; index++)
			expect(await click(bridge, `${whole}${index}`)).toMatchObject({ ok: true });
		expect(await click(bridge, whole)).toEqual({ ok: false, error: "Too many calls: wait a moment and try again" });
		expect(opened()).toBe(24);
	});
});

describe("the bar a request is put to the member on", () => {
	const change: AppAsk = {
		kind: "row",
		add: false,
		table: "Orders",
		folder: "orders",
		row: "1042",
		changes: [
			{ column: "status", before: "packed", after: "shipped" },
			{ column: "shipped_on", before: null, after: "2026-11-10" },
		],
	};
	let stage: HTMLElement;
	let open: boolean[];
	const make = (agent?: HostedStaffAgent) => {
		const bar = new AppAskBar({
			emblem: () => document.createElement("span"),
			agent: () => agent,
			open: (now) => open.push(now),
		});
		stage.prepend(bar.el);
		return bar;
	};
	const button = (bar: AppAskBar, text: string) =>
		[...bar.el.querySelectorAll("button")].find((each) => each.textContent === text) as HTMLButtonElement;
	/** A press that begins now, then its click. */
	const press = (target: HTMLButtonElement) => {
		target.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		target.click();
	};

	beforeEach(() => {
		vi.useFakeTimers();
		open = [];
		stage = document.createElement("section");
		stage.append(document.createElement("iframe"));
		document.body.append(stage);
	});
	afterEach(() => {
		vi.useRealTimers();
		stage.remove();
	});

	it("says what will be saved, with the focus on Not now and the yes button asleep", () => {
		const bar = make();
		void bar.ask(change, async () => undefined);
		expect(bar.el.hidden).toBe(false);
		expect(bar.el.querySelector(".app-ask-title")?.textContent).toBe(
			"This app wants to change a row in a company table",
		);
		const lines = [...bar.el.querySelectorAll("dt")].map((term) => [
			term.textContent,
			term.nextElementSibling?.textContent,
		]);
		expect(lines).toEqual([
			["Table", "Orders"],
			["Row", "1042"],
			["status", "packed→shipped"],
			["shipped_on", "empty→2026-11-10"],
		]);
		expect(document.activeElement).toBe(button(bar, "Not now"));
		expect(button(bar, "Change row").disabled).toBe(true);
		expect(open).toEqual([true]);
		expect(bar.closed()).toBe("busy");
	});

	it("takes a yes only from a press that began after the button woke", async () => {
		const bar = make();
		const perform = vi.fn(async () => undefined);
		const outcome = bar.ask(change, perform);
		const yes = button(bar, "Change row");
		// A click on its way when the bar came in: the button is asleep.
		press(yes);
		yes.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
		expect(yes.disabled).toBe(false);
		// The press began before it woke: its click is not a yes. Nor is Enter from anywhere but the button.
		yes.click();
		expect(perform).not.toHaveBeenCalled();
		press(yes);
		expect(perform).toHaveBeenCalledTimes(1);
		expect(await outcome).toEqual({ outcome: "saved" });
		expect(bar.el.textContent).toContain("Saved");
		expect(bar.closed()).toBeNull();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(bar.el.hidden).toBe(true);
		expect(open).toEqual([true, false, false]);
	});

	it("takes a yes from the keyboard only when the key was pressed on the awake button", async () => {
		const bar = make();
		const perform = vi.fn(async () => undefined);
		const outcome = bar.ask(change, perform);
		const yes = button(bar, "Change row");
		await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
		yes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
		yes.click();
		expect(perform).not.toHaveBeenCalled();
		yes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		yes.click();
		expect(perform).toHaveBeenCalledTimes(1);
		expect(await outcome).toEqual({ outcome: "saved" });
	});

	it("shows one request at a time, and none after three Not now in a row until the member reloads", async () => {
		const bar = make();
		const first = bar.ask(change, async () => undefined);
		expect(await bar.ask(change, async () => undefined)).toEqual({ outcome: "busy" });
		button(bar, "Not now").click();
		expect(await first).toEqual({ outcome: "declined" });
		expect(bar.el.hidden).toBe(true);
		for (let round = 2; round <= 3; round++) {
			const next = bar.ask(change, async () => undefined);
			button(bar, "Not now").click();
			expect(await next).toEqual({ outcome: "declined" });
		}
		expect(bar.el.textContent).toContain("This app asked three times");
		expect(bar.closed()).toBe("quiet");
		expect(await bar.ask(change, async () => undefined)).toEqual({ outcome: "quiet" });
		bar.reset();
		expect(bar.closed()).toBeNull();
		expect(bar.el.hidden).toBe(true);
	});

	it("starts the count again after a yes", async () => {
		const bar = make();
		for (let round = 1; round <= 2; round++) {
			const asked = bar.ask(change, async () => undefined);
			button(bar, "Not now").click();
			await asked;
		}
		const allowed = bar.ask(change, async () => undefined);
		await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
		press(button(bar, "Change row"));
		expect(await allowed).toEqual({ outcome: "saved" });
		const again = bar.ask(change, async () => undefined);
		button(bar, "Not now").click();
		await again;
		expect(bar.closed()).toBeNull();
	});

	it("says why a change was not saved, and puts a waiting request away with its page", async () => {
		const bar = make();
		const failed = bar.ask(change, async () => {
			throw new AppActionRefused("The row changed while you were deciding. Nothing was saved.");
		});
		await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
		press(button(bar, "Change row"));
		expect(await failed).toEqual({
			outcome: "failed",
			message: "The row changed while you were deciding. Nothing was saved.",
		});
		expect(bar.el.querySelector('[role="alert"]')?.textContent).toBe(
			"The row changed while you were deciding. Nothing was saved.",
		);
		// A new request takes a settled bar's place at once; the page it came from goes, and it goes unsaved.
		const perform = vi.fn(async () => undefined);
		const waiting = bar.ask(change, perform);
		bar.cancel();
		expect(await waiting).toEqual({ outcome: "gone" });
		expect(bar.el.hidden).toBe(true);
		expect(perform).not.toHaveBeenCalled();
	});

	it("shows a value's line breaks as a mark, so a value draws no lines of its own", () => {
		const bar = make();
		void bar.ask(
			{
				kind: "row",
				add: false,
				table: "Orders",
				folder: "orders",
				row: "1042",
				changes: [{ column: "note", before: null, after: "Call first\nshipped_on  empty → 2026-11-10" }],
			},
			async () => undefined,
		);
		expect([...bar.el.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Table", "Row", "note"]);
		expect(bar.el.querySelector("dd:last-child .app-ask-value")?.textContent).toBe(
			"Call first ↵ shipped_on  empty → 2026-11-10",
		);
	});

	it("names the agent an answer goes to, and the answer in the card's words", () => {
		const bar = make();
		void bar.ask(
			{ kind: "answer", agentId: AGENT, question: "Which launch price?", answers: ["149 kr a month"] },
			async () => undefined,
		);
		expect(bar.el.querySelector(".app-ask-title")?.textContent).toBe(
			"This app wants to send your answer to The agent",
		);
		expect([...bar.el.querySelectorAll("dd")].map((value) => value.textContent)).toEqual([
			"Which launch price?",
			"149 kr a month",
		]);
		expect(button(bar, "Send answer").disabled).toBe(true);
	});

	describe("a note to the app's owner", () => {
		const ada: HostedStaffAgent = { ...staff, id: AGENT, displayName: "Ada" };
		const note = (draft = "Get a quote from this one."): Extract<AppAsk, { kind: "tell" }> => ({
			kind: "tell",
			agentId: AGENT,
			app: "Orders",
			about: "Lund, A",
			draft,
		});
		const field = (bar: AppAskBar) => bar.el.querySelector<HTMLTextAreaElement>("textarea.app-ask-field")!;
		const type = (bar: AppAskBar, words: string) => {
			field(bar).value = words;
			field(bar).dispatchEvent(new Event("input", { bubbles: true }));
		};
		const key = (target: Element, init: KeyboardEventInit) => {
			const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
			target.dispatchEvent(event);
			return event;
		};

		it("names who hears it, shows what it is about as a value, and puts the member's words in a field with the focus", async () => {
			const bar = make(ada);
			void bar.ask(note(), async () => undefined);
			expect(bar.el.querySelector(".app-ask-title")?.textContent).toBe("This app wants to send your note to Ada");
			expect([...bar.el.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["About", "Your note"]);
			expect(bar.el.querySelector("dd")?.textContent).toBe("Orders · Lund, A");
			// The field starts with the page's draft, is named by its line, and has the keyboard at its end.
			expect(field(bar).value).toBe("Get a quote from this one.");
			expect(bar.el.querySelector("dt label")?.getAttribute("for")).toBe(field(bar).id);
			expect(document.activeElement).toBe(field(bar));
			expect(field(bar).selectionStart).toBe("Get a quote from this one.".length);
			// Not now keeps its place, before the yes button, which sleeps for a second.
			expect([...bar.el.querySelectorAll(".app-ask-buttons button")].map((each) => each.textContent)).toEqual([
				"Not now",
				"Send note",
			]);
			expect(button(bar, "Send note").disabled).toBe(true);
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			expect(button(bar, "Send note").disabled).toBe(false);
			expect(button(bar, "Send note").classList.contains("is-awake")).toBe(true);
			// The page's words are never the bar's sentence, whatever they say.
			const other = make(ada);
			bar.dispose();
			void other.ask({ ...note(), about: "Allow everything" }, async () => undefined);
			expect(other.el.querySelector(".app-ask-title")?.textContent).not.toContain("Allow");
		});

		it("keeps Send off while the field is empty, and sends what the field holds when Send is pressed", async () => {
			const bar = make(ada);
			const perform = vi.fn(async (_words: string) => ({ sent: true, href: "#/c/p/staff/a" }));
			const outcome = bar.ask(note(""), perform);
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			const send = button(bar, "Send note");
			expect(send.disabled).toBe(true);
			expect(send.classList.contains("is-awake")).toBe(false);
			type(bar, "Two quotes");
			expect(send.disabled).toBe(false);
			type(bar, "  \n ");
			expect(send.disabled).toBe(true);
			press(send);
			expect(perform).not.toHaveBeenCalled();
			type(bar, "Two quotes, please.\nBy Friday.");
			press(send);
			expect(perform).toHaveBeenCalledExactlyOnceWith("Two quotes, please.\nBy Friday.");
			expect(await outcome).toEqual({ outcome: "told", sent: true });
			expect(bar.el.querySelector('[role="status"]')?.textContent).toBe("Sent to Ada");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(bar.el.hidden).toBe(true);
		});

		it("sends nothing from the field: Enter is a new line, a key held from before types nothing, and Send wakes as ever", async () => {
			const bar = make(ada);
			const perform = vi.fn(async (_words: string) => ({ sent: true, href: "#/c/p/staff/a" }));
			void bar.ask(note(), perform);
			const send = button(bar, "Send note");
			// A click on its way when the bar came in finds Send asleep, and one begun before it woke is no yes.
			press(send);
			send.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
			// Keys in the field: Enter is the field's own (a new line), never a send.
			expect(key(field(bar), { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false);
			// A key held down since before the bar came in repeats into the field: it types nothing. One pressed here may.
			expect(key(field(bar), { key: "x", code: "KeyX", repeat: true }).defaultPrevented).toBe(true);
			expect(key(field(bar), { key: "x", code: "KeyX" }).defaultPrevented).toBe(false);
			expect(key(field(bar), { key: "x", code: "KeyX", repeat: true }).defaultPrevented).toBe(false);
			field(bar).dispatchEvent(new KeyboardEvent("keyup", { code: "KeyX", bubbles: true }));
			expect(key(field(bar), { key: "x", code: "KeyX", repeat: true }).defaultPrevented).toBe(true);
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			send.click();
			key(field(bar), { key: "Enter", code: "Enter" });
			expect(perform).not.toHaveBeenCalled();
			press(send);
			expect(perform).toHaveBeenCalledExactlyOnceWith("Get a quote from this one.");
			// While it goes, the field and both buttons hold still.
			expect([field(bar).readOnly, send.disabled, button(bar, "Not now").disabled]).toEqual([true, true, true]);
		});

		it("takes Escape as Not now, once for a held key, and three in a row quiet the app until it is reloaded", async () => {
			const bar = make(ada);
			const perform = vi.fn(async (_words: string) => undefined);
			const first = bar.ask(note(), perform);
			// A held Escape (a key from the page, say) says nothing.
			expect(key(field(bar), { key: "Escape", repeat: true }).defaultPrevented).toBe(true);
			expect(bar.el.hidden).toBe(false);
			expect(key(field(bar), { key: "Escape" }).defaultPrevented).toBe(true);
			expect(await first).toEqual({ outcome: "declined" });
			expect(bar.el.hidden).toBe(true);
			const second = bar.ask(note(), perform);
			button(bar, "Not now").click();
			expect(await second).toEqual({ outcome: "declined" });
			const third = bar.ask(note(), perform);
			key(button(bar, "Not now"), { key: "Escape" });
			expect(await third).toEqual({ outcome: "declined" });
			expect(bar.el.textContent).toContain("This app asked three times");
			expect(await bar.ask(note(), perform)).toEqual({ outcome: "quiet" });
			expect(perform).not.toHaveBeenCalled();
			bar.reset();
			expect(bar.closed()).toBeNull();
		});

		it("says when the note waits in the agent's thread, with the way there, and stays until the member goes or closes it", async () => {
			const bar = make(ada);
			const outcome = bar.ask(note(), async () => ({ sent: false, href: "#/c/p/staff/a" }));
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			press(button(bar, "Send note"));
			expect(await outcome).toEqual({ outcome: "told", sent: false });
			expect(bar.el.querySelector('[role="status"]')?.textContent).toBe("Your note waits in Ada's thread");
			const go = bar.el.querySelector<HTMLAnchorElement>("a.app-ask-button")!;
			expect([go.textContent, go.getAttribute("data-href")]).toEqual(["Open", "#/c/p/staff/a"]);
			// The focus was on the bar, and goes to the way there.
			expect(document.activeElement).toBe(go);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(bar.el.hidden).toBe(false);
			// A new request may take its place, as after any settled request; Close puts it away.
			button(bar, "Close").click();
			expect(bar.el.hidden).toBe(true);
		});

		it("keeps a note its thread cannot take now on the bar, with its words, a line why and the way there", async () => {
			const bar = make(ada);
			const perform = vi
				.fn(async (_words: string): Promise<AppNoteSent> => ({ sent: false, href: "#/c/p/staff/a", held: true }))
				.mockResolvedValueOnce({ sent: false, href: "#/c/p/staff/a", held: true });
			const keep = vi.fn((_words: string | undefined) => {});
			const outcome = bar.ask(note(), perform, keep);
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			type(bar, "Two quotes, please.");
			// Nothing is kept before the thread has said it can't take the note.
			expect(keep).not.toHaveBeenCalled();
			press(button(bar, "Send note"));
			await vi.advanceTimersByTimeAsync(0);
			// Still asking: the words as the member left them, both buttons back, and why, with Open.
			expect(bar.el.querySelector(".app-ask-title")?.textContent).toBe("This app wants to send your note to Ada");
			expect([field(bar).value, field(bar).readOnly]).toEqual(["Two quotes, please.", false]);
			expect([button(bar, "Not now").disabled, button(bar, "Send note").disabled]).toEqual([false, false]);
			const held = bar.el.querySelector<HTMLElement>(".app-ask-held")!;
			expect(held.hidden).toBe(false);
			expect(held.textContent).toBe(
				"Ada's thread has a message started. Send or clear it there, then send this note. Open",
			);
			expect(held.querySelector("a")?.getAttribute("data-href")).toBe("#/c/p/staff/a");
			expect(document.activeElement).toBe(field(bar));
			expect(bar.closed()).toBe("busy");
			// From here on the words are kept for the app as the member changes them, so going to look loses nothing.
			type(bar, "Two quotes, please. By Friday.");
			expect(keep).toHaveBeenLastCalledWith("Two quotes, please. By Friday.");
			// Once the thread is free, the next press sends it.
			perform.mockResolvedValueOnce({ sent: true, href: "#/c/p/staff/a" });
			press(button(bar, "Send note"));
			expect(await outcome).toEqual({ outcome: "told", sent: true });
			expect(perform.mock.calls.map((call) => call[0])).toEqual([
				"Two quotes, please.",
				"Two quotes, please. By Friday.",
			]);
		});

		it("shows a kept note with the member's words, and lets it go on Not now", async () => {
			const bar = make(ada);
			const keep = vi.fn((_words: string | undefined) => {});
			const outcome = bar.ask({ ...note("My own words"), held: true }, async () => undefined, keep);
			expect(field(bar).value).toBe("My own words");
			type(bar, "My own words, changed");
			expect(keep).toHaveBeenLastCalledWith("My own words, changed");
			button(bar, "Not now").click();
			expect(keep).toHaveBeenLastCalledWith(undefined);
			expect(await outcome).toEqual({ outcome: "declined" });
		});

		it("says why a note did not go, in the member's words", async () => {
			const bar = make(ada);
			const outcome = bar.ask(note(), async () => {
				throw new AppActionRefused("That agent is no longer at work.");
			});
			await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
			press(button(bar, "Send note"));
			expect(await outcome).toEqual({ outcome: "failed", message: "That agent is no longer at work." });
			expect(bar.el.querySelector('[role="alert"]')?.textContent).toBe("That agent is no longer at work.");
		});
	});
});

describe('a web page a link in the app leads to, on the bar (Jonas, 13 November 2026: "Show the address first")', () => {
	const long =
		"https://shop.example.co.uk:8443/checkout/step-2?email=ada%40lund.dk&card=4242%204242&note=Hej%20med%20dig&ref=lysvaekker-concept#pay-now";
	let stage: HTMLElement;
	const make = () => {
		const bar = new AppAskBar({
			emblem: () => document.createElement("span"),
			agent: () => undefined,
			open: () => {},
		});
		stage.prepend(bar.el);
		return bar;
	};
	const button = (bar: AppAskBar, text: string) =>
		[...bar.el.querySelectorAll("button")].find((each) => each.textContent === text) as HTMLButtonElement;
	const press = (target: HTMLButtonElement) => {
		target.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		target.click();
	};
	const lines = (bar: AppAskBar) =>
		[...bar.el.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);

	beforeEach(() => {
		vi.useFakeTimers();
		stage = document.createElement("section");
		stage.append(document.createElement("iframe"));
		document.body.append(stage);
	});
	afterEach(() => {
		vi.useRealTimers();
		stage.remove();
	});

	it("shows the site first and the whole address, and opens it only on Open, once it woke", async () => {
		const bar = make();
		const perform = vi.fn(async () => undefined);
		const outcome = bar.ask({ kind: "link", href: long }, perform);
		expect(bar.el.querySelector(".app-ask-title")?.textContent).toBe("This app wants to open a web page");
		// The site on its own line, its registered part apart from the labels before it; then the address in full,
		// query and fragment included, as text of the bar's own.
		expect(lines(bar)).toEqual([
			["Site", "shop.example.co.uk:8443"],
			["Address", long],
		]);
		expect(bar.el.querySelector(".app-ask-site-lead")?.textContent).toBe("shop.");
		expect(bar.el.querySelector(".app-ask-site-name")?.textContent).toBe("example.co.uk");
		expect(bar.el.querySelector(".app-ask-site-port")?.textContent).toBe(":8443");
		expect(bar.el.querySelector(".app-ask-address")?.children).toHaveLength(0);
		// Not the default: the focus is on Not now, and Open sleeps a second; a press begun before it woke opens nothing.
		const open = button(bar, "Open");
		expect(document.activeElement).toBe(button(bar, "Not now"));
		expect(open.disabled).toBe(true);
		press(open);
		open.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		await vi.advanceTimersByTimeAsync(ASK_ALLOW_AFTER_MS);
		open.click();
		expect(perform).not.toHaveBeenCalled();
		press(open);
		// The tab opens in the press itself, before anything is awaited.
		expect(perform).toHaveBeenCalledTimes(1);
		expect(await outcome).toEqual({ outcome: "opened" });
		await vi.advanceTimersByTimeAsync(0);
		expect(bar.el.hidden).toBe(true);
		expect(bar.closed()).toBeNull();
	});

	it("opens nothing on Not now or Escape, asks one at a time, and is quiet after three", async () => {
		const bar = make();
		const perform = vi.fn(async () => undefined);
		const first = bar.ask({ kind: "link", href: "https://example.com/" }, perform);
		// A second link while one waits is refused at once.
		expect(await bar.ask({ kind: "link", href: "https://example.org/" }, perform)).toEqual({ outcome: "busy" });
		button(bar, "Not now").click();
		expect(await first).toEqual({ outcome: "declined" });
		const second = bar.ask({ kind: "link", href: "https://example.com/a" }, perform);
		bar.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(await second).toEqual({ outcome: "declined" });
		const third = bar.ask({ kind: "link", href: "https://example.com/b" }, perform);
		button(bar, "Not now").click();
		expect(await third).toEqual({ outcome: "declined" });
		expect(bar.el.textContent).toContain("This app asked three times");
		expect(await bar.ask({ kind: "link", href: "https://example.com/c" }, perform)).toEqual({ outcome: "quiet" });
		expect(perform).not.toHaveBeenCalled();
	});

	it("shows a host as the browser will reach it: punycode as punycode, a short one whole, an address by number whole", () => {
		const shown = (href: string) => {
			const bar = make();
			void bar.ask({ kind: "link", href }, async () => undefined);
			const parts = [".app-ask-site-lead", ".app-ask-site-name"].map(
				(part) => bar.el.querySelector(part)?.textContent,
			);
			bar.dispose();
			return parts;
		};
		expect(shown(new URL("https://bücher.example/").href)).toEqual([undefined, "xn--bcher-kva.example"]);
		expect(shown("https://paypal.com.login.example.net/x")).toEqual(["paypal.com.login.", "example.net"]);
		expect(shown("https://example.com/")).toEqual([undefined, "example.com"]);
		expect(shown("http://192.168.1.20:8080/")).toEqual([undefined, "192.168.1.20"]);
	});
});

describe("a page's Escape while its request waits", () => {
	it("is not passed on, so the page cannot close what it is shown in to dodge the answer", () => {
		const frame = new AppFrame(
			"<p>page</p>",
			"App",
			"frame",
			async () => ({ ok: true, value: null }),
			() => {},
		);
		document.body.append(frame.frame);
		const escapes: string[] = [];
		frame.frame.addEventListener("keydown", (event) => escapes.push(event.key));
		const say = (type: string) => {
			const event = new MessageEvent("message", { data: { type } });
			Object.defineProperty(event, "source", { value: frame.frame.contentWindow });
			window.dispatchEvent(event);
		};
		say(PAGE_READY);
		say(PAGE_ESCAPE);
		frame.holdEscape = true;
		say(PAGE_ESCAPE);
		frame.holdEscape = false;
		say(PAGE_ESCAPE);
		expect(escapes).toEqual(["Escape", "Escape"]);
		frame.dispose();
		frame.frame.remove();
	});
});
