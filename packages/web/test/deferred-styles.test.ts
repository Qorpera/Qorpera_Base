// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadDeferredStyles, waitForDeferredStyles } from "../src/ui/deferred-styles.ts";

afterEach(() => {
	for (const el of document.head.querySelectorAll('meta[name="qorpera-deferred-css"], link[rel="stylesheet"]')) {
		el.remove();
	}
});

describe("deferred stylesheet loading", () => {
	it("resolves immediately when no deferred stylesheet meta tag is present", async () => {
		await expect(waitForDeferredStyles()).resolves.toBeUndefined();
		expect(document.head.querySelector('link[rel="stylesheet"]')).toBeNull();
	});

	it("injects the deferred stylesheet once and resolves when the link finishes loading", async () => {
		const meta = document.createElement("meta");
		meta.name = "qorpera-deferred-css";
		meta.content = "./build/deferred-TEST1.css";
		document.head.append(meta);

		const first = loadDeferredStyles();
		const second = waitForDeferredStyles();
		expect(second).toBe(first);
		const links = document.head.querySelectorAll<HTMLLinkElement>(
			'link[rel="stylesheet"][href="./build/deferred-TEST1.css"]',
		);
		expect(links).toHaveLength(1);

		let done = false;
		void first.then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);

		links[0]!.dispatchEvent(new Event("load"));
		await first;
		expect(done).toBe(true);
	});

	it("resolves cleanly on stylesheet load error without hanging lazy views", async () => {
		const meta = document.createElement("meta");
		meta.name = "qorpera-deferred-css";
		meta.content = "./build/deferred-ERR1.css";
		document.head.append(meta);

		const pending = loadDeferredStyles();
		const link = document.head.querySelector<HTMLLinkElement>(
			'link[rel="stylesheet"][href="./build/deferred-ERR1.css"]',
		)!;
		link.dispatchEvent(new Event("error"));
		await expect(pending).resolves.toBeUndefined();
	});
});
