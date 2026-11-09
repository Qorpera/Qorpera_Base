import { describe, expect, it } from "vitest";
import { interfaceEmblem } from "../src/ui/interface-emblem.ts";

/* An interface's emblem (ui/interface-emblem.ts): the ink is drawn, the cuts are holes in a mask, so nothing outside
 * the ink is ever painted (Jonas, 9 November 2026: a white rim around one of the Members emblem's people). */

describe("an interface's emblem", () => {
	it("draws its cuts as holes in its own mask, never as paint", () => {
		const members = interfaceEmblem("members", 30);
		const mask = members.querySelector("defs > mask");
		const ink = members.querySelector(":scope > g");
		expect(mask).not.toBeNull();
		expect(ink?.getAttribute("mask")).toBe(`url(#${mask?.id})`);
		// The front person's outline is a hole, and the four ink shapes are drawn whole.
		expect(mask?.querySelectorAll('[data-stroke="cut"]')).toHaveLength(2);
		expect(ink?.querySelectorAll('[data-fill="ink"]')).toHaveLength(4);
		for (const part of members.querySelectorAll("g *")) {
			expect(part.getAttribute("stroke") ?? "none").not.toMatch(/^#fff/i);
			expect(part.getAttribute("fill")).not.toMatch(/^#fff/i);
		}
	});

	it("gives every drawing its own mask", () => {
		const one = interfaceEmblem("mail", 20).querySelector("mask")?.id;
		const two = interfaceEmblem("mail", 20).querySelector("mask")?.id;
		expect(one).toBeTruthy();
		expect(one).not.toBe(two);
	});

	it("keeps a cut filled shape and an ink line where they were", () => {
		const bank = interfaceEmblem("bank", 40);
		expect(bank.querySelector("mask circle")?.getAttribute("fill")).toBe("#000");
		const hire = interfaceEmblem("hire", 40);
		expect(hire.querySelector('g [data-stroke="ink"]')).not.toBeNull();
		expect(hire.querySelectorAll("mask > *")).toHaveLength(1);
	});
});
