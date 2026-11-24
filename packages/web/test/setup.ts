import { afterAll, expect } from "vitest";
import * as localSandbox from "../src/app/surface-local-sandbox.ts";
import { registerLocalSandbox } from "../src/app/surfaces-store.ts";
import { DANISH } from "../src/ui/danish/index.ts";
import { registerDanishDictionary, untranslated } from "../src/ui/preferences.ts";
import "./register-lazy.ts";

registerDanishDictionary(DANISH);
registerLocalSandbox(localSandbox);

// Every piece of interface text a test file drew must have Danish; keys built
// at run time never show up in test/translations.test.ts's source scan.
afterAll(() => {
	expect(untranslated(), "interface text without Danish (add it to src/ui/danish/)").toEqual([]);
});
