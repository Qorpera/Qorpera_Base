// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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

	it("puts every shape on the document's clock when its breath starts", () => {
		const shape = messagesSkeleton().querySelector<HTMLElement>(".skeleton")!;
		document.body.append(shape);
		const breath = { animationName: "skeleton-breathe", startTime: 1234 as number | null };
		const other = { animationName: "status-ink-wave", startTime: 1234 as number | null };
		shape.getAnimations = () => [breath, other] as unknown as Animation[];
		const start = (animationName: string) => {
			const event = new Event("animationstart", { bubbles: true });
			Object.defineProperty(event, "animationName", { value: animationName });
			shape.dispatchEvent(event);
		};
		start("status-ink-wave");
		expect(breath.startTime).toBe(1234);
		// A shape that starts late, built by a redraw or shown when a drawer opens, joins mid-breath.
		start("skeleton-breathe");
		expect(breath.startTime).toBe(0);
		expect(other.startTime).toBe(1234);
		shape.remove();
	});
});

function wrap(...children: HTMLElement[]): HTMLElement {
	const element = document.createElement("div");
	element.append(...children);
	return element;
}
