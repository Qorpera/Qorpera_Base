import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shell = join(import.meta.dirname, "..");
const userland = join(shell, "userland");
const rendererSource = readFileSync(join(userland, "renderer.js"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");
const baseCssSource = readFileSync(join(userland, "base.css"), "utf-8");
const preloadSource = readFileSync(join(shell, "src", "preload.cjs"), "utf-8");

describe("userland wiring", () => {
	it("only calls toast helpers that renderer.js actually defines", () => {
		// showControllerToast survived its own deletion as 19 call sites: every
		// settings error path threw ReferenceError inside an async onclick and
		// the failure vanished. Invitations went missing exactly this way.
		const called = new Set([...rendererSource.matchAll(/\b(show\w*Toast)\(/g)].map((match) => match[1]));
		expect(called.size).toBeGreaterThan(0);
		for (const name of called) {
			expect(rendererSource, `${name} is called but never defined`).toContain(`function ${name}(`);
		}
	});

	it("keeps settings tab buttons and SETTINGS_TABS in sync", () => {
		const registered = rendererSource.match(/const SETTINGS_TABS = new Set\(\[(.*?)\]\)/);
		expect(registered).not.toBeNull();
		const tabs = [...(registered?.[1] ?? "").matchAll(/"(\w+)"/g)].map((match) => match[1]);
		const buttons = [...indexSource.matchAll(/data-tab="(\w+)"/g)].map((match) => match[1]);
		expect(new Set(buttons)).toEqual(new Set(tabs));
		// Every button's click handler must open its own tab.
		for (const tab of buttons) {
			expect(indexSource).toContain(`onclick="openSettings('${tab}')"`);
		}
	});

	it("keeps non-actionable hosting internals out of settings", () => {
		for (const label of ["Product and execution", "Profile placement", "Company workspaces"]) {
			expect(rendererSource).not.toContain(label);
		}
	});

	it("keeps the remaining company controls actionable and accessible", () => {
		expect(rendererSource).toContain("window.qorpera.enableCloudProfile()");
		expect(rendererSource).toContain('event.key !== "Tab"');
		expect(rendererSource).toMatch(/item\.setAttribute\("aria-label", `\$\{name\}, \$\{role\}`\)/);
		expect(rendererSource).toContain("Pick from your friends or add someone first");
		expect(baseCssSource).not.toMatch(/\.company-person-actions \{[^}]*visibility:\s*hidden/s);
		expect(baseCssSource).toMatch(/\.company-person-actions \{[^}]*opacity:\s*0/s);
		expect(baseCssSource).toContain(".company-person-row:focus-within .company-person-actions");
	});

	it("keeps macOS native window controls clear of titlebar actions", () => {
		expect(preloadSource).toContain("document.documentElement.dataset.platform = process.platform");
		expect(baseCssSource).toMatch(/html\[data-platform="darwin"\] \.titlebar-rail \{ padding-left: 78px; \}/);
		expect(baseCssSource).toMatch(
			/html\[data-platform="darwin"\] #titlebar \.thread-header \{ padding-right: 10px; \}/,
		);
	});
});
