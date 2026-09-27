import { afterAll, expect } from "vitest";
import { untranslated } from "../src/ui/preferences.ts";

// Every piece of interface text a test file drew must have Danish; keys built
// at run time never show up in test/translations.test.ts's source scan.
afterAll(() => {
	expect(untranslated(), "interface text without Danish (add it to src/ui/danish/)").toEqual([]);
});
