// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimStartCrown, landStartCrown, settleStartCrown } from "../src/app/views/start-crown.ts";

const stage = () => document.querySelector(".start-crown");

describe("the crown that stays on the page from the new-company box into the company", () => {
	afterEach(() => {
		vi.useRealTimers();
		document.body.replaceChildren();
		document.documentElement.classList.remove("start-arriving");
	});

	it("stays while a draw claims it, and goes once a draw does not", async () => {
		claimStartCrown();
		const first = stage();
		expect(first).not.toBeNull();
		settleStartCrown();
		claimStartCrown();
		await Promise.resolve();
		expect(stage()).toBe(first);
		settleStartCrown();
		await Promise.resolve();
		expect(stage()).toBeNull();
	});

	it("lands in the rail's Co-Founder and goes, with the company coming in under it", async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });
		claimStartCrown();
		landStartCrown();
		expect(document.documentElement.classList.contains("start-arriving")).toBe(true);
		settleStartCrown();
		await Promise.resolve();
		expect(stage()).not.toBeNull();
		const target = document.createElement("span");
		target.className = "figure";
		target.getBoundingClientRect = () => new DOMRect(40, 60, 52, 52);
		const holder = document.createElement("span");
		holder.className = "cofounder-stand";
		holder.append(target);
		document.body.append(holder);
		vi.advanceTimersToNextFrame();
		expect(stage()).toBeNull();
		expect(target.classList.contains("is-awaited")).toBe(false);
		vi.advanceTimersByTime(1500);
		expect(document.documentElement.classList.contains("start-arriving")).toBe(false);
	});

	it("goes after a while when the rail never shows its Co-Founder", () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "performance"] });
		claimStartCrown();
		landStartCrown();
		for (let frame = 0; frame < 400 && stage(); frame++) vi.advanceTimersToNextFrame();
		expect(stage()).toBeNull();
	});
});
