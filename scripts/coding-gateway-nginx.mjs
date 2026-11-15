import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CODING_GATEWAY_NGINX_TEMPLATE = join(repositoryRoot, "deploy/coding-worker/coding-gateway-nginx.conf");
export const CODING_GATEWAY_FRONTS = Object.freeze({
	ingress: "qorpera-coding-gateway",
	peer: "qorpera-coding-gateway-peer",
});

export function renderCodingGatewayNginx(front, template = readFileSync(CODING_GATEWAY_NGINX_TEMPLATE, "utf8")) {
	if (typeof front !== "string" || !Object.hasOwn(CODING_GATEWAY_FRONTS, front))
		throw new Error(`unknown front ${front}`);
	const markers = new Map(Object.keys(CODING_GATEWAY_FRONTS).map((name) => [`@${name.toUpperCase()}@`, name]));
	const lines = [];
	for (const line of template.split("\n")) {
		const marker = /^@[^@\s]+@/.exec(line)?.[0];
		if (marker === undefined) lines.push(line);
		else if (!markers.has(marker)) throw new Error(`unknown front ${marker}`);
		else if (markers.get(marker) === front) lines.push(line.slice(marker.length));
	}
	const rendered = lines.join("\n").replaceAll("@UNIT@", CODING_GATEWAY_FRONTS[front]);
	const unknown = /@[^@\s]*@?/.exec(rendered);
	if (unknown) throw new Error(`unknown value ${unknown[0]}`);
	return rendered;
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
				if (current.trim()) throw new Error(`no ; after ${current.trim()}`);
				if (stack.length === 0) throw new Error("unbalanced braces");
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
	if (current.trim()) throw new Error(`no ; after ${current.trim()}`);
	if (stack.length !== 0) throw new Error("unbalanced braces");
	return directives;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3)
		throw new Error(`usage: coding-gateway-nginx.mjs ${Object.keys(CODING_GATEWAY_FRONTS).join("|")}`);
	process.stdout.write(renderCodingGatewayNginx(process.argv[2]));
}
