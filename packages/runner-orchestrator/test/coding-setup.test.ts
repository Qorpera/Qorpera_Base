import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type CodingSetupEntry,
	type CodingSetupRead,
	EMPTY_CODING_SETUP,
	EMPTY_CODING_SETUP_DIGEST,
	MAX_CODING_SETUP_DOCKERFILE_BYTES,
	MAX_CODING_SETUP_FILE_BYTES,
	readCodingSetup,
} from "../src/coding-setup.ts";

const OTHER = Symbol("a folder, symlink or submodule");
type Tree = Record<string, string | Uint8Array | typeof OTHER>;

/** A commit's files, read as the code host does: a file comes back cut at one byte past the cap. */
function source(tree: Tree) {
	const reads: [string, number][] = [];
	return {
		reads,
		async read(path: string, maxBytes: number): Promise<CodingSetupEntry> {
			reads.push([path, maxBytes]);
			if (!Object.hasOwn(tree, path)) return { kind: "missing" };
			const entry = tree[path];
			if (entry === OTHER) return { kind: "other" };
			const bytes = typeof entry === "string" ? new TextEncoder().encode(entry) : entry;
			return { kind: "file", bytes: bytes.subarray(0, maxBytes + 1) };
		},
	};
}

const read = (tree: Tree) => readCodingSetup(source(tree));
const cursor = (text: string, more: Tree = {}) => read({ ".cursor/environment.json": text, ...more });
const devcontainer = (text: string, more: Tree = {}) => read({ ".devcontainer/devcontainer.json": text, ...more });
const problems = (result: CodingSetupRead) => result.problems.map((p) => `${p.effect} ${p.code} ${p.at}`);

function expectRefused(result: CodingSetupRead) {
	expect(result.refused).toBe(true);
	expect(result.setup).toBe(EMPTY_CODING_SETUP);
	expect(result.digest).toBe(EMPTY_CODING_SETUP_DIGEST);
	expect(result.dockerfiles).toEqual([]);
}

const EMPTY = {
	name: null,
	base: { kind: "machine" },
	user: null,
	initialize: [],
	install: [],
	start: [],
	terminals: [],
	ports: [],
	env: {},
	repositoryDependencies: [],
	features: {},
	featureInstallOrder: [],
	chromeExecutablePath: null,
	enableTesting: true,
	mcp: { disableAll: false, allowlist: [] },
};
const shell = (from: string, line: string) => ({ from, commands: [{ name: null, run: { shell: line } }] });

describe("which setup file", () => {
	it("gives a repository without one the empty setup, whose digest is SHA-256 of no bytes", async () => {
		const files = source({ "README.md": "# hi" });
		const result = await readCodingSetup(files);
		expect(result).toEqual({
			file: null,
			refused: false,
			setup: EMPTY_CODING_SETUP,
			digest: EMPTY_CODING_SETUP_DIGEST,
			dockerfiles: [],
			problems: [],
		});
		expect(EMPTY_CODING_SETUP_DIGEST).toBe(createHash("sha256").update("").digest("hex"));
		expect(EMPTY_CODING_SETUP).toEqual({ format: null, ...EMPTY });
		expect(Object.isFrozen(EMPTY_CODING_SETUP.mcp.allowlist)).toBe(true);
		expect(files.reads).toEqual([
			[".qorpera/environment.json", MAX_CODING_SETUP_FILE_BYTES],
			[".cursor/environment.json", MAX_CODING_SETUP_FILE_BYTES],
			[".devcontainer/devcontainer.json", MAX_CODING_SETUP_FILE_BYTES],
		]);
	});

	it("takes the first that exists: ours, then Cursor's, then devcontainer.json", async () => {
		const devcontainerFile = { ".devcontainer/devcontainer.json": '{"postCreateCommand":"devcontainer"}' };
		const cursorFile = { ".cursor/environment.json": '{"install":"cursor"}', ...devcontainerFile };
		const files = source({ ".qorpera/environment.json": '{"install":"ours"}', ...cursorFile });
		const ours = await readCodingSetup(files);
		expect(ours.file).toEqual({ path: ".qorpera/environment.json", format: "qorpera" });
		expect(ours.setup.install).toEqual([shell("install", "ours")]);
		expect(files.reads).toHaveLength(1);
		expect((await read(cursorFile)).setup.install).toEqual([shell("install", "cursor")]);
		const result = await read(devcontainerFile);
		expect(result.file).toEqual({ path: ".devcontainer/devcontainer.json", format: "devcontainer" });
		expect(result.setup.install).toEqual([shell("postCreateCommand", "devcontainer")]);
	});

	it("refuses a setup path that isn't a regular file, without falling through to the next", async () => {
		const files = source({ ".qorpera/environment.json": OTHER, ".cursor/environment.json": "{}" });
		const result = await readCodingSetup(files);
		expect(result.file).toEqual({ path: ".qorpera/environment.json", format: "qorpera" });
		expectRefused(result);
		expect(problems(result)).toEqual(["refused NOT_A_FILE "]);
		expect(files.reads).toHaveLength(1);
	});

	it("passes on a read that fails: that is not a missing file", async () => {
		await expect(
			readCodingSetup({
				read: async () => {
					throw new Error("git show failed");
				},
			}),
		).rejects.toThrow("git show failed");
	});
});

