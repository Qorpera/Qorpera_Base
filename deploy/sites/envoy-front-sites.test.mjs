/* The front door's sites block (envoy-front-sites.yaml) in a real Envoy: api-front's own image and listener settings
 * (the dbhome kit's front/envoy-front.yaml, 3 Nov 2026) with this block and the app_relay cluster
 * (envoy-front-app-relay-cluster.yaml), in front of a model of the gateway (api-gw, upstream self-hosted v0.8.3:
 * x-forwarded-host set to the request's authority only when absent, /functions/v1/ rewritten to /) and an echo server
 * standing in for the functions runtime and for the app relay. It shows what reaches a function or the relay for each
 * Host and x-forwarded-host a visitor can send. It never pulls. It runs where Docker holds the image, and must run on a
 * node test machine whose setup pulled it (guest-setup.sh names it in /etc/qorpera-test-machine-versions): there a
 * missing image fails the run. Elsewhere (a Mac, a machine set up before that) it is skipped, saying why. */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const BLOCK = readFileSync(new URL("./envoy-front-sites.yaml", import.meta.url), "utf8");
const CLUSTER = readFileSync(new URL("./envoy-front-app-relay-cluster.yaml", import.meta.url), "utf8");
// api-front's image (docker-compose.dbhome-front.yml), by its digest only.
const IMAGE = "envoyproxy/envoy:v1.39.1@sha256:57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4";
// What deploy/test-machine/guest-setup.sh writes last on a node test machine.
const TEST_MACHINE = "/etc/qorpera-test-machine-versions";
const SITES = "sites.qorpera.com";
const API = "api.qorpera.com";
const APP = "shop-preview.qorpera.com";

/** The block as front-sites.py puts it in: from `virtual_hosts:` on, its comment header dropped. */
function virtualHosts() {
	const lines = BLOCK.split("\n");
	const start = lines.indexOf(`${" ".repeat(18)}virtual_hosts:`);
	assert.ok(start > 0, "the block's virtual_hosts line at 18 spaces");
	assert.ok(
		lines.slice(0, start).every((line) => line.startsWith("#") || !line.trim()),
		"only comments before it",
	);
	return lines.slice(start).join("\n").trimEnd();
}

/** One virtual host's lines, from its `- name:` to the next one's (or the comment before it). */
function virtualHost(name) {
	const lines = virtualHosts().split("\n");
	const start = lines.indexOf(`${" ".repeat(20)}- name: ${name}`);
	assert.ok(start > 0, name);
	const end = lines.findIndex(
		(line, index) =>
			index > start && (line.startsWith(`${" ".repeat(20)}- name: `) || line.startsWith(`${" ".repeat(20)}#`)),
	);
	return lines.slice(start, end === -1 ? undefined : end);
}

