#!/usr/bin/env node
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OBJECT_THREE_VERSION = "0.186.1";
export const OBJECT_THREE_SOURCE = "packages/runtime/kits/object/vendor/three.js";
export const OBJECT_THREE_LICENSE_SOURCE = "packages/runtime/kits/object/vendor/three.LICENSE.txt";

const CORE = [
	"AgXToneMapping",
	"BackSide",
	"Box3",
	"Color",
	"CustomBlending",
	"DoubleSide",
	"EquirectangularReflectionMapping",
	"FrontSide",
	"Group",
	"Matrix4",
	"MaxEquation",
	"Mesh",
	"MeshBasicMaterial",
	"OrthographicCamera",
	"PerspectiveCamera",
	"PlaneGeometry",
	"PMREMGenerator",
	"PropertyBinding",
	"REVISION",
	"Scene",
	"ShaderMaterial",
	"SRGBColorSpace",
	"Vector3",
	"WebGLRenderer",
	"WebGLRenderTarget",
];
const ADDONS = {
	GLTFLoader: "loaders/GLTFLoader.js",
	HDRLoader: "loaders/HDRLoader.js",
	RoomEnvironment: "environments/RoomEnvironment.js",
	HorizontalBlurShader: "shaders/HorizontalBlurShader.js",
	VerticalBlurShader: "shaders/VerticalBlurShader.js",
};

async function main() {
	const from = process.argv[2];
	if (!from) throw new Error(`usage: node scripts/build-object-kit-three.mjs <unpacked three@${OBJECT_THREE_VERSION} package>`);
	const three = resolve(from);
	const { version } = JSON.parse(await readFile(join(three, "package.json"), "utf8"));
	if (version !== OBJECT_THREE_VERSION) throw new Error(`${three} holds three ${version}, not ${OBJECT_THREE_VERSION}`);
	const entry = [
		`export { ${CORE.join(", ")} } from "three";`,
		...Object.entries(ADDONS).map(([name, path]) => `export { ${name} } from "three/addons/${path}";`),
	].join("\n");
	const result = await build({
		stdin: { contents: entry, resolveDir: three, loader: "js" },
		bundle: true,
		format: "iife",
		globalName: "QORPERA_THREE",
		platform: "browser",
		target: "es2020",
		minify: true,
		legalComments: "eof",
		write: false,
		logLevel: "silent",
		plugins: [
			{
				name: "three-package",
				setup(on) {
					on.onResolve({ filter: /^three$/ }, () => ({ path: join(three, "build/three.module.js") }));
					on.onResolve({ filter: /^three\/addons\// }, (args) => ({
						path: join(three, "examples/jsm", args.path.slice("three/addons/".length)),
					}));
				},
			},
		],
	});
	await writeFile(join(root, OBJECT_THREE_SOURCE), result.outputFiles[0].text);
	await copyFile(join(three, "LICENSE"), join(root, OBJECT_THREE_LICENSE_SOURCE));
	console.log(`${OBJECT_THREE_SOURCE}: three ${version}, ${result.outputFiles[0].contents.length} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