describe("Cursor's keys", () => {
	it("maps each of them", async () => {
		const image = `ghcr.io/acme/dev:1.2@sha256:${"a".repeat(64)}`;
		const result = await cursor(`{
			// The schema allows comments.
			"$schema": "https://www.cursor.com/schemas/environment.schema.json",
			"name": "web",
			"user": "ubuntu",
			"image": "${image}",
			"install": "npm ci",
			"start": "sudo service docker start",
			"terminals": [
				{ "name": "dev", "command": "npm run dev", "description": "The dev server" },
				[{ "command": "npm test -- --watch" }, { "name": "logs", "command": "tail -f log", "color": "blue" }],
				[]
			],
			"ports": [{ "port": 3000, "name": "web" }, { "port": 5432 }],
			"repositoryDependencies": ["github.com/Acme/Shared", "https://github.com/acme/tools.git", "github.com/acme/shared/"],
			"disableAllMcpServers": false,
			"mcpServerAllowlist": [
				{ "name": "docs", "serverUrl": "https://mcp.example.com", "toolAllowlist": ["search"] },
				{ "command": "npx mcp" }
			],
			"chromeExecutablePath": "/usr/bin/chromium",
			"enable_testing": "false"
		}`);
		expect(result.refused).toBe(false);
		expect(result.setup).toEqual({
			...EMPTY,
			format: "cursor",
			name: "web",
			base: { kind: "image", image },
			user: "ubuntu",
			install: [shell("install", "npm ci")],
			start: [shell("start", "sudo service docker start")],
			terminals: [
				[{ name: "dev", command: "npm run dev", description: "The dev server" }],
				[
					{ name: null, command: "npm test -- --watch", description: null },
					{ name: "logs", command: "tail -f log", description: null },
				],
			],
			ports: [
				{ port: 3000, name: "web" },
				{ port: 5432, name: null },
			],
			repositoryDependencies: ["acme/shared", "acme/tools"],
			mcp: {
				disableAll: false,
				allowlist: [
					{ name: "docs", serverUrl: "https://mcp.example.com", command: null, toolAllowlist: ["search"] },
					{ name: null, serverUrl: null, command: "npx mcp", toolAllowlist: [] },
				],
			},
			chromeExecutablePath: "/usr/bin/chromium",
			enableTesting: false,
		});
		expect(problems(result)).toEqual(["ignored IGNORED /terminals/1/1/color"]);
		expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.digest).not.toBe(EMPTY_CODING_SETUP_DIGEST);
		expect(Object.isFrozen(result.setup.terminals[1][0])).toBe(true);
	});

	it("gives an empty file its own digest", async () => {
		const result = await cursor("{}");
		expect(result.refused).toBe(false);
		expect(result.setup).toEqual({ ...EMPTY, format: "cursor" });
		expect(result.digest).not.toBe(EMPTY_CODING_SETUP_DIGEST);
		expect((await read({ ".qorpera/environment.json": "{}" })).digest).not.toBe(result.digest);
	});

	it("finds build paths under the file's folder, as Cursor does", async () => {
		const files = {
			".cursor/Dockerfile": "FROM a\n",
			".cursor/docker/Dockerfile": "FROM b\n",
			Dockerfile: "FROM c\n",
		};
		const cases: [string, string | null, string][] = [
			['{"dockerfile":"Dockerfile"}', ".cursor/Dockerfile", ".cursor"],
			['{"dockerfile":".cursor/docker/Dockerfile","context":"."}', ".cursor/docker/Dockerfile", "."],
			['{"dockerfile":"./docker//Dockerfile","context":"./"}', ".cursor/docker/Dockerfile", "."],
			['{"dockerfile":"../Dockerfile","context":".."}', "Dockerfile", "."],
			['{"dockerfile":"Dockerfile","context":"app/.."}', ".cursor/Dockerfile", ".cursor"],
			['{"dockerfileContents":"FROM d\\n","context":"app"}', null, ".cursor/app"],
		];
		for (const [build, dockerfile, context] of cases) {
			const result = await cursor(`{"build":${build}}`, files);
			expect(result.problems, build).toEqual([]);
			expect(result.setup.base, build).toEqual({
				kind: "dockerfile",
				dockerfile,
				contents: dockerfile === null ? "FROM d\n" : null,
				context,
				args: {},
				target: null,
			});
			expect(result.dockerfiles.map((file) => file.path)).toEqual(dockerfile === null ? [] : [dockerfile]);
		}
		const ours = await read({
			".qorpera/environment.json": '{"build":{"dockerfile":"Dockerfile"}}',
			".qorpera/Dockerfile": "FROM e\n",
		});
		expect(ours.setup.base).toMatchObject({ dockerfile: ".qorpera/Dockerfile", context: ".qorpera" });
	});

	it("refuses a path that leaves the repository or isn't a plain relative path", async () => {
		for (const build of [
			'{"dockerfile":"../../Dockerfile"}',
			'{"dockerfile":"/etc/Dockerfile"}',
			'{"dockerfile":""}',
			'{"dockerfile":"docker\\\\Dockerfile"}',
			'{"dockerfile":"a\\u0000b"}',
			'{"dockerfile":".."}',
			'{"dockerfileContents":"FROM a","context":"../.."}',
		]) {
			const result = await cursor(`{"build":${build}}`);
			expectRefused(result);
			expect(problems(result), build).toEqual([
				`refused INVALID_PATH /build/${build.includes("context") ? "context" : "dockerfile"}`,
			]);
		}
	});

	it("refuses a build without a Dockerfile, or a setup with two bases", async () => {
		const files = { ".cursor/Dockerfile": "FROM a\n" };
		const cases: [string, string[]][] = [
			['{"build":{}}', ["refused MISSING_KEY /build"]],
			['{"build":{"dockerfile":"Dockerfile","dockerfileContents":"FROM a"}}', ["refused CONFLICT /build"]],
			['{"build":{"dockerfile":"Dockerfile"},"image":"ubuntu:24.04"}', ["refused CONFLICT /image"]],
			['{"build":{"dockerfile":"Dockerfile","args":{}}}', ["refused UNKNOWN_KEY /build/args"]],
		];
		for (const [text, expected] of cases) {
			const result = await cursor(text, files);
			expectRefused(result);
			expect(problems(result), text).toEqual(expected);
		}
	});

	it("ignores, with a report, the keys the platform decides, and keeps the setup's digest", async () => {
		const plain = await cursor('{"install":"npm ci"}');
		const result = await cursor(`{
			"install": "npm ci",
			"snapshot": "snapshot-1",
			"agentCanUpdateSnapshot": true,
			"egressAllowlist": ["registry.npmjs.org"],
			"egressMode": "allowlist"
		}`);
		expect(result.refused).toBe(false);
		expect(result.setup).toEqual(plain.setup);
		expect(result.digest).toBe(plain.digest);
		expect(problems(result)).toEqual([
			"ignored IGNORED /snapshot",
			"ignored IGNORED /agentCanUpdateSnapshot",
			"ignored IGNORED /egressAllowlist",
			"ignored IGNORED /egressMode",
		]);
		expect(result.problems[2].message).toBe("The company's exit rules govern the network.");
	});

	it("adds GitHub repositories only, as <owner>/<name> in lower case", async () => {
		const result = await cursor(
			'{"repositoryDependencies":["gitlab.com/a/b","github.com/a","github.com/-bad/x","http://github.com/a/b","GitHub.com/A/B.git"]}',
		);
		expect(result.refused).toBe(false);
		expect(result.setup.repositoryDependencies).toEqual(["a/b"]);
		expect(problems(result)).toEqual([
			"ignored IGNORED /repositoryDependencies/0",
			"ignored IGNORED /repositoryDependencies/1",
			"ignored IGNORED /repositoryDependencies/2",
			"ignored IGNORED /repositoryDependencies/3",
		]);
		expectRefused(await cursor('{"repositoryDependencies":["github.com/a/b",7]}'));
	});

	it("refuses an unknown key or a wrong value, and reports every problem", async () => {
		const result = await cursor(`{
			"install": 1,
			"stat": "x",
			"build": { "dockerfile": "Dockerfile", "extra": true },
			"ports": [{ "port": 0 }, { "name": "x" }, { "port": 80 }, { "port": 80 }],
			"enable_testing": "yes",
			"user": "Bad User",
			"image": "Ubuntu",
			"mcpServerAllowlist": [{ "name": "x" }, { "command": "y", "env": {} }],
			"terminals": [{ "name": "x" }],
			"__proto__": {}
		}`);
		expect(result.file).toEqual({ path: ".cursor/environment.json", format: "cursor" });
		expectRefused(result);
		expect(problems(result)).toEqual([
			"refused WRONG_TYPE /install",
			"refused UNKNOWN_KEY /stat",
			"refused UNKNOWN_KEY /build/extra",
			"refused INVALID_VALUE /ports/0/port",
			"refused MISSING_KEY /ports/1",
			"refused DUPLICATE /ports/3",
			"refused WRONG_TYPE /enable_testing",
			"refused INVALID_VALUE /user",
			"refused INVALID_VALUE /image",
			"refused MISSING_KEY /mcpServerAllowlist/0",
			"refused UNKNOWN_KEY /mcpServerAllowlist/1/env",
			"refused MISSING_KEY /terminals/0",
			"refused UNKNOWN_KEY /__proto__",
			"refused CONFLICT /image",
			"refused DOCKERFILE_MISSING /build/dockerfile",
		]);
	});
});

