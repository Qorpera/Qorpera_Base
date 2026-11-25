import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TEXT_EXPORTS = Object.freeze({
	MODEL_KIT_GUIDE: "packages/runtime/kits/model/KIT.md",
	BOARD_KIT_GUIDE: "packages/runtime/kits/board/KIT.md",
	PATH_KIT_GUIDE: "packages/runtime/kits/path/KIT.md",
	OBJECT_KIT_GUIDE: "packages/runtime/kits/object/KIT.md",
	CURVE_KIT_GUIDE: "packages/runtime/kits/curve/KIT.md",
	STACK_KIT_GUIDE: "packages/runtime/kits/stack/KIT.md",
	SHELF_KIT_GUIDE: "packages/runtime/kits/shelf/KIT.md",
	MAP_KIT_GUIDE: "packages/runtime/kits/map/KIT.md",
	RING_KIT_GUIDE: "packages/runtime/kits/ring/KIT.md",
	FLOW_KIT_GUIDE: "packages/runtime/kits/flow/KIT.md",
	MODEL_ENGINE_JS: "packages/runtime/kits/model/engine.js",
	BOARD_ENGINE_JS: "packages/runtime/kits/board/engine.js",
	PATH_ENGINE_JS: "packages/runtime/kits/path/engine.js",
	OBJECT_ENGINE_JS: "packages/runtime/kits/object/engine.js",
	CURVE_ENGINE_JS: "packages/runtime/kits/curve/engine.js",
	STACK_ENGINE_JS: "packages/runtime/kits/stack/engine.js",
	SHELF_ENGINE_JS: "packages/runtime/kits/shelf/engine.js",
	MAP_ENGINE_JS: "packages/runtime/kits/map/engine.js",
	RING_ENGINE_JS: "packages/runtime/kits/ring/engine.js",
	FLOW_ENGINE_JS: "packages/runtime/kits/flow/engine.js",
	OBJECT_THREE_JS: "packages/runtime/kits/object/vendor/three.js",
	OBJECT_THREE_LICENSE: "packages/runtime/kits/object/vendor/three.LICENSE.txt",
	EXPLAINER_ENGINE_JS: "packages/runtime/kits/explainer/engine.js",
	EXPLAINER_VOICE_CAPTIONS_CJS: "packages/runtime/kits/explainer/voice-captions.cjs",
	EXPLAINER_VOICE_PEER_CJS: "packages/runtime/kits/explainer/voice-peer.cjs",
	EXPLAINER_VOICE_ENCODE_CJS: "packages/runtime/kits/explainer/voice-encode.cjs",
});

export async function runtimeEmbeddedAssetPaths(root = defaultRoot) {
	const paths = Object.values(TEXT_EXPORTS);
	const figureFolder = join(root, "packages/runtime/kits/figures");
	for (const name of (await readdir(figureFolder)).filter((each) => each.endsWith(".webp")).sort()) {
		paths.push(`packages/runtime/kits/figures/${name}`);
	}
	const skillsFolder = join(root, "packages/runtime/skills");
	for (const entry of (await readdir(skillsFolder, { withFileTypes: true }))
		.filter((each) => each.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
		paths.push(`packages/runtime/skills/${entry.name}/SKILL.md`);
	}
	return paths;
}

export function runtimeAssetsPlugin(root = defaultRoot) {
	return {
		name: "qorpera-runtime-embedded-assets",
		setup(build) {
			build.onLoad({ filter: /[\\/]packages[\\/]runtime[\\/]src[\\/]cloud-embedded-assets\.ts$/ }, async () => {
				const lines = [];
				for (const [name, rel] of Object.entries(TEXT_EXPORTS)) {
					let text = await readFile(join(root, rel), "utf8");
					if ((rel.endsWith(".js") || rel.endsWith(".cjs")) && !rel.includes("/vendor/")) {
						text = (await transform(text, { loader: "js", minify: true, legalComments: "none" })).code;
					}
					lines.push(`export const ${name} = ${JSON.stringify(text)};`);
				}
				const figureFolder = join(root, "packages/runtime/kits/figures");
				const figures = {};
				for (const name of (await readdir(figureFolder)).filter((each) => each.endsWith(".webp")).sort()) {
					const bytes = await readFile(join(figureFolder, name));
					figures[name.slice(0, -".webp".length)] = `data:image/webp;base64,${bytes.toString("base64")}`;
				}
				lines.push(`export const KIT_FIGURES = Object.freeze(${JSON.stringify(figures)});`);
				const skillsFolder = join(root, "packages/runtime/skills");
				const skills = {};
				for (const entry of (await readdir(skillsFolder, { withFileTypes: true }))
					.filter((each) => each.isDirectory())
					.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
					skills[entry.name] = await readFile(join(skillsFolder, entry.name, "SKILL.md"), "utf8");
				}
				lines.push(`export const PLATFORM_SKILL_FILES = Object.freeze(${JSON.stringify(skills)});`);
				return { contents: `${lines.join("\n")}\n`, loader: "js" };
			});
		},
	};
}
