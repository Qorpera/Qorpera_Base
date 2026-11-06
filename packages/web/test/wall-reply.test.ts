import { describe, expect, it } from "vitest";
import { replyQuestion, splitReply, withReply } from "../src/cloud/wall-reply.ts";

describe("an answer to a question on the wall", () => {
	it("reads back the question and the member's words", () => {
		const text = withReply("Who first?", "Young couples.\n\nIn flats.");
		expect(text).toBe("> Who first?\n\nYoung couples.\n\nIn flats.");
		expect(splitReply(text)).toEqual({
			question: "Who first?",
			text: "Young couples.\n\nIn flats.",
			start: "> Who first?\n\n".length,
		});
		expect(splitReply(withReply("Who first?", ""))).toEqual({ question: "Who first?", text: "", start: 12 });
		expect(splitReply("Just words")).toBeUndefined();
		expect(splitReply("> two\nlines")).toBeUndefined();
	});

	it("keeps the question to one line that names and quotes nobody", () => {
		expect(replyQuestion("  Ask @Bea\nabout «this»? ")).toBe("Ask Bea about this?");
		const long = replyQuestion("x".repeat(500));
		expect(long).toHaveLength(240);
		expect(long.endsWith("…")).toBe(true);
	});
});
