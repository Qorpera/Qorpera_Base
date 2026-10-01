import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerViewerUnavailable, loadComputerViewer, RENDERER_DEADLINE_MS } from "../src/ui/computer-viewer.ts";

// The renderer chunk's download stalls: it neither arrives nor fails, until the test lets it.
const download = vi.hoisted(() => ({ finish: () => {} }));
vi.mock(
	"../src/ui/screen-viewer.mjs",
	() =>
		new Promise<object>((resolve) => {
			download.finish = () => resolve({});
		}),
);

afterEach(() => vi.useRealTimers());

describe("a screen renderer download that stalls", () => {
	it("is unavailable at the deadline, and serves later panels if it does arrive", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const load = loadComputerViewer();
		const outcome = load.then(
			() => "loaded",
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(RENDERER_DEADLINE_MS - 1);
		expect(await Promise.race([outcome, "waiting"])).toBe("waiting");
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toBeInstanceOf(ComputerViewerUnavailable);
		// The panel that waited offers Reload page; until the file arrives, every call fails the same way.
		expect(loadComputerViewer()).toBe(load);
		download.finish();
		await vi.waitFor(() => expect(loadComputerViewer()).not.toBe(load));
		await expect(loadComputerViewer()).resolves.toBeUndefined();
	});
});
