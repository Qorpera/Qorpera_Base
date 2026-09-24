// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	blankSkeleton,
	companyCardsSkeleton,
	linesSkeleton,
	listSkeleton,
	messagesSkeleton,
	pageSkeleton,
	railListSkeleton,
	railSkeleton,
	threadSkeleton,
} from "../src/ui/skeleton.ts";
import { placeholderLabel, visibleText } from "./fixtures.ts";

describe("loading placeholders", () => {
	it("show shapes, never a loading sentence, and tell a screen reader what loads", () => {
		const placeholders: [HTMLElement, string][] = [
			[blankSkeleton("Connecting to the cloud"), "Connecting to the cloud"],
			[messagesSkeleton(), "Loading conversation"],
			[threadSkeleton("Opening company"), "Opening company"],
			[railListSkeleton(), "Loading agents"],
			[listSkeleton("Loading team"), "Loading team"],
			[linesSkeleton("Loading files"), "Loading files"],
			[pageSkeleton("Loading snapshot"), "Loading snapshot"],
			[companyCardsSkeleton(), "Loading companies"],
			[wrap(...railSkeleton()), "Opening company"],
		];
		for (const [element, label] of placeholders) {
			const root = wrap(element);
			expect(visibleText(root)).toBe("");
			expect(placeholderLabel(root)).toBe(label);
			// The label is the status element's own text, so it is read rather than held back.
			expect(root.querySelector("[aria-busy]")).toBeNull();
		}
		expect(listSkeleton("Loading team", 4).querySelectorAll(".skeleton-list-row")).toHaveLength(4);
	});

	it("stands the thread on the thread's own parts, with the rail's button when there is one", () => {
		const thread = threadSkeleton("Opening conversation");
		expect(thread.querySelector(".thread-header .skeleton-identity-figure")).not.toBeNull();
		expect(thread.querySelectorAll(".messages .skeleton-bubble")).toHaveLength(5);
		expect(thread.querySelectorAll(".skeleton-message-mine")).toHaveLength(1);
		expect(thread.querySelector("footer.composer .skeleton-composer-field")).not.toBeNull();
		expect(thread.querySelector(".mobile-navigation-toggle")).toBeNull();
		let toggled = 0;
		const navigable = threadSkeleton("Opening conversation", { open: true, toggle: () => toggled++ });
		const toggle = navigable.querySelector<HTMLButtonElement>(".thread-header > .mobile-navigation-toggle")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(toggle.getAttribute("aria-controls")).toBe("company-navigation");
		toggle.click();
		expect(toggled).toBe(1);
	});

	it("builds every shape in step with the document's clock", () => {
		const now = vi.spyOn(performance, "now");
		now.mockReturnValue(4_000);
		const early = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		now.mockReturnValue(4_000 + 3 * 1_800);
		const late = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		// Built a whole number of breaths apart, the two shapes stand at the same point of a breath.
		expect(early.style.animationDelay).toBe("-400ms");
		expect(late.style.animationDelay).toBe(early.style.animationDelay);
		now.mockRestore();
	});

	it("sets a shape in step again when its breath actually starts", () => {
		const shape = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		document.body.append(shape);
		const timing = (delay: number) => ({ getTiming: () => ({ delay }) });
		const breath = { animationName: "skeleton-breathe", startTime: 1234 as number | null, effect: timing(-400) };
		const other = { animationName: "status-ink-wave", startTime: 1234 as number | null, effect: timing(0) };
		shape.getAnimations = () => [breath, other] as unknown as Animation[];
		const start = (animationName: string) => {
			const event = new Event("animationstart", { bubbles: true });
			Object.defineProperty(event, "animationName", { value: animationName });
			shape.dispatchEvent(event);
		};
		start("status-ink-wave");
		expect(breath.startTime).toBe(1234);
		// A shape shown late (the phone's rail drawer) joins mid-breath: start + delay lands on the clock's zero.
		start("skeleton-breathe");
		expect(breath.startTime).toBe(400);
		expect(other.startTime).toBe(1234);
		breath.effect = timing(0);
		start("skeleton-breathe");
		expect(breath.startTime).toBe(0);
		shape.remove();
	});
});

function wrap(...children: HTMLElement[]): HTMLElement {
	const element = document.createElement("div");
	element.append(...children);
	return element;
}
