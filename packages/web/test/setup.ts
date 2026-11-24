import { afterAll, expect } from "vitest";
import { registerLazyApplicationModules } from "../src/app/application.ts";
import { FoundingController } from "../src/app/founding.ts";
import * as localSandbox from "../src/app/surface-local-sandbox.ts";
import { registerLocalSandbox } from "../src/app/surfaces-store.ts";
import * as companyFolder from "../src/app/views/company-folder.ts";
import * as concepts from "../src/app/views/concepts.ts";
import { FoundingView } from "../src/app/views/founding.ts";
import * as interfaceView from "../src/app/views/interface.ts";
import * as newProgram from "../src/app/views/program-add.ts";
import * as siteView from "../src/app/views/site-view.ts";
import * as surfaceView from "../src/app/views/surface-view.ts";
import { DANISH } from "../src/ui/danish/index.ts";
import { registerDanishDictionary, untranslated } from "../src/ui/preferences.ts";

registerDanishDictionary(DANISH);
registerLocalSandbox(localSandbox);
registerLazyApplicationModules({
	interfaceView,
	surfaceView,
	companyFolder,
	founding: { FoundingController, FoundingView },
	concepts,
	newProgram,
	siteView,
});

// Every piece of interface text a test file drew must have Danish; keys built
// at run time never show up in test/translations.test.ts's source scan.
afterAll(() => {
	expect(untranslated(), "interface text without Danish (add it to src/ui/danish/)").toEqual([]);
});
