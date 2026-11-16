import { describe, expect, it } from "vitest";
import {
	appNoteAbout,
	appNoteHeader,
	appNoteText,
	pageNoteLine,
	splitAppNote,
	splitReply,
	withReply,
} from "../src/cloud/wall-reply.ts";

/* A message that opens with a quoted line. Members answered the questions on an agent's wall so until the web dropped
 * the wall (Jonas, 14 Nov 2026); those messages stay in the threads and are read back the same. */
describe("a message that opens with a quoted line", () => {
	it("reads back the line and the member's words", () => {
		const text = withReply("Who first?", "Young couples.\n\nIn flats.", 0);
		expect(text).toBe("> Who first?\n\nYoung couples.\n\nIn flats.");
		expect(splitReply(text)).toEqual({
			question: "Who first?",
			text: "Young couples.\n\nIn flats.",
			start: "> Who first?\n\n".length,
		});
		expect(splitReply(withReply("Who first?", "", 1))).toEqual({ question: "Who first?", text: "", start: 12 });
		expect(withReply("Who first?", "", 0)).toBe("");
		expect(withReply(undefined, "Words", 0)).toBe("Words");
		expect(splitReply("Just words")).toBeUndefined();
		expect(splitReply("> two\nlines")).toBeUndefined();
	});
});

describe("a note from an app's page", () => {
	it("opens with the app, the thing and what it is about, then the member's words, and reads back the same", () => {
		const text = appNoteText("orders-board", "1043", "Lund, A", "Get a quote.\n\nBy Friday.");
		expect(text).toBe("> app:orders-board#1043 · Lund, A\n\nGet a quote.\n\nBy Friday.");
		const reply = splitReply(text);
		expect(reply?.text).toBe("Get a quote.\n\nBy Friday.");
		expect(appNoteHeader(reply?.question ?? "")).toEqual({ app: "orders-board", at: "1043", about: "Lund, A" });
		// With no thing named; and what it is about may hold the separator itself.
		expect(appNoteText("roadmap", null, "Ship · Q1", "Why?")).toBe("> app:roadmap · Ship · Q1\n\nWhy?");
		expect(appNoteHeader("app:roadmap · Ship · Q1")).toEqual({ app: "roadmap", at: null, about: "Ship · Q1" });
		expect(appNoteHeader("app:path#lane:step.2_b-1 · Step 2 · Lane B")).toEqual({
			app: "path",
			at: "lane:step.2_b-1",
			about: "Step 2 · Lane B",
		});
	});

	it("reads no app from a line that is not one: a plain question, another name, a thing that is no id", () => {
		for (const line of [
			"Who first?",
			"app:orders-board",
			"app:orders-board ·",
			"app:Orders · Lund",
			"app:orders_board · Lund",
			"app:orders-board#-1043 · Lund",
			"app:orders-board#10 43 · Lund",
			"see app:orders-board · Lund",
		])
			expect(appNoteHeader(line), line).toBeUndefined();
	});

	it("reads a question asked on the Data page's list as a note from that page, and no other page", () => {
		const line = pageNoteLine("data", "workshop.repairs", "Workshop · Repairs");
		expect(line).toBe("page:data#workshop.repairs · Workshop · Repairs");
		expect(appNoteHeader(line)).toEqual({
			app: "data",
			at: "workshop.repairs",
			about: "Workshop · Repairs",
			page: true,
		});
		expect(appNoteHeader("page:data · Workshop")).toEqual({ app: "data", at: null, about: "Workshop", page: true });
		expect(splitAppNote(`> ${line}\n\nHow many waited?`)?.rest).toBe("How many waited?");
		for (const other of ["page:mailbox · Inbox", "page:Data · Workshop", "page:data#-x · Workshop", "page:data"])
			expect(appNoteHeader(other), other).toBeUndefined();
	});

	it("makes what it is about one line that names nobody, quotes nothing and turns no text around", () => {
		expect(appNoteAbout("  Ask @Bea\nabout «this»? ")).toBe("Ask Bea about this?");
		expect(appNoteAbout("Lund‮, A⁦‏\t\u0000now")).toBe("Lund, A now");
		expect(appNoteAbout(" @ « » ")).toBe("");
	});
});
