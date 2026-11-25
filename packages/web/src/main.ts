import { mountApplication } from "./app/application.ts";
import { createCloud } from "./cloud/client.ts";
import { resolveCloudConfig } from "./cloud/config.ts";
import { loadDeferredStyles } from "./ui/deferred-styles.ts";
import { ensureLocaleLoaded, presentationLocale } from "./ui/preferences.ts";

// WHY: Load lazy-view stylesheets asynchronously after first paint so app.css stays lean and CSP remains strict.
void loadDeferredStyles();

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
// WHY: Start auth and profile bootstrap in parallel with the Danish dictionary chunk instead of serializing them.
const localeReady = presentationLocale() === "da" ? ensureLocaleLoaded() : undefined;
mountApplication(
	root,
	createCloud(resolveCloudConfig()),
	undefined,
	undefined,
	localeReady ? { localeReady } : undefined,
);
