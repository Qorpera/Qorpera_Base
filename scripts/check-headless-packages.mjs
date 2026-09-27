import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sources(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await sources(path));
		else if (entry.isFile() && /\.(ts|js|cjs|mjs)$/.test(path)) result.push(path);
	}
	return result;
}

/** Check imports, including erased type imports, as well as actual bundled dependency graphs. */
export async function checkHeadlessPackages(root = repository) {
	const failures = [];
	const runtime = await sources(join(root, "packages/runtime/src"));
	for (const name of ["runtime", "cloud-client", "member-web", "web"]) {
		for (const path of await sources(join(root, `packages/${name}/src`))) {
			const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
			for (const statement of source.statements) {
				if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
				const specifier = statement.moduleSpecifier;
				if (!specifier || !ts.isStringLiteral(specifier)) continue;
				const target = specifier.text.startsWith(".")
					? relative(root, resolve(dirname(path), specifier.text))
					: specifier.text;
				const importsRuntime = /^(?:@qorpera\/runtime(?:\/|$)|packages\/runtime\/)/.test(target);
				const importsShell = /^(?:@qorpera\/shell(?:\/|$)|packages\/shell\/)/.test(target);
				const importsDesktop = /^(?:electron(?:-updater)?|@qorpera\/pi-[^/]+)(?:\/|$)/.test(target);
				const importsNodeAdapter = /^(?:node:|@qorpera\/cloud-client\/node(?:\/|$)|packages\/cloud-client\/src\/node\/)/.test(target);
				if ((name !== "runtime" && importsRuntime) || importsShell || importsDesktop || (["member-web", "web"].includes(name) && importsNodeAdapter)) {
					failures.push(`${relative(root, path)} imports ${target}`);
				}
			}
		}
	}
	if (failures.length) throw new Error(`Headless package boundary failed:\n${failures.join("\n")}`);
	const server = await build({ absWorkingDir: root, entryPoints: runtime, outdir: ".headless-check", bundle: true,
		external: ["playwright-core"], // Ships as its pinned package with browser/protocol resources.
		platform: "node", format: "esm", splitting: true, target: "node22.19", metafile: true, write: false, logLevel: "silent" });
	for (const path of Object.keys(server.metafile.inputs)) {
		if (/(?:^|\/)packages\/shell\/|(?:^|\/)node_modules\/(?:electron(?:-updater)?|@qorpera\/pi-[^/]+)(?:\/|$)/.test(path)) {
			throw new Error(`Headless bundle contains desktop implementation: ${path}`);
		}
	}
	const client = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/index.ts"],
		bundle: true, platform: "browser", format: "esm", target: "es2022", metafile: true, write: false, logLevel: "silent" });
	for (const path of Object.keys(client.metafile.inputs)) {
		if (/(?:^|\/)packages\/(?:shell|runtime)\/|packages\/cloud-client\/src\/node\//.test(path)) {
			throw new Error(`Browser client contains a server or Node adapter: ${path}`);
		}
	}
	const web = await build({ absWorkingDir: root, entryPoints: ["packages/member-web/src/entry.mjs"],
		bundle: true, platform: "browser", format: "esm", target: "es2022", metafile: true, write: false, logLevel: "silent" });
	assertMemberWebInputs(web.metafile);
	const productWeb = await build({ absWorkingDir: root, entryPoints: ["packages/web/src/entry.mjs"],
		tsconfig: join(root, "tsconfig.json"), bundle: true, platform: "browser", format: "esm", target: "es2022", metafile: true, write: false, logLevel: "silent" });
	assertMemberWebInputs(productWeb.metafile);
	return { runtimeSources: runtime.length, runtimeInputs: Object.keys(server.metafile.inputs).length,
		browserInputs: Object.keys(client.metafile.inputs).length, webInputs: Object.keys(web.metafile.inputs).length,
		productWebInputs: Object.keys(productWeb.metafile.inputs).length };
}

export function assertMemberWebInputs(metafile) {
	for (const path of Object.keys(metafile.inputs)) {
		if (/(?:^|\/)packages\/(?:shell|runtime|runner-orchestrator|object-gateway)\/|packages\/cloud-client\/(?:src|dist)\/node\/|(?:^|\/)node_modules\/(?:electron(?:-updater)?|@qorpera\/pi-[^/]+)(?:\/|$)/.test(path)) {
			throw new Error(`Member web bundle contains server or desktop authority: ${path}`);
		}
	}
	for (const output of Object.values(metafile.outputs)) {
		if (output.imports.some(entry => entry.external)) throw new Error("Member web bundle has external imports");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(await checkHeadlessPackages()));
}
