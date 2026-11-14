// Renders deploy/coding-worker/coding-gateway-nginx.conf, the coding executor's TLS front on node 2, with the values
// the node's own file holds and the template does not (see the template's head). Every @NAME@ must be given, and no
// value may carry a line break or a brace, so a value can only fill its own place.
//
//   node scripts/coding-gateway-nginx.mjs values.json > nginx.conf
//
// values.json: {"PROCESS": "...", "HTTP": "...", "X_FORWARDED_FOR": "...", "TLS_CERTIFICATE": "...",
// "TLS_CERTIFICATE_KEY": "..."} (PROCESS and HTTP may span lines: the main context's and the http block's own lines).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CODING_GATEWAY_NGINX_TEMPLATE = join(repositoryRoot, "deploy/coding-worker/coding-gateway-nginx.conf");
/** The values that may span lines (whole blocks of the node's own lines); every other one is one word. */
const BLOCKS = new Set(["PROCESS", "HTTP"]);

export function renderCodingGatewayNginx(values, template = readFileSync(CODING_GATEWAY_NGINX_TEMPLATE, "utf8")) {
	const names = [...new Set([...template.matchAll(/@([A-Z_]+)@/g)].map((match) => match[1]))];
	for (const name of Object.keys(values)) if (!names.includes(name)) throw new Error(`unknown value ${name}`);
	return template.replace(/@([A-Z_]+)@/g, (_whole, name) => {
		const value = values[name];
		if (typeof value !== "string" || !value.trim()) throw new Error(`missing value ${name}`);
		if (/[{}]/.test(value) && !BLOCKS.has(name)) throw new Error(`value ${name} has a brace`);
		if (/[\n\r;]/.test(value) && !BLOCKS.has(name)) throw new Error(`value ${name} is more than one word`);
		if (BLOCKS.has(name) && /\bhttp\s*\{|\bserver\s*\{|\blocation\b/.test(value)) throw new Error(`value ${name} opens a block`);
		return value;
	});
}

/** The directives of a rendered file, each with the blocks it sits in (`http > server > location = /v1/home-session`). */
export function nginxDirectives(text) {
	const directives = [];
	const stack = [];
	let current = "";
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "");
		for (const char of line) {
			if (char === "{") {
				stack.push(current.trim().replace(/\s+/g, " "));
				current = "";
			} else if (char === "}") {
				stack.pop();
				current = "";
			} else if (char === ";") {
				const [name, ...rest] = current.trim().split(/\s+/);
				directives.push({ block: stack.join(" > "), name, value: rest.join(" ") });
				current = "";
			} else current += char;
		}
		current += " ";
	}
	if (stack.length !== 0) throw new Error("unbalanced braces");
	return directives;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("usage: coding-gateway-nginx.mjs values.json");
	process.stdout.write(renderCodingGatewayNginx(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}
