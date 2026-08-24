import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const userland = join(import.meta.dirname, "..", "userland");
const source = readFileSync(join(userland, "localization.js"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");
const rendererSource = readFileSync(join(userland, "renderer.js"), "utf-8");

function loadLocalization(languages: string[], storedLanguage?: string) {
	const storage = new Map<string, string>();
	if (storedLanguage) storage.set("qorpera-language", storedLanguage);
	const textNode = { data: "Settings", nodeType: 3, parentElement: undefined as object | undefined };
	const textContainer = {
		childNodes: [textNode],
		closest: () => null,
		getAttribute: () => null,
		nodeType: 1,
		setAttribute: () => undefined,
	};
	textNode.parentElement = textContainer;
	const chatTextNode = { data: "Settings", nodeType: 3, parentElement: undefined as object | undefined };
	const chatContainer = {
		childNodes: [chatTextNode],
		closest: (selector: string) => (selector.includes("#messages") ? chatContainer : null),
		getAttribute: () => null,
		nodeType: 1,
		setAttribute: () => undefined,
	};
	chatTextNode.parentElement = chatContainer;
	const attachmentTextNode = { data: "Settings", nodeType: 3, parentElement: undefined as object | undefined };
	const attachmentContainer = {
		childNodes: [attachmentTextNode],
		closest: (selector: string) => (selector.includes("#attachStrip") ? attachmentContainer : null),
		getAttribute: () => null,
		nodeType: 1,
		setAttribute: () => undefined,
	};
	attachmentTextNode.parentElement = attachmentContainer;
	const documentElement = {
		childNodes: [textContainer, chatContainer, attachmentContainer],
		closest: () => null,
		getAttribute: () => null,
		lang: "",
		nodeType: 1,
		setAttribute: () => undefined,
	};
	const window = {
		addEventListener: () => undefined,
		qorperaI18n: undefined as
			| {
					locale: string;
					preference: string;
					resolveLocale: (preference: string, locales?: string[]) => string;
					setPreference: (preference: string) => void;
					t: (source: string) => string;
			  }
			| undefined,
	};
	class TestMutationObserver {
		observe() {}
		takeRecords() {
			return [];
		}
	}
	runInNewContext(source, {
		document: { documentElement },
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			removeItem: (key: string) => storage.delete(key),
			setItem: (key: string, value: string) => storage.set(key, value),
		},
		MutationObserver: TestMutationObserver,
		navigator: { language: languages[0], languages },
		window,
	});
	return { attachmentTextNode, chatTextNode, documentElement, i18n: window.qorperaI18n, storage, textNode };
}

describe("shell localization", () => {
	it("uses Danish for a Danish system locale unless the user overrides it", () => {
		const { documentElement, i18n, storage, textNode } = loadLocalization(["da-DK", "en-US"]);
		expect(i18n?.preference).toBe("system");
		expect(i18n?.locale).toBe("da");
		expect(documentElement.lang).toBe("da");
		expect(i18n?.t("Settings")).toBe("Indstillinger");
		expect(textNode.data).toBe("Indstillinger");

		i18n?.setPreference("en");
		expect(i18n?.locale).toBe("en");
		expect(i18n?.t("Settings")).toBe("Settings");
		expect(textNode.data).toBe("Settings");
		expect(storage.get("qorpera-language")).toBe("en");

		i18n?.setPreference("system");
		expect(i18n?.locale).toBe("da");
		expect(textNode.data).toBe("Indstillinger");
		expect(storage.has("qorpera-language")).toBe(false);
	});

	it("honors a saved language and falls back unsupported system locales to English", () => {
		expect(loadLocalization(["da-DK"], "en").i18n?.locale).toBe("en");
		expect(loadLocalization(["de-DE"]).i18n?.locale).toBe("en");
		expect(loadLocalization(["en-US", "da-DK"]).i18n?.locale).toBe("en");
	});

	it("leaves chat bubbles and attachment blobs unchanged", () => {
		const { attachmentTextNode, chatTextNode, i18n } = loadLocalization(["da-DK"]);
		expect(i18n?.locale).toBe("da");
		expect(chatTextNode.data).toBe("Settings");
		expect(attachmentTextNode.data).toBe("Settings");
	});

	it("loads localization before the renderer and exposes all language choices", () => {
		expect(indexSource.indexOf("./localization.js")).toBeLessThan(indexSource.indexOf("./renderer.js"));
		expect(rendererSource).toContain('new Option("System default", "system")');
		expect(rendererSource).toContain('new Option("Dansk", "da")');
		expect(rendererSource).toContain('new Option("English", "en")');
		expect(rendererSource).toContain("window.qorperaI18n.setPreference(language.value)");
	});
});
