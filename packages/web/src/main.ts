import { mountApplication } from "./app/application.ts";
import { createCloud } from "./cloud/client.ts";
import { resolveCloudConfig } from "./cloud/config.ts";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
mountApplication(root, createCloud(resolveCloudConfig()));