describe("reading the file", () => {
	it("takes comments in every format and trailing commas in devcontainer.json only", async () => {
		const commented = await cursor('/* lead */ {"install": "echo // kept /* kept */" // trailing\n}');
		expect(commented.setup.install).toEqual([shell("install", "echo // kept /* kept */")]);
		const trailing = await cursor('{"install":"npm ci",}');
		expectRefused(trailing);
		expect(trailing.problems).toEqual([
			{
				at: "",
				effect: "refused",
				code: "SYNTAX",
				message: "Line 1, column 21: A comma before '}': this file allows no trailing commas.",
			},
		]);
		const devcontainerTrailing = await devcontainer('{"forwardPorts":[3000,],"postCreateCommand":"npm ci",}');
		expect(devcontainerTrailing.problems).toEqual([]);
		expect(devcontainerTrailing.setup.ports).toEqual([{ port: 3000, name: null }]);
	});

	it("refuses a file it can't read, saying where", async () => {
		const deep = (levels: number) => `{"a":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;
		const cases: [string, string][] = [
			['{"install":"a","install":"b"}', 'Line 1, column 16: The key "install" appears twice.'],
			['{\n  "install": "npm ci"\n  /* never closed\n}', "Line 3, column 3: A comment is never closed."],
			[deep(33), "Line 1, column 37: The file nests deeper than 32 levels."],
			["{} {}", "Line 1, column 4: Text follows the value."],
			["", "Line 1, column 1: The file ends where a value was expected."],
			['{"name":"\\ud800"}', "Line 1, column 16: A string holds half of a UTF-16 surrogate pair."],
			['{"name":"a\tb"}', "Line 1, column 11: A string holds a control character; write it as an escape."],
			['{"name":"\\x"}', "Line 1, column 10: A string holds an escape JSON doesn't have."],
			['{"ports":[{"port":1e999}]}', "Line 1, column 19: A number is too large."],
			['{"name":"web"', "Line 1, column 14: Expected ',' or '}'."],
			["{'name':'web'}", "Line 1, column 2: Expected a key in double quotes."],
			['{"install":01}', "Line 1, column 13: Expected ',' or '}'."],
		];
		for (const [text, message] of cases) {
			const result = await cursor(text);
			expectRefused(result);
			expect(result.problems, text).toEqual([{ at: "", effect: "refused", code: "SYNTAX", message }]);
		}
		expect(problems(await cursor(deep(32)))).toEqual(["refused UNKNOWN_KEY /a"]);
	});

	it("refuses a file that is too large, not UTF-8 or not one object", async () => {
		const large = await cursor(`{"install":"${"x".repeat(MAX_CODING_SETUP_FILE_BYTES)}"}`);
		expect(problems(large)).toEqual(["refused TOO_LARGE "]);
		const files = source({ ".cursor/environment.json": new Uint8Array([0x7b, 0xff, 0x7d]) });
		expect(problems(await readCodingSetup(files))).toEqual(["refused NOT_UTF8 "]);
		expect(problems(await cursor("[]"))).toEqual(["refused WRONG_TYPE "]);
		const bom = await cursor('﻿{"install":"npm ci"}');
		expect(bom.problems).toEqual([]);
		expect(bom.digest).toBe((await cursor('{"install":"npm ci"}')).digest);
	});

	it("caps the report at 100 problems, and says how many more there were", async () => {
		const keys = Array.from({ length: 150 }, (_, n) => `"k${n}":1`).join(",");
		const refused = await cursor(`{${keys}}`);
		expect(refused.problems).toHaveLength(101);
		expect(refused.problems[100]).toEqual({
			at: "",
			effect: "refused",
			code: "MORE_PROBLEMS",
			message: "50 more problems are not listed.",
		});
		const ports = Array.from({ length: 120 }, (_, n) => `"host:${n}"`).join(",");
		const ignored = await devcontainer(`{"forwardPorts":[${ports}]}`);
		expect(ignored.refused).toBe(false);
		expect(ignored.problems).toHaveLength(101);
		expect(ignored.problems[100]).toMatchObject({ effect: "ignored", message: "20 more problems are not listed." });
	});
});

describe("devcontainer.json", () => {
	it("maps the reference's keys to the same setup", async () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a devcontainer variable, which stays as written.
		const variable = "${containerEnv:PATH}:/x";
		const result = await devcontainer(
			`{
				"name": "api",
				"build": { "dockerfile": "Dockerfile", "context": "..", "args": { "NODE_VERSION": "22" }, "target": "dev", "cacheFrom": "x" },
				"features": {
					"ghcr.io/devcontainers/features/node:1": { "version": "22" },
					"ghcr.io/devcontainers/features/git:1": "latest",
					"ghcr.io/devcontainers/features/docker-in-docker:2": true,
				},
				"overrideFeatureInstallOrder": ["ghcr.io/devcontainers/features/node:1"],
				"initializeCommand": "echo hi",
				"onCreateCommand": ["npm", "ci"],
				"updateContentCommand": { "web": "npm run build", "api": ["make", "api"] },
				"postCreateCommand": "npm run seed",
				"postStartCommand": "npm run dev",
				"postAttachCommand": { "watch": "npm run watch" },
				"forwardPorts": [3000, "db:5432", 9229],
				"containerEnv": { "NODE_ENV": "development", "DROP": "x" },
				"remoteEnv": { "DROP": null, "EXTRA": "${variable}" },
				"containerUser": "root",
				"remoteUser": "node",
				"customizations": { "vscode": { "extensions": ["dbaeumer.vscode-eslint"] } },
				"privileged": true,
				"hostRequirements": { "cpus": 4 },
			}`,
			{ ".devcontainer/Dockerfile": "FROM node:22\n" },
		);
		expect(result.refused).toBe(false);
		expect(result.setup).toEqual({
			...EMPTY,
			format: "devcontainer",
			name: "api",
			base: {
				kind: "dockerfile",
				dockerfile: ".devcontainer/Dockerfile",
				contents: null,
				context: ".",
				args: { NODE_VERSION: "22" },
				target: "dev",
			},
			user: "node",
			initialize: [shell("initializeCommand", "echo hi")],
			install: [
				{ from: "onCreateCommand", commands: [{ name: null, run: { argv: ["npm", "ci"] } }] },
				{
					from: "updateContentCommand",
					commands: [
						{ name: "api", run: { argv: ["make", "api"] } },
						{ name: "web", run: { shell: "npm run build" } },
					],
				},
				shell("postCreateCommand", "npm run seed"),
			],
			start: [
				shell("postStartCommand", "npm run dev"),
				{ from: "postAttachCommand", commands: [{ name: "watch", run: { shell: "npm run watch" } }] },
			],
			ports: [
				{ port: 3000, name: null },
				{ port: 9229, name: null },
			],
			env: { NODE_ENV: "development", EXTRA: variable },
			features: {
				"ghcr.io/devcontainers/features/node:1": { version: "22" },
				"ghcr.io/devcontainers/features/git:1": "latest",
				"ghcr.io/devcontainers/features/docker-in-docker:2": true,
			},
			featureInstallOrder: ["ghcr.io/devcontainers/features/node:1"],
		});
		expect(Object.getPrototypeOf(result.setup.features["ghcr.io/devcontainers/features/node:1"])).toBe(
			Object.prototype,
		);
		expect(problems(result)).toEqual([
			"ignored IGNORED /customizations",
			"ignored IGNORED /privileged",
			"ignored IGNORED /hostRequirements",
			"ignored IGNORED /forwardPorts/1",
			"ignored IGNORED /build/cacheFrom",
		]);
		expect(result.dockerfiles).toEqual([
			{ path: ".devcontainer/Dockerfile", bytes: new TextEncoder().encode("FROM node:22\n") },
		]);
	});

	it("takes an image, or the older dockerFile and context keys", async () => {
		const image = await devcontainer('{"image":"mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm"}');
		expect(image.setup.base).toEqual({
			kind: "image",
			image: "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
		});
		const older = await devcontainer('{"dockerFile":"../Dockerfile","context":".."}', { Dockerfile: "FROM a\n" });
		expect(older.problems).toEqual([]);
		expect(older.setup.base).toEqual({
			kind: "dockerfile",
			dockerfile: "Dockerfile",
			contents: null,
			context: ".",
			args: {},
			target: null,
		});
	});

	it("refuses compose, a key outside the reference, two bases or a context without a Dockerfile", async () => {
		const files = { ".devcontainer/Dockerfile": "FROM a\n" };
		const cases: [string, string[]][] = [
			[
				'{"dockerComposeFile":"compose.yml","service":"app"}',
				["refused NOT_SUPPORTED /dockerComposeFile", "refused NOT_SUPPORTED /service"],
			],
			['{"imagee":"node:22"}', ["refused UNKNOWN_KEY /imagee"]],
			['{"image":"node:22","build":{"dockerfile":"Dockerfile"}}', ["refused CONFLICT /image"]],
			['{"dockerFile":"Dockerfile","build":{"dockerfile":"Dockerfile"}}', ["refused CONFLICT /dockerFile"]],
			['{"context":".","build":{"dockerfile":"Dockerfile","context":"."}}', ["refused CONFLICT /context"]],
			['{"build":{"context":".."}}', ["refused MISSING_KEY /build"]],
			['{"context":".."}', ["refused MISSING_KEY /context"]],
			['{"build":{"dockerfile":"Dockerfile","args":{"1X":"a"}}}', ["refused INVALID_VALUE /build/args/1X"]],
			['{"onCreateCommand":[]}', ["refused INVALID_VALUE /onCreateCommand"]],
			['{"onCreateCommand":["npm",1]}', ["refused WRONG_TYPE /onCreateCommand/1"]],
			['{"postCreateCommand":{"a":1}}', ["refused WRONG_TYPE /postCreateCommand/a"]],
			['{"postStartCommand":true}', ["refused WRONG_TYPE /postStartCommand"]],
			['{"containerEnv":{"1BAD":"x"}}', ["refused INVALID_VALUE /containerEnv/1BAD"]],
			['{"containerEnv":{"A":null}}', ["refused WRONG_TYPE /containerEnv/A"]],
			['{"remoteEnv":{"A":"a\\u0000b"}}', ["refused WRONG_TYPE /remoteEnv/A"]],
			['{"features":{"x":1}}', ["refused WRONG_TYPE /features/x"]],
			['{"forwardPorts":[80,80]}', ["refused DUPLICATE /forwardPorts/1"]],
			['{"remoteUser":"a/b"}', ["refused INVALID_VALUE /remoteUser"]],
		];
		for (const [text, expected] of cases) {
			const result = await devcontainer(text, files);
			expectRefused(result);
			expect(problems(result), text).toEqual(expected);
		}
	});
});

describe("the setup digest", () => {
	it("is the same for the same setup written differently", async () => {
		const plain = await cursor(
			'{"install":"npm ci","ports":[{"port":3000,"name":"web"}],"repositoryDependencies":["github.com/a/b","github.com/c/d"]}',
		);
		const other = await cursor(`// The setup.
			{
				"repositoryDependencies": ["https://github.com/C/D.git", "github.com/a/b", "github.com/a/b/"],
				"enable_testing": "true",
				"ports": [ { "name": "web", "port": 3000, "label": "ignored" } ],
				"install": "npm ci"
			}`);
		expect(other.refused).toBe(false);
		expect(other.digest).toBe(plain.digest);
		expect((await read({ ".qorpera/environment.json": '{"install":"npm ci"}' })).digest).not.toBe(
			(await cursor('{"install":"npm ci"}')).digest,
		);
		expect((await cursor('{"install":"npm ci "}')).digest).not.toBe((await cursor('{"install":"npm ci"}')).digest);
	});

	it("changes when only a named Dockerfile changes", async () => {
		const text = '{"build":{"dockerfile":"Dockerfile"}}';
		const files = source({ ".cursor/environment.json": text, ".cursor/Dockerfile": "FROM ubuntu:24.04\n" });
		const first = await readCodingSetup(files);
		expect(files.reads.at(-1)).toEqual([".cursor/Dockerfile", MAX_CODING_SETUP_DOCKERFILE_BYTES]);
		const second = await cursor(text, { ".cursor/Dockerfile": "FROM ubuntu:24.10\n" });
		expect(second.setup).toEqual(first.setup);
		expect(second.digest).not.toBe(first.digest);
	});

	it("refuses a named Dockerfile that is missing, not a file or over 1 MiB", async () => {
		const text = '{"build":{"dockerfile":"Dockerfile"}}';
		const cases: [Tree, string][] = [
			[{}, "DOCKERFILE_MISSING"],
			[{ ".cursor/Dockerfile": OTHER }, "DOCKERFILE_NOT_A_FILE"],
			[{ ".cursor/Dockerfile": "#".repeat(MAX_CODING_SETUP_DOCKERFILE_BYTES + 1) }, "DOCKERFILE_TOO_LARGE"],
		];
		for (const [files, code] of cases) {
			const result = await cursor(text, files);
			expectRefused(result);
			expect(problems(result)).toEqual([`refused ${code} /build/dockerfile`]);
		}
		expect(
			(await cursor(text, { ".cursor/Dockerfile": "#".repeat(MAX_CODING_SETUP_DOCKERFILE_BYTES) })).refused,
		).toBe(false);
	});

	it("is SHA-256 over the framed schema, canonical setup and Dockerfiles", async () => {
		const result = await cursor('{"build":{"dockerfile":"Dockerfile"},"install":"npm ci"}', {
			".cursor/Dockerfile": "FROM ubuntu:24.04\n",
		});
		const canonical =
			'{"base":{"args":{},"contents":null,"context":".cursor","dockerfile":".cursor/Dockerfile","kind":"dockerfile",' +
			'"target":null},"chromeExecutablePath":null,"enableTesting":true,"env":{},"featureInstallOrder":[],"features":{},' +
			'"format":"cursor","initialize":[],"install":[{"commands":[{"name":null,"run":{"shell":"npm ci"}}],"from":"install"}],' +
			'"mcp":{"allowlist":[],"disableAll":false},"name":null,"ports":[],"repositoryDependencies":[],"start":[],' +
			'"terminals":[],"user":null}';
		const frame = (text: string) => {
			const bytes = Buffer.from(text, "utf8");
			const length = Buffer.alloc(8);
			length.writeBigUInt64BE(BigInt(bytes.length));
			return Buffer.concat([length, bytes]);
		};
		const framed = ["qorpera.coding-setup-digest/v1", canonical, ".cursor/Dockerfile", "FROM ubuntu:24.04\n"].map(
			frame,
		);
		expect(result.digest).toBe(createHash("sha256").update(Buffer.concat(framed)).digest("hex"));
	});
});
