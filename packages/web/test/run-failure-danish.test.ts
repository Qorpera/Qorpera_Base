// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference, untranslated } from "../src/ui/preferences.ts";
import { codingFailureReason, runFailureReason, runWaitingReason } from "../src/ui/run-failure.ts";

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
		expect(runFailureReason(REFUSED, "failed", false, {}, true, true)).toBe(
			"Din besked gik ikke igennem: ChatGPT fik for mange forespørgsler på én gang. Loginnet er i orden.",
		);
		expect(untranslated()).toEqual([]);
	});
});

describe("a run ChatGPT no longer accepts the login's sign-in for, in Danish", () => {
	it("asks the member whose login paid to sign in again, and says a waiting run tries again", () => {
		expect(setLanguagePreference("da")).toBe(true);
		expect(runFailureReason(REFUSED, "failed", false, { own: true }, false, true, true)).toBe(
			"ChatGPT godtager ikke længere loginnet, så arbejdet stoppede. Log ind igen under Indstillinger → AI-abonnementer.",
		);
		expect(runFailureReason(REFUSED, "failed", false, {}, false, false, true)).toBe(
			"ChatGPT godtager ikke længere det login, der betaler for kørslen, så arbejdet stoppede. Det medlem, der ejer loginnet, kan logge ind igen under Indstillinger → AI-abonnementer.",
		);
		expect(runWaitingReason(new Date(Date.now() + 90_000).toISOString(), {}, false, true)).toBe(
			"ChatGPT godtog ikke loginnet. Qorpera fornyer det, og arbejdet prøver igen af sig selv om et par minutter.",
		);
		expect(untranslated()).toEqual([]);
	});
});

describe("Claude Code coding session failures, in Danish", () => {
	it("translates runtime-emitted Claude coding failure messages cleanly", () => {
		expect(setLanguagePreference("da")).toBe(true);
		expect(codingFailureReason("Stopped", { mine: true }, "CODING_CLAUDE_SIGNED_OUT")).toBe(
			"Claude godtager ikke længere det login, der betaler for sessionen. Log ind igen under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: false }, "CODING_CLAUDE_SIGNED_OUT")).toBe(
			"Claude godtager ikke længere det login, der betaler for sessionen. Det medlem, der ejer loginnet, kan logge ind igen under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: true }, "CODING_CLAUDE_RATE_LIMITED")).toBe(
			"Claude-kontoen, der betaler for sessionen, har nået sin forbrugsgrænse. Arbejdsområdet er gemt; prøv en opfølgning, når grænsen er nulstillet.",
		);
		expect(codingFailureReason("Stopped", { mine: true }, "CODING_CLAUDE_LOGIN_UNAVAILABLE")).toBe(
			"Sessionen kunne ikke hente det login, der betaler for den. Tjek loginnet under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: false }, "CODING_CLAUDE_LOGIN_UNAVAILABLE")).toBe(
			"Sessionen kunne ikke hente det login, der betaler for den. Det medlem, der ejer loginnet, kan tjekke det under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: true }, "CODING_CLAUDE_NOT_OPEN")).toBe(
			"Claude er ikke slået til for din konto i denne virksomhed. Bed en ejer eller administrator om at slå det til, eller vælg en anden standardmodel under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: false }, "CODING_CLAUDE_NOT_OPEN")).toBe(
			"Claude er ikke slået til for sessionens ejer i denne virksomhed. En ejer eller administrator kan slå det til, eller de kan vælge en anden standardmodel under Indstillinger → AI-abonnementer. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(codingFailureReason("Stopped", { mine: true }, "CODING_CLAUDE_OUTPUT_LIMIT")).toBe(
			"Sessionens output blev for stort til én tur. Arbejdsområdet er gemt; en opfølgning fortsætter den.",
		);
		expect(
			runFailureReason(
				"Coding session ended before calling coding_finish. [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]",
				"failed",
			),
		).toBe("Kodningssessionen sluttede uden at gøre sit arbejde færdigt. Fejlen ligger hos Qorpera.");
		expect(untranslated()).toEqual([]);
	});
});
