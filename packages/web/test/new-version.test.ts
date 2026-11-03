// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NEW_VERSION_CHECK_MS,
	newVersionNotice,
	RUNNING_SOURCE_COMMIT,
	watchNewVersion,
} from "../src/app/new-version.ts";
import { settle } from "./fixtures.ts";

/* 3 Nov 2026: a tab left open kept the old build after a deploy until it was reloaded by hand. */

const running = "a".repeat(40);
const deployed = "b".repeat(40);

function served(commit: unknown) {
	return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
		Response.json({ schema: "qorpera.web-deployment/v1", sourceCommit: commit }),
	);
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
	document.body.replaceChildren();
});

describe("a new version of the web app", () => {
	it("is noticed once the site serves another build, asked every 10 minutes and when the tab comes back", async () => {
		const fetch = served(running);
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
		// Focus asks again, at most once a minute.
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		fetch.mockImplementation(async () => Response.json({ sourceCommit: deployed }));
		// A hidden tab asks nothing; shown again, it asks.
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(1);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(found).toHaveBeenCalledTimes(1);
		// Once noticed, it asks no more.
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 3);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(fetch).toHaveBeenCalledTimes(2);
		stop.abort();
	});

	it("ignores a manifest it can't read, and asks nothing without its own commit or after it stops", async () => {
		const fetch = served("not a commit");
		vi.stubGlobal("fetch", fetch);
		const found = vi.fn();
		const stop = new AbortController();
		watchNewVersion(running, found, stop.signal);
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		fetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(found).not.toHaveBeenCalled();
		stop.abort();
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 2);
		expect(fetch).toHaveBeenCalledTimes(3);
		// Tests and development builds carry no commit: they never ask.
		expect(RUNNING_SOURCE_COMMIT).toBeUndefined();
		watchNewVersion(RUNNING_SOURCE_COMMIT, found, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(NEW_VERSION_CHECK_MS * 2);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("reloads only when asked, and asks first when a message is not sent yet", async () => {
		const root = document.createElement("div");
		const draft = document.createElement("textarea");
		root.append(draft);
		document.body.append(root);
		const load = vi.fn();
		const line = newVersionNotice(root, load);
		document.body.append(line);
		expect(line.textContent).toContain("A new version is available.");
		const reload = [...line.querySelectorAll("button")].find((button) => button.textContent === "Reload")!;
		reload.click();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		draft.value = "Half a message";
		reload.click();
		await settle();
		const ask = document.querySelector<HTMLElement>("[role=alertdialog]")!;
		expect(ask.textContent).toContain("Text you have not sent will be lost. Reload anyway?");
		[...ask.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		reload.click();
		await settle();
		[...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")]
			.find((button) => button.textContent === "Reload")!
			.click();
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
	});
});
