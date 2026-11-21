import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CODING_GATEWAY_FRONTS, nginxDirectives, renderCodingGatewayNginx } from "./coding-gateway-nginx.mjs";

const NODE_FILES = {
	ingress: new URL("./fixtures/coding-gateway-nginx/node2-nginx.conf", import.meta.url),
	peer: new URL("./fixtures/coding-gateway-nginx/node2-peer-nginx.conf", import.meta.url),
};
const FRONTS = Object.keys(NODE_FILES);
const HOME_OPEN = "\t\tlocation = /v1/home-session {";
const HOME = "http > server > location = /v1/home-session";
const REST = "http > server > location /";
const SERVER = "http > server";
const channelSource = readFileSync(new URL("../packages/runtime/src/cloud-home-channel.ts", import.meta.url), "utf8");

function withoutHome(text) {
	const lines = text.split("\n");
	const start = lines.indexOf(HOME_OPEN);
	assert.ok(start >= 0 && lines.lastIndexOf(HOME_OPEN) === start, "one home location");
	const end = lines.indexOf("\t\t}", start);
	assert.ok(end > start);
	lines.splice(start, end - start + 1);
	return lines.join("\n");
}

function at(directives, block, name) {
	return directives.filter((d) => d.block === block && d.name === name).map((d) => d.value);
}

test("each front with the home's location taken out and connection-limit directives restored is the node's own file, byte for byte", () => {
	assert.deepEqual(Object.keys(CODING_GATEWAY_FRONTS), FRONTS);
	for (const front of FRONTS) {
		const rendered = renderCodingGatewayNginx(front);
		const nodeFile = readFileSync(NODE_FILES[front]);
		assert.notEqual(rendered, nodeFile.toString("utf8"));
		const withoutHomeRoute = withoutHome(rendered);
		assert.equal(withoutHomeRoute.match(/^worker_rlimit_nofile 4096;$/gm)?.length, 1, front);
		assert.equal(withoutHomeRoute.match(/^events \{ worker_connections 2048; \}$/gm)?.length, 1, front);
		const normalized = withoutHomeRoute
			.replace("worker_rlimit_nofile 4096;\n", "")
			.replace("events { worker_connections 2048; }", "events { worker_connections 256; }");
		assert.ok(Buffer.from(normalized, "utf8").equals(nodeFile), front);
	}
});

test("only the home's location passes the upgrade, unbuffered, with timeouts its keep-alive holds open", () => {
	const keepAlive = Number(
		/CLOUD_HOME_CHANNEL_KEEPALIVE_MS = ([0-9_]+);/.exec(channelSource)?.[1].replaceAll("_", ""),
	);
	assert.equal(keepAlive, 20000);
	assert.match(channelSource, /export const CLOUD_HOME_CHANNEL_PATH = "\/v1\/home-session";/);
	for (const front of FRONTS) {
		const directives = nginxDirectives(renderCodingGatewayNginx(front));
		assert.deepEqual(
			directives.filter((d) => d.block === HOME).map((d) => `${d.name} ${d.value}`),
			[
				"proxy_pass http://127.0.0.1:18789",
				"proxy_set_header Host 127.0.0.1",
				'proxy_set_header X-Forwarded-For ""',
				"proxy_set_header Upgrade $http_upgrade",
				'proxy_set_header Connection "upgrade"',
				"proxy_buffering off",
				"proxy_request_buffering off",
				"proxy_read_timeout 90s",
				"proxy_send_timeout 90s",
			],
		);
		for (const name of ["proxy_read_timeout", "proxy_send_timeout"]) {
			const seconds = Number.parseInt(at(directives, HOME, name)[0], 10);
			assert.ok(seconds * 1000 >= 3 * keepAlive && seconds <= 300, `${front} ${name}`);
		}
		assert.deepEqual(
			directives.filter((d) => d.name === "proxy_set_header" && /^Upgrade\b/i.test(d.value)).map((d) => d.block),
			[HOME],
		);
		assert.deepEqual(
			directives.filter((d) => /upgrade/i.test(d.value)).map((d) => d.block),
			[HOME, HOME],
		);
		assert.deepEqual(at(directives, "http", "proxy_set_header"), [
			"Host 127.0.0.1",
			"Connection close",
			'X-Forwarded-For ""',
		]);
		assert.deepEqual(at(directives, REST, "proxy_set_header"), []);
	}
});