/** The two lines the block's header names for the `front` listener's connection manager (16 spaces). */
function stripLines() {
	return BLOCK.split("\n")
		.filter((line) => /^# {16}strip_/.test(line))
		.map((line) => line.slice(1));
}

/** The app relay's cluster as it goes under the kit's `clusters:`: its comment header dropped. */
function appRelayCluster() {
	const lines = CLUSTER.split("\n");
	const start = lines.indexOf(`${" ".repeat(4)}- name: app_relay`);
	assert.ok(start > 0, "the cluster's name line at 4 spaces");
	assert.ok(
		lines.slice(0, start).every((line) => line.startsWith("#") || !line.trim()),
		"only comments before it",
	);
	assert.ok(
		lines.slice(start).every((line) => !line.trim() || line.startsWith(" ".repeat(4))),
		"every line inside the clusters list",
	);
	return lines.slice(start).join("\n").trimEnd();
}

describe("envoy-front-sites.yaml: what the file says", () => {
	it("overwrites x-forwarded-host with the sites host on the sites name", () => {
		const sites = virtualHost("sites").join("\n");
		assert.match(sites, /domains: \["sites\.qorpera\.com"\]/);
		assert.match(
			sites,
			/- header: \{ key: x-forwarded-host, value: sites\.qorpera\.com \}\n\s+append_action: OVERWRITE_IF_EXISTS_OR_ADD/,
		);
		assert.match(sites, /prefix_rewrite: \/functions\/v1\/site-serve\/ \}/);
	});

	it("drops a visitor's x-forwarded-host on the api name and sets the Host it was asked for", () => {
		const api = virtualHost("api").join("\n");
		assert.match(api, /domains: \["api\.qorpera\.com", "\*"\]/);
		assert.match(api, /request_headers_to_remove: \[x-forwarded-host\]/);
		assert.match(
			api,
			/- header: \{ key: x-forwarded-host, value: "%REQ\(:AUTHORITY\)%" \}\n\s+append_action: OVERWRITE_IF_EXISTS_OR_ADD/,
		);
	});

	it("answers 404 for site-serve on the api name before its functions route", () => {
		const routes = virtualHost("api").filter((line) => line.trimStart().startsWith("- { match:"));
		const block = routes.findIndex((line) =>
			line.includes(
				"{ match: { prefix: /functions/v1/site-serve, case_sensitive: false }, direct_response: { status: 404 } }",
			),
		);
		const functions = routes.findIndex((line) => line.includes("{ match: { prefix: /functions/v1/ }, route:"));
		assert.ok(block >= 0 && functions > block, "the site-serve 404 comes first");
	});

	it("sends every path of an app host to the relay, WebSocket upgrades on, with the request's own name", () => {
		const apps = virtualHost("apps").join("\n");
		assert.match(apps, /domains: \["\*-preview\.qorpera\.com"\]/);
		assert.match(apps, /request_headers_to_remove: \[x-forwarded-host\]/);
		assert.match(
			apps,
			/- header: \{ key: x-forwarded-host, value: "%REQ\(:AUTHORITY\)%" \}\n\s+append_action: OVERWRITE_IF_EXISTS_OR_ADD/,
		);
		const routes = virtualHost("apps").filter((line) => line.trimStart().startsWith("- { match:"));
		assert.deepEqual(
			routes.map((line) => line.trim()),
			[
				"- { match: { prefix: / }, route: { cluster: app_relay, timeout: 0s, upgrade_configs: [{ upgrade_type: websocket }] } }",
			],
		);
	});

	it("answers 404 for every other name under qorpera.com, so none reaches the API", () => {
		const others = virtualHost("others");
		assert.match(others.join("\n"), /domains: \["\*\.qorpera\.com"\]/);
		assert.deepEqual(
			others.filter((line) => line.trimStart().startsWith("- { match:")).map((line) => line.trim()),
			["- { match: { prefix: / }, direct_response: { status: 404 } }"],
		);
		// Each name in exactly one virtual host (Envoy refuses a name twice).
		const domains = [...virtualHosts().matchAll(/domains: \[(.*)\]/g)].flatMap((match) =>
			JSON.parse(`[${match[1]}]`),
		);
		assert.deepEqual(domains, [
			"sites.qorpera.com",
			"*-preview.qorpera.com",
			"*.qorpera.com",
			"api.qorpera.com",
			"*",
		]);
	});

	it("names the connection manager's two lines that drop a Host's port and trailing dot", () => {
		assert.deepEqual(stripLines(), [
			`${" ".repeat(16)}strip_any_host_port: true`,
			`${" ".repeat(16)}strip_trailing_host_dot: true`,
		]);
		assert.match(BLOCK, /right after `use_remote_address: false`/);
	});

	it("has the app_relay cluster the apps host routes to, as the kit's clusters list takes it", () => {
		const cluster = appRelayCluster();
		assert.match(cluster, /^ {4}- name: app_relay\n {6}type: STRICT_DNS\n {6}connect_timeout: 5s\n/);
		assert.match(cluster, /cluster_name: app_relay\n/);
		assert.match(cluster, /socket_address: \{ address: app-relay, port_value: 8090 \}$/);
		// Envoy drops an idle connection to the relay before the relay does (its keep-alive is 75 s).
		assert.match(cluster, /common_http_protocol_options: \{ idle_timeout: 60s \}/);
		const relay = readFileSync(new URL("./app-relay/relay.mjs", import.meta.url), "utf8");
		assert.match(relay, /server\.keepAliveTimeout = 75_000;/);
		// Every cluster the block routes to: the kit's api_gw and this one.
		const clusters = new Set([...virtualHosts().matchAll(/cluster: ([a-z_]+)/g)].map((match) => match[1]));
		assert.deepEqual([...clusters].sort(), ["api_gw", "app_relay"]);
	});
});

