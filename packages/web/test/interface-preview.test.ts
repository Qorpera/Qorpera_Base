// @vitest-environment jsdom

import { interfaceLibraryFiles, NUMBERS_TABLE } from "@qorpera/cloud-client/interface-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { InterfacePreview, proposedSave } from "../src/app/views/interface-preview.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import type { ActionReviewCard } from "../src/cloud/review-rules.ts";
import type { TranscriptItem } from "../src/cloud/transcript.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";
import { renderActionReviewCard } from "../src/ui/authorization-card.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* Interfaces step I10 (RUNTIME-INTERFACES.md §7 and §10): a review card of a page an agent asks to save shows how the
 * page will look, drawn from the folder as read with the tables the save changes read by their new definitions. */

const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const ids = { ledger: id(605), books: id(606), invoices: id(607) };

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	sessionStorage.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company() {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const me: HostedProfileMember = {
		userId: userA.id,
		email: "a@example.invalid",
		displayName: "Account A",
		role: "owner",
		joinedAt: timestamp,
	};
	controller.store.set({
		loading: false,
		staff: [ada],
		sessions: [session],
		team: { ...team, role: "owner", members: [me] },
	});
	cleanup.push(() => controller.stop());
	return controller;
}

/** A folder seeded as at founding: the library's interfaces and tables with fresh ids, and `interfaces/order.md`. */
function seeded(): FolderFake {
	const fake = folderFake({ seed: [] });
	let next = 500;
	for (const [path, text] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, text);
	return fake;
}

/** Follows `fake` for `controller`'s company, as the app does. */
async function follow(fake: FolderFake, controller: CompanyController) {
	let onHint: ((seq: number) => void) | undefined;
	const stop = new AbortController();
	const reader = new CompanyInterfaceFolder(
		{
			signal: stop.signal,
			current: () => {},
			folder: () => fake.folder,
			folderHints: (hint) => {
				onHint = hint;
				return { close: async () => {} };
			},
		},
		(state) => controller.store.set({ interfaceFolder: state }),
	);
	cleanup.push(() => stop.abort());
	await reader.open();
	return {
		reader,
		/** The folder's hint, and the sync it asks for a second later. */
		hint: async () => {
			onHint?.(fake.seq);
			await vi.advanceTimersByTimeAsync(1000);
		},
	};
}

/** A page with a table of `from`'s rows in its first view, and a second view of text unless `only`. */
function page(pageId: string, name: string, from: string, columns: string, only = false): string {
	const first = `format = "qorpera.interface/v0"

[interface]
id = "${pageId}"
name = "${name}"

[[view]]
name = "Now"

[[view.block]]
kind = "table"
title = "${name} rows"
from = "${from}"
columns = ${columns}
`;
	if (only) return first;
	return `${first}
[[view]]
name = "Later"

[[view.block]]
kind = "text"
title = "Later"
text = "Nothing yet."
`;
}

const INVOICES = `format = "qorpera.table/v0"

[table]
id = "${ids.invoices}"
name = "Invoices"
rows = "file"
key = ["number"]

[[column]]
name = "number"
type = "text"

[[column]]
name = "amount"
type = "number"
`;

const NUMBER_ROWS = [
	"number,at,value,unit,target,kept_by",
	`Revenue,2026-10-01T09:00Z,1200,€,,${ada.id}`,
	`Users,2026-10-01T09:00Z,many,count,,${ada.id}`,
	`Churn,2026-10-01T09:00Z,3,%,5,${ada.id}`,
	"",
].join("\n");

/** The card of a save_interface call that saves `files`. */
function card(files: readonly { path: string; expectedVersion: string | null; text: string }[]): ActionReviewCard {
	return {
		reviewId: id(700),
		title: "Change an interface",
		summary: "It changes who can access something.",
		details: [],
		tool: "save_interface",
		arguments: JSON.stringify({ operationKey: "ledger-1", files }),
		builtIn: "access",
		rules: [],
		approverScope: "member",
		alwaysAllow: false,
	};
}

const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const read = (fake: FolderFake) => fake.folder.read.mock.calls.map(([path]) => path);

