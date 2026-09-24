// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	blankSkeleton,
	cardsSkeleton,
	companyCardsSkeleton,
	linesSkeleton,
	listSkeleton,
	messagesSkeleton,
	pageSkeleton,
	railListSkeleton,
	railSkeleton,
	threadSkeleton,
} from "../src/ui/skeleton.ts";

afterEach(() => vi.restoreAllMocks());

describe("loading placeholders", () => {
	it("show shapes, never a loading sentence, and name what loads for screen readers", () => {
		const placeholders = [
			blankSkeleton("Connecting to the cloud"),
			messagesSkeleton(),
			threadSkeleton("Opening company"),
			railListSkeleton(),
			listSkeleton("Loading team"),
			linesSkeleton("Loading files"),
			cardsSkeleton("Reading conversations"),
			pageSkeleton("Loading organization"),
			companyCardsSkeleton(),
			wrap(...railSkeleton()),
		];
		for (const element of placeholders) {
			expect(element.textContent).toBe("");
			const status = element.matches("[role=status]") ? element : element.querySelector("[role=status]");
			expect(status?.getAttribute("aria-label")).toBeTruthy();
			expect(status?.getAttribute("aria-busy")).toBe("true");
		}
		expect(threadSkeleton("Opening company").querySelector("[role=status]")?.getAttribute("aria-label")).toBe(
			"Opening company",
		);
		expect(listSkeleton("Loading team", 4).querySelectorAll(".skeleton-list-row")).toHaveLength(4);
	});

	it("stands the thread on the thread's own parts: header, messages and composer", () => {
		const thread = threadSkeleton("Opening conversation");
		expect(thread.querySelector(".thread-header .skeleton-identity-figure")).not.toBeNull();
		expect(thread.querySelectorAll(".messages .skeleton-bubble")).toHaveLength(5);
		expect(thread.querySelectorAll(".skeleton-message-mine")).toHaveLength(1);
		expect(thread.querySelector("footer.composer .skeleton-composer-field")).not.toBeNull();
	});

	it("puts every shape on one breathing clock, whenever it is built", () => {
		const now = vi.spyOn(performance, "now");
		now.mockReturnValue(4_000);
		const early = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		now.mockReturnValue(4_000 + 3 * 1_800);
		const late = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		// Built a whole number of breaths apart, the two shapes stand at the same point of a breath.
		expect(early.style.animationDelay).toBe("-400ms");
		expect(late.style.animationDelay).toBe(early.style.animationDelay);
	});
});

function wrap(...children: HTMLElement[]): HTMLElement {
	const element = document.createElement("div");
	element.append(...children);
	return element;
}
