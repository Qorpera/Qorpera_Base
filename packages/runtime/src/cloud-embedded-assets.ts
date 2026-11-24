import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readRuntimeText = (relativePath: string): string => readFileSync(join(RUNTIME_ROOT, relativePath), "utf8");

export const MODEL_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/model/KIT.md");
export const BOARD_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/board/KIT.md");
export const PATH_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/path/KIT.md");
export const OBJECT_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/object/KIT.md");
export const CURVE_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/curve/KIT.md");
export const STACK_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/stack/KIT.md");
export const SHELF_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/shelf/KIT.md");
export const MAP_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/map/KIT.md");
export const RING_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/ring/KIT.md");
export const FLOW_KIT_GUIDE: string = /* @__PURE__ */ readRuntimeText("kits/flow/KIT.md");

export const MODEL_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/model/engine.js");
export const BOARD_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/board/engine.js");
export const PATH_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/path/engine.js");
export const OBJECT_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/object/engine.js");
export const CURVE_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/curve/engine.js");
export const STACK_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/stack/engine.js");
export const SHELF_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/shelf/engine.js");
export const MAP_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/map/engine.js");
export const RING_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/ring/engine.js");
export const FLOW_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/flow/engine.js");

export const OBJECT_THREE_JS: string = /* @__PURE__ */ readRuntimeText("kits/object/vendor/three.js");
export const OBJECT_THREE_LICENSE: string = /* @__PURE__ */ readRuntimeText("kits/object/vendor/three.LICENSE.txt");

export const EXPLAINER_ENGINE_JS: string = /* @__PURE__ */ readRuntimeText("kits/explainer/engine.js");
export const EXPLAINER_VOICE_CAPTIONS_CJS: string = /* @__PURE__ */ readRuntimeText(
	"kits/explainer/voice-captions.cjs",
);
export const EXPLAINER_VOICE_PEER_CJS: string = /* @__PURE__ */ readRuntimeText("kits/explainer/voice-peer.cjs");
export const EXPLAINER_VOICE_ENCODE_CJS: string = /* @__PURE__ */ readRuntimeText("kits/explainer/voice-encode.cjs");

function loadKitFigures(): Readonly<Record<string, string>> {
	const folder = join(RUNTIME_ROOT, "kits/figures");
	const entries = readdirSync(folder)
		.filter((name) => name.endsWith(".webp"))
		.sort()
		.map((name) => [
			name.slice(0, -".webp".length),
			`data:image/webp;base64,${readFileSync(join(folder, name)).toString("base64")}`,
		]);
	return Object.freeze(Object.fromEntries(entries));
}

function loadPlatformSkillFiles(): Readonly<Record<string, string>> {
	const folder = join(RUNTIME_ROOT, "skills");
	const entries = readdirSync(folder, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => [name, readFileSync(join(folder, name, "SKILL.md"), "utf8")]);
	return Object.freeze(Object.fromEntries(entries));
}

export const KIT_FIGURES: Readonly<Record<string, string>> = /* @__PURE__ */ loadKitFigures();
export const PLATFORM_SKILL_FILES: Readonly<Record<string, string>> = /* @__PURE__ */ loadPlatformSkillFiles();