describe("a review card's preview of a page an agent asks to save (I10)", () => {
	const ledger = page(ids.ledger, "Ledger", "table:numbers", '["number", "value"]');

	it("reads the pages and tables a save would leave from the exact call the card covers", () => {
		const save = proposedSave(
			card([
				{ path: "interfaces/ledger/interface.toml", expectedVersion: null, text: ledger },
				{ path: "tables/numbers/table.toml", expectedVersion: id(800), text: NUMBERS_TABLE },
				{ path: "tables/invoices/table.toml", expectedVersion: null, text: INVOICES },
				{ path: "interfaces/ledger/README.md", expectedVersion: null, text: "# Ledger" },
				{ path: "interfaces/broken/interface.toml", expectedVersion: null, text: "format = 1" },
				{ path: "interfaces/Not-A-Name/interface.toml", expectedVersion: null, text: ledger },
			]),
		);
		expect(save?.pages.map((saved) => [saved.name, saved.file.name])).toEqual([["ledger", "Ledger"]]);
		expect([...(save?.tables ?? [])].map(([name, table]) => [name, table.table.name, table.created])).toEqual([
			["numbers", "Numbers", false],
			["invoices", "Invoices", true],
		]);
		// The call as a tool's input, as an approval may carry it.
		const files = [{ path: "interfaces/ledger/interface.toml", expectedVersion: null, text: ledger }];
		const wrapped = { ...card([]), arguments: JSON.stringify({ input: { operationKey: "ledger-1", files } }) };
		expect(proposedSave(wrapped)?.pages.map((saved) => saved.name)).toEqual(["ledger"]);
		// A save of no page, another tool's call, or a call that can't be read, has no preview.
		const tableOnly = card([{ path: "tables/numbers/table.toml", expectedVersion: id(800), text: NUMBERS_TABLE }]);
		expect(proposedSave(tableOnly)).toBeNull();
		expect(proposedSave({ ...card(files), tool: "table_write" })).toBeNull();
		expect(proposedSave({ ...card(files), arguments: "{" })).toBeNull();
	});

	it("draws a changed table's rows by its new definition, beside the page as it is now", async () => {
		const fake = seeded();
		fake.put("interfaces/ledger/interface.toml", ledger);
		fake.put("tables/numbers/rows.csv", NUMBER_ROWS);
		const controller = company();
		await follow(fake, controller);
		// The value column becomes text: the row the page can't show now fits.
		const definition = fake.text("tables/numbers/table.toml") ?? "";
		const changed = definition.replace('name = "value"\ntype = "number"', 'name = "value"\ntype = "text"');
		expect(changed).not.toBe(definition);
		const save = proposedSave(
			card([
				{ path: "interfaces/ledger/interface.toml", expectedVersion: id(801), text: ledger },
				{ path: "tables/numbers/table.toml", expectedVersion: id(800), text: changed },
			]),
		)!;
		const preview = new InterfacePreview(controller, id(700), save);
		expect(preview.element.hidden).toBe(false);
		expect(texts(preview.element, ".interface-table tbody td:nth-child(2)")).toEqual(["1200", "many", "3"]);
		expect(preview.element.querySelector(".interface-note")).toBeNull();
		expect(preview.element.querySelector("figcaption")?.textContent).toBe("How the page will look");
		const main = h("main");
		renderInterface(main, controller, "ledger");
		expect(texts(main, ".interface-table tbody td:nth-child(2)")).toEqual(["1200", "3"]);
		expect(main.querySelector(".interface-note p")?.textContent).toBe("Some rows can't be shown.");
	});

	it("draws a table the save makes empty, and nothing in it can be used or clash with the page's ids", async () => {
		const fake = seeded();
		const controller = company();
		await follow(fake, controller);
		const save = proposedSave(
			card([
				{
					path: "interfaces/books/interface.toml",
					expectedVersion: null,
					text: page(ids.books, "Books", "table:invoices", '["number", "amount"]'),
				},
				{ path: "tables/invoices/table.toml", expectedVersion: null, text: INVOICES },
			]),
		)!;
		const preview = new InterfacePreview(controller, id(700), save);
		document.body.append(preview.element);
		expect(texts(preview.element, ".interface-table thead th")).toEqual([]);
		expect(preview.element.querySelector(".interface-empty")?.textContent).toBe("Nothing here right now.");
		expect(texts(preview.element, "h1")).toEqual(["Books"]);
		// Its views' tabs are drawn, and none of it answers a click or a key.
		expect(texts(preview.element, "[role=tab]")).toEqual(["Now", "Later"]);
		expect(preview.element.hasAttribute("inert")).toBe(true);
		expect(preview.element.querySelector("[id], [for], [aria-labelledby], [aria-describedby], [aria-controls]")).toBe(
			null,
		);
	});

	it("is drawn under the card only while the card waits", async () => {
		const fake = seeded();
		const controller = company();
		await follow(fake, controller);
		const files = [
			{
				path: "interfaces/books/interface.toml",
				expectedVersion: null,
				text: page(ids.books, "Books", "table:invoices", '["number", "amount"]'),
			},
			{ path: "tables/invoices/table.toml", expectedVersion: null, text: INVOICES },
		];
		const review = card(files);
		const preview = new InterfacePreview(controller, review.reviewId, proposedSave(review)!);
		const memberName = () => "Jonas";
		const pending = renderActionReviewCard(review, undefined, { memberName, preview: preview.element });
		expect(pending.querySelector(".review-preview")).toBe(preview.element);
		expect(pending.querySelector(".review-headline + .review-preview, .review-change + .review-preview")).toBe(
			preview.element,
		);
		const answered = renderActionReviewCard(
			review,
			{ decision: "approved", answer: { answer: "allow_once" }, answeredBy: userA.id },
			{ memberName, preview: preview.element },
		);
		expect(answered.querySelector(".review-preview")).toBeNull();
	});

	it("has the folder read a table only a preview's page reads, while the preview lasts", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		fake.put("tables/invoices/table.toml", INVOICES);
		fake.put("tables/invoices/rows.csv", "number,amount\nA-1,120\nA-2,80\n");
		const controller = company();
		const { reader } = await follow(fake, controller);
		expect(read(fake)).not.toContain("tables/invoices/rows.csv");
		const save = proposedSave(
			card([
				{
					path: "interfaces/books/interface.toml",
					expectedVersion: null,
					text: page(ids.books, "Books", "table:invoices", '["number", "amount"]', true),
				},
			]),
		)!;
		const preview = new InterfacePreview(controller, id(700), save);
		// The table isn't read yet: there is nothing to draw.
		expect(preview.element.hidden).toBe(true);
		const owner = {};
		reader.preview(owner, preview.pages);
		await vi.advanceTimersByTimeAsync(1000);
		expect(read(fake)).toEqual(expect.arrayContaining(["tables/invoices/table.toml", "tables/invoices/rows.csv"]));
		expect(controller.store.get().interfaceFolder?.tables.has("invoices")).toBe(true);
		preview.draw();
		expect(preview.element.hidden).toBe(false);
		expect(texts(preview.element, ".interface-table tbody td:nth-child(1)")).toEqual(["A-1", "A-2"]);
		// Once no preview reads it, the next sync drops it.
		reader.preview(owner, []);
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.store.get().interfaceFolder?.tables.has("invoices")).toBe(false);
	});

	it("shows under a waiting card, drawn again as the folder is read, until the card is answered", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		fake.put("tables/invoices/table.toml", INVOICES);
		fake.put("tables/invoices/rows.csv", "number,amount\nA-1,120\n");
		const controller = company();
		const { reader, hint } = await follow(fake, controller);
		const previewInterfaces = vi.fn<NonNullable<WorkspaceActions["previewInterfaces"]>>((owner, pages) =>
			reader.preview(owner, pages),
		);
		const review = card([
			{
				path: "interfaces/books/interface.toml",
				expectedVersion: null,
				text: page(ids.books, "Books", "table:invoices", '["number", "amount"]', true),
			},
		]);
		const request: TranscriptItem = {
			kind: "authorization_request",
			id: id(710),
			sequence: 1,
			actorUserId: userA.id,
			createdAt: timestamp,
			body: {
				schema: "qorpera.action-review/v1",
				reviewId: review.reviewId,
				title: review.title,
				summary: review.summary,
				tool: "save_interface",
				arguments: review.arguments ?? "",
				builtIn: "access",
				approverScope: "owners_admins",
				alwaysAllow: false,
			},
		};
		const state = controller.conversation(session.sessionId, false);
		state.set({ projection: { items: [request], hiddenCount: 0, lastSequence: 1 }, loading: false });
		const view = new ConversationView(controller, session.sessionId, { previewInterfaces });
		document.body.append(view.el);
		cleanup.push(() => view.dispose());
		const shown = () => view.el.querySelector<HTMLElement>(".action-review-card .review-preview");
		// The thread has the folder read what the card's page reads; until it is read, the preview waits hidden.
		expect(previewInterfaces).toHaveBeenLastCalledWith(view, [expect.objectContaining({ name: "Books" })]);
		expect(shown()?.hidden).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(shown()?.hidden).toBe(false);
		expect(texts(shown()!, ".interface-table tbody td:nth-child(1)")).toEqual(["A-1"]);
		// A new row shows in the preview as it is read.
		fake.put("tables/invoices/rows.csv", "number,amount\nA-1,120\nA-2,80\n");
		await hint();
		await settle();
		expect(texts(shown()!, ".interface-table tbody td:nth-child(1)")).toEqual(["A-1", "A-2"]);
		// Answered, the card shows no preview, and the folder stops reading for it.
		const decision: TranscriptItem = {
			kind: "authorization_decision",
			id: id(711),
			sequence: 2,
			actorUserId: userA.id,
			createdAt: timestamp,
			body: {
				requestEventId: id(710),
				decision: "approved",
				answer: { answer: "allow_once" },
				answeredBy: userA.id,
			},
		};
		state.set({ projection: { items: [request, decision], hiddenCount: 0, lastSequence: 2 }, loading: false });
		await settle();
		expect(view.el.querySelector(".action-review-card")?.getAttribute("data-decision-state")).toBe("approved");
		expect(view.el.querySelector(".review-preview")).toBeNull();
		expect(previewInterfaces).toHaveBeenLastCalledWith(view, []);
	});
});
