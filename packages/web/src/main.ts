import { mountApplication } from "./app/application.ts";
import { createCloud } from "./cloud/client.ts";
import { resolveCloudConfig } from "./cloud/config.ts";
import { ensureLocaleLoaded, presentationLocale } from "./ui/preferences.ts";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
if (presentationLocale() === "da") {
	void ensureLocaleLoaded().then(() => {
		mountApplication(root, createCloud(resolveCloudConfig()));
	});
} else {
	mountApplication(root, createCloud(resolveCloudConfig()));
}
