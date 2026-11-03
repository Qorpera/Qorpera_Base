// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_VERSION_CHECK_MS, newVersionNotice, runningBuildFiles, watchNewVersion } from "../src/app/new-version.ts";
import { settle } from "./fixtures.ts";

/* 3 Nov 2026: a tab left open kept the old build after a deploy until it was reloaded by hand. The site is built again
 * for every merge (its sourceCommit moves with runtime-only merges too), so the tab compares the files it loaded. */

const running = ["build/app-LS6A3BMN.css", "build/chunk-6UQTB3TU.js", "build/main-HK3RB2JE.js"];

function manifest(files: readonly string[], sourceCommit = "a".repeat(40)) {
	return Response.json({
		schema: "qorpera.web-deployment/v1",
		sourceCommit,
		files: Object.fromEntries(files.map((file) => [file, "0".repeat(64)])),
	});
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.head.replaceChildren();
	document.body.replaceChildren();
});

describe("a new version of the web app", () => {
	it("knows the build files the page loaded, as the deployment manifest names them", () => {
		document.head.innerHTML = [
			'<script src="./build/theme-ODGIYTXF.js"></script>',
			'<link rel="stylesheet" href="./build/app-LS6A3BMN.css">',
			'<link rel="modulepreload" href="./build/chunk-6UQTB3TU.js">',
			'<script src="./assets/avatars/motion-model.js?v=30eb41993ac6"></script>',
			'<script type="module" src="./build/main-HK3RB2JE.js"></script>',
			'<link rel="icon" href="./assets/brand/favicon.svg">',
			'<script src="https://elsewhere.example/build/main-HK3RB2JE.js"></script>',
			'<script type="module" src="./main.js"></script>',
		].join("");
		expect(runningBuildFiles()).toEqual([
			"build/app-LS6A3BMN.css",
			"build/chunk-6UQTB3TU.js",
			"build/main-HK3RB2JE.js",
			"build/theme-ODGIYTXF.js",
		]);
		// The dev server's unhashed names and tests have none: nothing is ever asked.
		document.head.innerHTML = '<script type="module" src="./main.js"></script>';
		expect(runningBuildFiles()).toEqual([]);
	});

	it("is noticed once a file the page loaded is no longer served, asked every 10 minutes and when the tab is back", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			manifest([...running, "index.html"]),
		);
		vi.stubGlobal("fetch", fetch);
		const found = vi.fn();
		const stop = new AbortController();
		watchNewVersion(running, found, stop.signal);
		// Nothing is asked at once: the page was just loaded.
		expect(fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe(new URL("web-deployment.json", document.baseURI).href);
		expect(init).toMatchObject({ cache: "no-store", credentials: "omit" });
		expect(found).not.toHaveBeenCalled();
		// A merge that changed nothing in the web app: another commit, the same files.
		fetch.mockImplementation(async () => manifest(running, "b".repeat(40)));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(found).not.toHaveBeenCalled();
		// Focus asks again, at most once a minute.
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		fetch.mockImplementation(async () => manifest(["build/app-LS6A3BMN.css", "build/main-Q2W3E4R5.js"]));
		// A hidden tab asks nothing; shown again, it asks.
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(2);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(found).toHaveBeenCalledTimes(1);
		// Once noticed, it asks no more.
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 3);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(3);
		stop.abort();
	});

	it("ignores a manifest it can't read, and asks nothing without files or after it stops", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({ sourceCommit: "b".repeat(40) }),
		);
		vi.stubGlobal("fetch", fetch);
		const found = vi.fn();
		const stop = new AbortController();
		watchNewVersion(running, found, stop.signal);
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		fetch.mockImplementationOnce(async () => manifest([]));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		fetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(found).not.toHaveBeenCalled();
		stop.abort();
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 2);
		expect(fetch).toHaveBeenCalledTimes(4);
		watchNewVersion([], found, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 2);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("reloads only when asked, and asks first when words are not sent yet", async () => {
		const root = document.createElement("div");
		const draft = document.createElement("textarea");
		const field = document.createElement("input");
		root.append(draft, field);
		document.body.append(root);
		let elsewhere = false;
		const load = vi.fn();
		const line = newVersionNotice(root, () => elsewhere, load);
		document.body.append(line);
		expect(line.textContent).toContain("A new version is available.");
		const reload = [...line.querySelectorAll("button")].find((button) => button.textContent === "Reload")!;
		reload.click();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		const answer = async (label: string) => {
			reload.click();
			await settle();
			const ask = document.querySelector<HTMLElement>("[role=alertdialog]")!;
			expect(ask.textContent).toContain("Text you have not sent will be lost. Reload anyway?");
			[...ask.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
			await settle();
			await vi.advanceTimersByTimeAsync(1_000);
		};
		// In a text box on the page, in a field with no type, or in a draft of a conversation not on screen.
		draft.value = "Half a message";
		await answer("Cancel");
		expect(load).toHaveBeenCalledTimes(1);
		await answer("Reload");
		expect(load).toHaveBeenCalledTimes(2);
		draft.value = "";
		field.value = "A name";
		await answer("Cancel");
		field.value = "";
		elsewhere = true;
		await answer("Cancel");
		expect(load).toHaveBeenCalledTimes(2);
	});
});
