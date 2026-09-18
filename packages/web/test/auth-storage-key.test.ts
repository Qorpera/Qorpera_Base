// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { authStorageKey, createCloud } from "../src/cloud/client.ts";

afterEach(() => localStorage.clear());

describe("stored session belongs to one backend", () => {
	it("keys the session by the backend host", () => {
		expect(authStorageKey("https://aaaa.supabase.co")).toBe("qorpera-web-auth/v1/aaaa.supabase.co");
		expect(authStorageKey("https://aaaa.supabase.co")).not.toBe(authStorageKey("https://bbbb.supabase.co"));
	});

	it("drops a session stored under the old backend-independent key", () => {
		localStorage.setItem("qorpera-web-auth/v1", "{}");
		localStorage.setItem("qorpera-web-auth/v1-code-verifier", "x");
		localStorage.setItem(authStorageKey("https://aaaa.supabase.co"), "keep");
		createCloud({ projectUrl: "https://aaaa.supabase.co", publishableKey: "sb_publishable_test" } as never);
		expect(localStorage.getItem("qorpera-web-auth/v1")).toBeNull();
		expect(localStorage.getItem("qorpera-web-auth/v1-code-verifier")).toBeNull();
		expect(localStorage.getItem(authStorageKey("https://aaaa.supabase.co"))).toBe("keep");
	});
});