// --- In a real Envoy ---------------------------------------------------------------------------------------------------

function heldImage() {
	return spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { stdio: "ignore" }).status === 0;
}

/** A node test machine whose setup pulled the image: its versions file names it. */
function imageRequired() {
	try {
		return /^envoy_test_image=/m.test(readFileSync(TEST_MACHINE, "utf8"));
	} catch {
		return false;
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** api-front's listener as the kit's front/envoy-front.yaml has it, with this block, beside a model of the gateway. */
function config(frontPort, gatewayPort, echoPort) {
	const cluster = (name, port) => `    - name: ${name}
      type: STATIC
      connect_timeout: 5s
      load_assignment:
        cluster_name: ${name}
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: 127.0.0.1, port_value: ${port} }`;
	return `static_resources:
  listeners:
    - name: front
      address:
        socket_address: { address: 127.0.0.1, port_value: ${frontPort} }
      per_connection_buffer_limit_bytes: 32768
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: front
                normalize_path: true
                merge_slashes: true
                path_with_escaped_slashes_action: REJECT_REQUEST
                use_remote_address: false
${stripLines().join("\n")}
                upgrade_configs:
                  - upgrade_type: websocket
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                route_config:
                  name: front
${virtualHosts()}
    - name: gateway
      address:
        socket_address: { address: 127.0.0.1, port_value: ${gatewayPort} }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: gateway
                normalize_path: true
                merge_slashes: true
                path_with_escaped_slashes_action: REJECT_REQUEST
                use_remote_address: true
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                route_config:
                  name: gateway
                  virtual_hosts:
                    - name: supabase_host
                      domains: ["*"]
                      request_headers_to_add:
                        - header: { key: X-Forwarded-Host, value: "%REQ(:AUTHORITY)%" }
                          append_action: ADD_IF_ABSENT
                        # The test's own: the x-forwarded-host the front sent, before this gateway's (formatters read
                        # the headers as they came).
                        - header: { key: x-front-forwarded-host, value: "%REQ(X-FORWARDED-HOST)%" }
                          append_action: OVERWRITE_IF_EXISTS_OR_ADD
                      routes:
                        - { match: { prefix: /functions/v1/ }, route: { cluster: functions, prefix_rewrite: / } }
                        - { match: { prefix: / }, route: { cluster: functions } }
  clusters:
${cluster("api_gw", gatewayPort)}
${cluster("functions", echoPort)}
${relayCluster(echoPort)}
`;
}

/** The app_relay cluster file exactly, its address the echo server here (the relay stands in as the echo). */
function relayCluster(port) {
	const cluster = appRelayCluster();
	const local = cluster.replace(
		"socket_address: { address: app-relay, port_value: 8090 }",
		`socket_address: { address: 127.0.0.1, port_value: ${port} }`,
	);
	assert.notEqual(local, cluster);
	return local;
}

/** One raw HTTP/1.1 request, exactly as written (the Host and every header as given), to the front. The answer ends at
 * its Content-Length (Envoy's own answers wait a second for the client to close first), else at the close. An upgrade
 * sends its own Connection header. */
function raw(port, path, headers, { upgrade = false } = {}) {
	const text = `GET ${path} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}${upgrade ? "" : "Connection: close\r\n"}\r\n`;
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let answer = Buffer.alloc(0);
		const done = () => {
			const whole = answer.toString("utf8");
			const end = whole.indexOf("\r\n\r\n");
			const head = end === -1 ? whole : whole.slice(0, end);
			resolve({ status: Number(head.split(" ")[1]), head, body: end === -1 ? "" : whole.slice(end + 4) });
			socket.destroy();
		};
		socket.setTimeout(10_000, () => socket.destroy(new Error("timeout")));
		socket.on("data", (chunk) => {
			answer = Buffer.concat([answer, chunk]);
			const end = answer.indexOf("\r\n\r\n");
			const length = /\r\ncontent-length: *(\d+)\r\n/i.exec(answer.subarray(0, end + 2).toString("latin1"))?.[1];
			if (end !== -1 && length !== undefined && answer.byteLength - end - 4 >= Number(length)) done();
		});
		socket.on("error", reject);
		socket.on("end", done);
		socket.write(text);
	});
}

