import { describe, expect, it } from "vitest";
import { applyEdit, diffText, mergeText, moveIndex, transform } from "../src/app/text-merge.ts";

describe("shared draft text merging", () => {
	it("describes a change as one replaced span, placed at the caret in a run of equal letters", () => {
		expect(diffText("abc", "abc")).toEqual([3]);
		expect(diffText("", "")).toEqual([]);
		expect(diffText("Plan", "Plan it")).toEqual([4, " it"]);
		expect(diffText("Plan it", "Plan")).toEqual([4, -3]);
		expect(diffText("Plan it now", "Plan that now")).toEqual([5, -1, "tha", 5]);
		// "aaaa" → "aaaaa": without the caret the new letter is taken to be the last one.
		expect(diffText("aaaa", "aaaaa")).toEqual([4, "a"]);
		expect(diffText("aaaa", "aaaaa", 3)).toEqual([2, "a", 2]);
		expect(diffText("aaaa", "aaa", 1)).toEqual([1, -1, 2]);
		for (const [before, after, caret] of [
			["Plan", "Plan it", undefined],
			["aaaa", "aaaaa", 3],
			["hello world", "hello there world", 11],
			["x", "", 0],
		] as const)
			expect(applyEdit(before, diffText(before, after, caret))).toBe(after);
	});

	it("never splits a letter made of two UTF-16 units", () => {
		const edit = diffText("go 😀", "go 😃");
		expect(edit).toEqual([3, -2, "😃"]);
		expect(applyEdit("go 😀", edit)).toBe("go 😃");
		expect(diffText("😀 go", "😃 go")).toEqual([-2, "😃", 3]);
	});

	it("keeps both members' words when they type at the same time", () => {
		const base = "Plan the launch";
		const mine = diffText(base, "Plan the launch today");
		const theirs = diffText(base, "Please plan the launch");
		const [mine2, theirs2] = transform(mine, theirs);
		const merged = applyEdit(applyEdit(base, theirs), mine2);
		expect(merged).toBe("Please plan the launch today");
		expect(applyEdit(applyEdit(base, mine), theirs2)).toBe(merged);
	});

	it("keeps words typed inside a span the other member deleted", () => {
		const base = "one two three";
		const mine = diffText(base, "one two and a half three"); // inserts inside "two three"
		const theirs = diffText(base, "one"); // deletes " two three"
		const [mine2, theirs2] = transform(mine, theirs);
		const merged = applyEdit("one", mine2);
		// The space the other member deleted stays deleted; the typed words stay.
		expect(merged).toBe("oneand a half ");
		expect(applyEdit("one two and a half three", theirs2)).toBe(merged);
	});

	it("puts the first edit's words first when both insert at one place", () => {
		const [a2, b2] = transform(["x", 3], ["y", 3]);
		expect(applyEdit(applyEdit("abc", ["y", 3]), a2)).toBe("xyabc");
		expect(applyEdit(applyEdit("abc", ["x", 3]), b2)).toBe("xyabc");
	});

	it("deletes shared letters once when both delete them", () => {
		const [a2, b2] = transform([1, -3, 1], [2, -3]);
		expect(applyEdit(applyEdit("abcde", [2, -3]), a2)).toBe("a");
		expect(applyEdit(applyEdit("abcde", [1, -3, 1]), b2)).toBe("a");
	});

	it("refuses edits of different texts", () => {
		expect(() => applyEdit("abc", [2])).toThrow();
		expect(() => transform([3], [4])).toThrow();
	});

	it("moves a caret through another member's edit and keeps it before words inserted at it", () => {
		expect(moveIndex(4, [4, " it"])).toBe(4);
		expect(moveIndex(5, [4, " it", 1])).toBe(8);
		expect(moveIndex(2, ["Well, ", 4])).toBe(8);
		expect(moveIndex(0, ["Well, ", 4])).toBe(0);
		expect(moveIndex(6, [2, -3, 3])).toBe(3);
		expect(moveIndex(3, [2, -3, 3])).toBe(2);
		expect(moveIndex(2, [2, -3, 3])).toBe(2);
		expect(moveIndex(8, [8, -2, "xyz"])).toBe(8);
		expect(moveIndex(10, [8, -2, "xyz"])).toBe(8);
	});

	it("merges a member's text into the cloud's and moves the caret with it", () => {
		const { text, edit } = mergeText("Plan the launch", "Plan the launch today", "Please plan the launch", 21);
		expect(text).toBe("Please plan the launch today");
		expect(applyEdit("Plan the launch today", edit)).toBe(text);
		expect(moveIndex(21, edit)).toBe(28);
		const after = mergeText("Plan", "Plan", "Plan it");
		expect(after.text).toBe("Plan it");
		expect(moveIndex(4, after.edit)).toBe(4);
		// Sent: the member's own text goes, words added meanwhile by someone else stay.
		const sent = mergeText("Plan it", "", "Plan it, and invite Bo");
		expect(sent.text).toBe(", and invite Bo");
	});
});
