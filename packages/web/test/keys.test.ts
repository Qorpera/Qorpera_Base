// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_APP_KEYBINDINGS, matchesKey } from "../src/ui/keys.ts";

const key = (value: string, options: KeyboardEventInit = {}) =>
	new KeyboardEvent("keydown", { key: value, ...options });

describe("matchesKey", () => {
	it("matches a single key and every key of a list", () => {
		expect(matchesKey(key("Escape"), "dismiss")).toBe(true);
		expect(matchesKey(key("Esc"), "dismiss")).toBe(false);
		expect(DEFAULT_APP_KEYBINDINGS.grow).toEqual(["+", "="]);
		expect(matchesKey(key("+"), "grow")).toBe(true);
		expect(matchesKey(key("="), "grow")).toBe(true);
		expect(matchesKey(key("-"), "grow")).toBe(false);
		expect(matchesKey(key("-"), "shrink")).toBe(true);
	});
	it("never matches while an IME composition is active", () => {
		expect(matchesKey(key("Escape", { isComposing: true }), "dismiss")).toBe(false);
		expect(matchesKey(key("+", { isComposing: true }), "grow")).toBe(false);
		expect(matchesKey(key("-", { isComposing: true }), "shrink")).toBe(false);
	});
});