const held = heldImage();
const required = imageRequired();

describe(
	"envoy-front-sites.yaml: in api-front's Envoy",
	{
		skip:
			held || required
				? false
				: `Docker here does not hold ${IMAGE.split("@")[0]} at its digest, and ${TEST_MACHINE} does not name it`,
	},
	() => {
		let dir;
		let echo;
		let envoy;
		let front;
		const name = `qorpera-front-sites-test-${process.pid}-${Date.now()}`;
		/** What the functions runtime received for one request: its path, every x-forwarded-host and cf-connecting-ip, and
		 * the x-forwarded-host the front itself sent on. */
		const seen = (answer) => {
			assert.equal(answer.status, 200, answer.body);
			return JSON.parse(answer.body);
		};

		before(async () => {
			assert.ok(
				held,
				`${TEST_MACHINE} names the Envoy image but Docker does not hold ${IMAGE}: run guest-setup.sh again`,
			);
			echo = createServer((request, response) => {
				// Every copy of a header as it arrived (Node would join repeated ones).
				const values = (header) => {
					const found = [];
					for (let index = 0; index < request.rawHeaders.length; index += 2)
						if (request.rawHeaders[index].toLowerCase() === header) found.push(request.rawHeaders[index + 1]);
					return found;
				};
				const body = Buffer.from(
					JSON.stringify({
						path: request.url,
						forwardedHost: values("x-forwarded-host"),
						fromFront: values("x-front-forwarded-host"),
						client: values("cf-connecting-ip"),
					}),
				);
				response.writeHead(200, { "content-type": "application/json", "content-length": String(body.byteLength) });
				response.end(body);
			});
			// The app relay's side of a WebSocket handshake: what it was asked for, in the 101's headers.
			echo.on("upgrade", (request, socket) => {
				const accept = createHash("sha1")
					.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
					.digest("base64");
				socket.end(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
						`X-Seen-Path: ${request.url}\r\nX-Seen-Host: ${request.headers["x-forwarded-host"]}\r\n\r\n`,
				);
			});
			await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
			front = await freePort();
			const gateway = await freePort();
			dir = mkdtempSync(join(tmpdir(), "front-sites-"));
			writeFileSync(join(dir, "front.yaml"), config(front, gateway, echo.address().port), { mode: 0o644 });
			const user = `${process.getuid()}:${process.getgid()}`;
			envoy = spawn(
				"docker",
				[
					"run",
					"--rm",
					"--pull",
					"never",
					"--name",
					name,
					"--network",
					"host",
					"--user",
					user,
					"-v",
					`${dir}:/cfg:ro`,
					"--entrypoint",
					"envoy",
					IMAGE,
					"-c",
					"/cfg/front.yaml",
					"--disable-hot-restart",
					"--log-level",
					"warn",
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			let log = "";
			envoy.stderr.on("data", (chunk) => {
				log += chunk;
			});
			const deadline = Date.now() + 60_000;
			for (;;) {
				if (envoy.exitCode !== null) throw new Error(`Envoy refused the configuration:\n${log.slice(-2000)}`);
				try {
					if ((await raw(front, "/", [["Host", API]])).status === 404) break;
				} catch {
					// Not listening yet.
				}
				if (Date.now() > deadline) throw new Error(`Envoy did not start:\n${log.slice(-2000)}`);
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		});

		after(() => {
			spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
			envoy?.kill();
			echo?.close();
			if (dir) rmSync(dir, { recursive: true, force: true });
		});

		it("gives site-serve the sites host whatever a visitor sends, Cloudflare's client address unchanged", async () => {
			for (const host of [SITES, "SITES.Qorpera.COM"])
				for (const sent of [[], [API], [SITES, API], ["evil.example", "evil.example"]]) {
					const answer = await raw(front, "/shop/.qorpera/unlock", [
						["Host", host],
						...sent.map((value) => ["X-Forwarded-Host", value]),
						["CF-Connecting-IP", "203.0.113.9"],
					]);
					assert.deepEqual(
						seen(answer),
						{
							path: "/site-serve/shop/.qorpera/unlock",
							forwardedHost: [SITES],
							fromFront: [SITES],
							client: ["203.0.113.9"],
						},
						`${host} ${sent.join(",")}`,
					);
				}
		});

		it("gives the api name's routes its own Host, never a visitor's x-forwarded-host", async () => {
			for (const sent of [[], [SITES], [SITES, SITES], [`${SITES}, ${API}`]]) {
				for (const path of ["/rest/v1/", "/functions/v1/event-intake/x", "/storage/v1/object/x"]) {
					const answer = seen(
						await raw(front, path, [["Host", API], ...sent.map((value) => ["X-Forwarded-Host", value])]),
					);
					assert.deepEqual(answer.forwardedHost, [API], `${path} ${sent.join(",")}`);
					// Set by the front itself, not left to the gateway.
					assert.deepEqual(answer.fromFront, [API], `${path} ${sent.join(",")}`);
				}
			}
			// The api name with a port or a trailing dot is the api name, forwarded bare.
			for (const host of [`${API}:443`, `${API}:8443`, `${API}.`, "API.Qorpera.com:443"]) {
				const answer = seen(
					await raw(front, "/rest/v1/", [
						["Host", host],
						["X-Forwarded-Host", SITES],
					]),
				);
				assert.deepEqual(
					answer.forwardedHost.map((value) => value.toLowerCase()),
					[API],
					host,
				);
				assert.deepEqual(
					answer.fromFront.map((value) => value.toLowerCase()),
					[API],
					host,
				);
			}
		});

		it("never passes site-serve on the api name, however the path is spelled", async () => {
			for (const host of [API, `${API}:443`, `${API}.`])
				for (const path of [
					"/functions/v1/site-serve",
					"/functions/v1/site-serve/shop/",
					"/functions/v1/Site-Serve/shop/",
					"/functions/v1/SITE-SERVE",
					"/functions/v1/%73ite-serve/shop/",
					"/functions/v1/site-%73erve/shop/",
					"/functions/v1//site-serve/shop/",
					"/functions/v1/./site-serve/shop/",
					"/functions/v1/x/../site-serve/shop/",
					"/functions//v1/site-serve/shop/",
					"/functions/v1/site-serve%2Fshop/",
				]) {
					const answer = await raw(front, path, [
						["Host", host],
						["X-Forwarded-Host", SITES],
					]);
					if (answer.status === 200) {
						// Through to the runtime only under a name that is no function, and with this Host, never the sites host.
						const reached = JSON.parse(answer.body);
						assert.notEqual(reached.path.split("/")[1]?.toLowerCase(), "site-serve", `${host} ${path}`);
						assert.deepEqual(reached.forwardedHost, [API], `${host} ${path}`);
					} else assert.ok([400, 404].includes(answer.status), `${host} ${path}: ${answer.status}`);
				}
		});

		it("gives the app relay every path of an app host, with the request's own name, never a visitor's", async () => {
			for (const host of [APP, "SHOP-Preview.Qorpera.com", "saml-shop-preview.qorpera.com"])
				for (const sent of [[], [API], [SITES, API]])
					for (const path of [
						"/",
						"/a/b?c=1",
						"/rest/v1/",
						"/functions/v1/site-serve/shop/",
						"/.qorpera/unlock",
					]) {
						const answer = seen(
							await raw(front, path, [
								["Host", host],
								...sent.map((value) => ["X-Forwarded-Host", value]),
								["CF-Connecting-IP", "203.0.113.9"],
							]),
						);
						const label = `${host} ${path} ${sent.join(",")}`;
						// Straight to the relay: no rewrite, no gateway between.
						assert.equal(answer.path, path, label);
						assert.deepEqual(answer.fromFront, [], label);
						assert.deepEqual(
							answer.forwardedHost.map((value) => value.toLowerCase()),
							[host.toLowerCase()],
							label,
						);
						assert.deepEqual(answer.client, ["203.0.113.9"], label);
					}
		});

		it("passes a link program's WebSocket handshake to the relay", async () => {
			const answer = await raw(
				front,
				"/.qorpera/connect",
				[
					["Host", APP],
					["X-Forwarded-Host", API],
					["Upgrade", "websocket"],
					["Connection", "Upgrade"],
					["Sec-WebSocket-Version", "13"],
					["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
					["Authorization", "Bearer test-claim-0123456789"],
				],
				{ upgrade: true },
			);
			assert.equal(answer.status, 101, answer.head);
			assert.match(answer.head, /\r\nsec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
			assert.match(answer.head, /\r\nx-seen-path: \/\.qorpera\/connect(\r\n|$)/i);
			assert.match(answer.head, /\r\nx-seen-host: shop-preview\.qorpera\.com(\r\n|$)/i);
		});

		it("matches a Host with a port or a trailing dot by its bare name, and forwards that", async () => {
			for (const suffix of [":443", ":8443", "."]) {
				const sites = seen(await raw(front, "/shop/", [["Host", `${SITES}${suffix}`]]));
				assert.deepEqual(
					{ path: sites.path, forwardedHost: sites.forwardedHost },
					{ path: "/site-serve/shop/", forwardedHost: [SITES] },
					`${SITES}${suffix}`,
				);
				const app = seen(await raw(front, "/a", [["Host", `${APP}${suffix}`]]));
				assert.deepEqual(
					{ path: app.path, forwardedHost: app.forwardedHost },
					{ path: "/a", forwardedHost: [APP] },
					`${APP}${suffix}`,
				);
			}
		});

		it("answers 404 itself for every other name under qorpera.com, with a port or a trailing dot too", async () => {
			for (const host of [
				`x${SITES}`,
				"evil.qorpera.com",
				"-preview.qorpera.com",
				"a.b.qorpera.com",
				"EVIL.Qorpera.com",
				"evil.qorpera.com:8443",
				"evil.qorpera.com:443",
				"evil.qorpera.com.",
				`x${SITES}.`,
			])
				for (const path of ["/", "/rest/v1/", "/functions/v1/event-intake/x", "/.qorpera/health"]) {
					const answer = await raw(front, path, [
						["Host", host],
						["X-Forwarded-Host", API],
					]);
					assert.equal(answer.status, 404, `${host} ${path}`);
					assert.equal(answer.body, "", `${host} ${path}: Envoy's own answer, nothing reached`);
				}
		});
	},
);
