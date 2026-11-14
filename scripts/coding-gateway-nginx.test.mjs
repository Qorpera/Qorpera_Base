import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nginxDirectives, renderCodingGatewayNginx } from "./coding-gateway-nginx.mjs";

// The coding executor's TLS front on node 2 (lanes/agent-box-20261113, home-lxd): only the home's own route passes an
// HTTP/1.1 Upgrade; everything else keeps what the node's file had on 14 Nov 2026.

const values = {
	PROCESS: "worker_processes 1;\npid /run/qorpera-coding-gateway.pid;\nevents {\n\tworker_connections 512;\n}",
	HTTP: "access_log off;\nerror_log /var/log/qorpera-coding-gateway/error.log;",
	X_FORWARDED_FOR: "$remote_addr",
	TLS_CERTIFICATE: "/etc/qorpera-coding-gateway/tls.crt",
	TLS_CERTIFICATE_KEY: "/etc/qorpera-coding-gateway/tls.key",
};
const HOME = "http > server > location = /v1/home-session";
const REST = "http > server > location /";

test("only the home's route passes the upgrade, unbuffered, with timeouts its keep-alive holds open", () => {
	const directives = nginxDirectives(renderCodingGatewayNginx(values));
	const at = (block, name) => directives.filter((d) => d.block === block && d.name === name).map((d) => d.value);
	// The home's location: the upgrade, nothing buffered, and the headers set again (a location that sets one inherits
	// none of the server's or the http block's).
	assert.deepEqual(at(HOME, "proxy_set_header"), [
		"Host 127.0.0.1",
		"X-Forwarded-For $remote_addr",
		"Upgrade $http_upgrade",
		'Connection "upgrade"',
	]);
	assert.deepEqual(at(HOME, "proxy_pass"), ["http://127.0.0.1:18789"]);
	assert.deepEqual(at(HOME, "proxy_buffering"), ["off"]);
	assert.deepEqual(at(HOME, "proxy_request_buffering"), ["off"]);
	// Each end sends a line every 20 s (CLOUD_HOME_CHANNEL_KEEPALIVE_MS): the timeouts take several of them.
	const keepAlive = Number(
		/CLOUD_HOME_CHANNEL_KEEPALIVE_MS = ([0-9_]+);/
			.exec(readFileSync(new URL("../packages/runtime/src/cloud-home-channel.ts", import.meta.url), "utf8"))?.[1]
			.replaceAll("_", ""),
	);
	assert.equal(keepAlive, 20000);
	for (const name of ["proxy_read_timeout", "proxy_send_timeout"]) {
		const [value] = at(HOME, name);
		assert.match(value, /^[0-9]+s$/);
		const seconds = Number.parseInt(value, 10);
		assert.ok(seconds * 1000 >= 3 * keepAlive && seconds <= 300, `${name} ${value}`);
	}
	// The route is the one the ingress serves the upgrade on, matched exactly.
	assert.match(
		readFileSync(new URL("../packages/runtime/src/cloud-home-channel.ts", import.meta.url), "utf8"),
		/export const CLOUD_HOME_CHANNEL_PATH = "\/v1\/home-session";/,
	);
	// Everything else as the node had it: Connection close, 60 s, buffered requests, no Upgrade anywhere but the home's.
	assert.deepEqual(at(REST, "proxy_pass"), ["http://127.0.0.1:18789"]);
	assert.deepEqual(at(REST, "proxy_set_header"), []);
	assert.deepEqual(at("http", "proxy_set_header"), ["Host 127.0.0.1", "Connection close", "X-Forwarded-For $remote_addr"]);
	assert.deepEqual(at("http", "proxy_read_timeout"), ["60s"]);
	assert.deepEqual(at("http", "proxy_send_timeout"), ["60s"]);
	assert.deepEqual(at("http", "proxy_http_version"), ["1.1"]);
	assert.deepEqual(at("http", "proxy_request_buffering"), ["on"]);
	assert.deepEqual(at("http", "client_max_body_size"), ["256k"]);
	assert.deepEqual(at("http > server", "listen"), ["10.41.0.1:8789 ssl"]);
	assert.deepEqual(
		directives.filter((d) => /\bUpgrade\b|"upgrade"/.test(d.value)).map((d) => d.block),
		[HOME, HOME],
	);
	assert.deepEqual(
		[...new Set(directives.filter((d) => d.block.includes("location")).map((d) => d.block))],
		[HOME, REST],
	);
});

test("every value must be given, and a one-word value cannot open or close a block", () => {
	for (const name of Object.keys(values)) {
		const missing = { ...values };
		delete missing[name];
		assert.throws(() => renderCodingGatewayNginx(missing), new RegExp(`missing value ${name}`));
	}
	assert.throws(() => renderCodingGatewayNginx({ ...values, TLS_CERTIFICATE: "/x; } location /y {" }), /brace/);
	assert.throws(() => renderCodingGatewayNginx({ ...values, X_FORWARDED_FOR: "$remote_addr;\nproxy_buffering off" }), /one word/);
	assert.throws(() => renderCodingGatewayNginx({ ...values, HTTP: "server { listen 80; }" }), /opens a block/);
	assert.throws(() => renderCodingGatewayNginx({ ...values, EXTRA: "x" }), /unknown value EXTRA/);
	assert.doesNotMatch(renderCodingGatewayNginx(values), /@[A-Z_]+@/);
});
