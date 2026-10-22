// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardFoot } from "../src/app/views/card-foot.ts";

afterEach(() => {
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	vi.useRealTimers();
});

const labels = (foot: HTMLElement | null) =>
	[...(foot?.querySelectorAll<HTMLButtonElement>(".agent-card-square") ?? [])].map((item) =>
		item.getAttribute("aria-label"),
	);

describe("a card's foot", () => {
	it("shows Copy, Hide or Show, and Delete as icons, only where given, and none at all without any", () => {
		const options = { close: vi.fn(), copyFailed: vi.fn(), signal: new AbortController().signal };
		expect(labels(cardFoot({ conversationId: "c", hide: vi.fn(), remove: vi.fn() }, options))).toEqual([
			"Copy conversation ID",
			"Hide from sidebar",
			"Delete",
		]);
		expect(labels(cardFoot({ pin: vi.fn(), conversationId: "c", hide: vi.fn(), remove: vi.fn() }, options))).toEqual([
			"Pin",
			"Copy conversation ID",
			"Hide from sidebar",
			"Delete",
		]);
		expect(labels(cardFoot({ hidden: true, hide: vi.fn() }, options))).toEqual(["Show in sidebar"]);
		expect(labels(cardFoot({ pinned: true, pin: vi.fn() }, options))).toEqual(["Unpin"]);
		expect(cardFoot({}, options)).toBeNull();
		const foot = cardFoot({ conversationId: "c", remove: vi.fn() }, options)!;
		expect([...foot.querySelectorAll("button")].every((item) => item.textContent === "" && item.title)).toBe(true);
		expect(foot.querySelector(".agent-card-square:last-child")?.classList.contains("is-danger")).toBe(true);
	});

	it("closes the card before Pin, Hide and Delete act, and keeps it open while copying", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const foot = cardFoot(
			{
				pin: () => order.push("pin"),
				conversationId: "c-1",
				hide: () => order.push("hide"),
				remove: () => order.push("remove"),
			},
			{ close: () => order.push("close"), copyFailed: vi.fn(), signal: new AbortController().signal },
		)!;
		const [pin, copy, hide, remove] = [...foot.querySelectorAll<HTMLButtonElement>("button")];
		pin!.click();
		hide!.click();
		remove!.click();
		expect(order).toEqual(["close", "pin", "close", "hide", "close", "remove"]);
		copy!.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(writeText).toHaveBeenCalledWith("c-1");
		expect(order).toHaveLength(6);
		expect(copy!.getAttribute("aria-label")).toBe("Copied");
		await vi.advanceTimersByTimeAsync(1600);
		expect(copy!.getAttribute("aria-label")).toBe("Copy conversation ID");
	});

	it("says a refused copy in the card's own words, and nothing once the card is gone", async () => {
		const writeText = vi.fn(async (_text: string) => {
			throw new Error("denied");
		});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const life = new AbortController();
		const copyFailed = vi.fn();
		const foot = cardFoot({ conversationId: "c" }, { close: vi.fn(), copyFailed, signal: life.signal })!;
		const copy = foot.querySelector<HTMLButtonElement>("button")!;
		copy.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(copyFailed).toHaveBeenCalledTimes(1);
		life.abort();
		copy.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(copyFailed).toHaveBeenCalledTimes(1);
	});
});
