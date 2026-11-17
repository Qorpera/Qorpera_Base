// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference, untranslated } from "../src/ui/preferences.ts";
import { runFailureReason, runWaitingReason } from "../src/ui/run-failure.ts";

const REFUSED = "Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]";

afterEach(() => {
	setLanguagePreference("system");
});

describe("a run ChatGPT turned away for too many requests at once, in Danish", () => {
	it("says it waits, that it was turned away, and that the login is fine", () => {
		expect(setLanguagePreference("da")).toBe(true);
		expect(runFailureReason(REFUSED, "failed", false, { own: true }, true)).toBe(
			"ChatGPT afviste kørslen, fordi der kom for mange forespørgsler på én gang. Loginnet er i orden.",
		);
		expect(runWaitingReason(new Date(Date.now() + 90_000).toISOString(), {}, true)).toBe(
			"ChatGPT har travlt med for mange forespørgsler på én gang. Arbejdet venter et par minutter og prøver så igen af sig selv. Loginnet er i orden.",
		);
		expect(untranslated()).toEqual([]);
	});
});
