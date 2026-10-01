import { describe, expect, it, vi } from "vitest";
import { ComputerViewerUnavailable, loadComputerViewer } from "../src/ui/computer-viewer.ts";

// The renderer chunk failed to load: a deploy renamed it while the tab was open,
// or the network dropped during the fetch.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/ui/screen-viewer.mjs", () => {
	loads.count++;
	throw new TypeError("Failed to fetch dynamically imported module");
});

describe("a screen renderer that could not load", () => {
	it("stays unavailable for the page's life, as the browser keeps a failed module", async () => {
		const first = loadComputerViewer();
		await expect(first).rejects.toBeInstanceOf(ComputerViewerUnavailable);
		// No second fetch is pretended: the browser would not make one either.
		expect(loadComputerViewer()).toBe(first);
		await expect(loadComputerViewer()).rejects.toBeInstanceOf(ComputerViewerUnavailable);
		expect(loads.count).toBe(1);
	});
});