test("every location denies every method but its own", () => {
	for (const front of FRONTS) {
		const directives = nginxDirectives(renderCodingGatewayNginx(front));
		const locations = [...new Set(directives.map((d) => d.block).filter((block) => block.includes("location")))];
		assert.deepEqual(locations, [`${HOME} > limit_except GET`, HOME, `${REST} > limit_except POST`, REST]);
		assert.deepEqual(
			directives.filter((d) => d.block.includes("limit_except")).map((d) => `${d.block}: ${d.name} ${d.value}`),
			[`${HOME} > limit_except GET: deny all`, `${REST} > limit_except POST: deny all`],
		);
	}
});

test("the peer's allow and deny stand at server level, so they cover the home's location too", () => {
	const peer = nginxDirectives(renderCodingGatewayNginx("peer"));
	assert.deepEqual(
		peer.filter((d) => d.name === "allow" || (d.name === "deny" && !d.block.includes("limit_except"))),
		[
			{ block: SERVER, name: "allow", value: "100.75.4.70" },
			{ block: SERVER, name: "deny", value: "all" },
		],
	);
	assert.deepEqual(at(peer, SERVER, "listen"), ["100.80.160.64:8789 ssl"]);
	const ingress = nginxDirectives(renderCodingGatewayNginx("ingress"));
	assert.deepEqual(
		ingress.filter((d) => d.name === "allow" || (d.name === "deny" && !d.block.includes("limit_except"))),
		[],
	);
	assert.deepEqual(at(ingress, SERVER, "listen"), ["10.41.0.1:8789 ssl"]);
});

test("both files have balanced blocks and each directive in the block the node has it in", () => {
	for (const front of FRONTS) {
		const directives = nginxDirectives(renderCodingGatewayNginx(front));
		assert.deepEqual(
			[...new Set(directives.map((d) => d.block))],
			["", "events", "http", SERVER, `${HOME} > limit_except GET`, HOME, `${REST} > limit_except POST`, REST],
		);
		assert.deepEqual(at(directives, "", "worker_rlimit_nofile"), ["4096"]);
		assert.deepEqual(at(directives, "", "pid"), [`/run/${CODING_GATEWAY_FRONTS[front]}/nginx.pid`]);
		assert.deepEqual(at(directives, "events", "worker_connections"), ["2048"]);
		assert.deepEqual(at(directives, SERVER, "ssl_protocols"), ["TLSv1.3"]);
		assert.deepEqual(at(directives, SERVER, "ssl_session_cache"), ["off"]);
		assert.deepEqual(at(directives, SERVER, "ssl_certificate"), [
			`/run/credentials/${CODING_GATEWAY_FRONTS[front]}.service/gateway.crt`,
		]);
		assert.deepEqual(at(directives, REST, "proxy_pass"), ["http://127.0.0.1:18789"]);
	}
	assert.throws(() => nginxDirectives("http {\n\tserver {\n\t}\n"), /unbalanced/);
	assert.throws(() => nginxDirectives("http {\n}\n}\n"), /unbalanced/);
	assert.throws(() => nginxDirectives("http {\n\tdeny all }\n"), /no ; after deny all/);
	assert.throws(() => nginxDirectives("worker_processes 1"), /no ; after worker_processes 1/);
});

test("the script renders only a front it knows, from a template with nothing it does not know", () => {
	for (const front of ["", "node1", "INGRESS", "toString", "__proto__", undefined]) {
		assert.throws(() => renderCodingGatewayNginx(front), /unknown front/);
	}
	const template = readFileSync(new URL("../deploy/coding-worker/coding-gateway-nginx.conf", import.meta.url), "utf8");
	assert.throws(
		() => renderCodingGatewayNginx("ingress", `@node1@\t\tlisten 1.2.3.4:1;\n${template}`),
		/unknown front @node1@/,
	);
	assert.throws(
		() => renderCodingGatewayNginx("peer", template.replace('"";', "@X_FORWARDED_FOR@;")),
		/unknown value @X_FORWARDED_FOR@/,
	);
	assert.doesNotMatch(renderCodingGatewayNginx("ingress"), /@|-peer/);
	assert.doesNotMatch(renderCodingGatewayNginx("peer"), /@|qorpera-coding-gateway[/.]/);
});
