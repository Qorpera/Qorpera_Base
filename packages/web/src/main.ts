import { mountApplication } from "./app/application.ts";
import { createCloud } from "./cloud/client.ts";
import { resolveCloudConfig } from "./cloud/config.ts";
import { ensureLocaleLoaded, presentationLocale } from "./ui/preferences.ts";

// WHY: Load lazy-view stylesheets asynchronously after first paint so app.css stays lean and CSP remains strict.
const deferredCss = document.querySelector<HTMLMetaElement>('meta[name="qorpera-deferred-css"]')?.content;
if (deferredCss && !document.querySelector(`link[rel="stylesheet"][href="${deferredCss}"]`)) {
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = deferredCss;
	document.head.append(link);
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
if (presentationLocale() === "da") {
	void ensureLocaleLoaded().then(() => {
		mountApplication(root, createCloud(resolveCloudConfig()));
	});
} else {
	mountApplication(root, createCloud(resolveCloudConfig()));
}
