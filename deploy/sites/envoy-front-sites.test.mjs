/* The front door's sites block (envoy-front-sites.yaml) in a real Envoy: api-front's own image and listener settings
 * (the dbhome kit's front/envoy-front.yaml, 3 Nov 2026) with this block, in front of a model of the gateway (api-gw,
 * upstream self-hosted v0.8.3: x-forwarded-host set to the request's authority only when absent, /functions/v1/
 * rewritten to /) and an echo server standing in for the functions runtime. It shows what reaches a function for each
 * Host and x-forwarded-host a visitor can send. Runs where Docker holds the image (the node test machines); never
 * pulls. */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const BLOCK = readFileSync(new URL("./envoy-front-sites.yaml", import.meta.url), "utf8");
// api-front's image (docker-compose.dbhome-front.yml); the tag when the digest is not held locally.
const IMAGES = [
	"envoyproxy/envoy:v1.39.1@sha256:57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4",
	"envoyproxy/envoy:v1.39.1",
];
const SITES = "sites.qorpera.com";
const API = "api.qorpera.com";

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

/** One virtual host's lines, from its `- name:` to the next one's. */
function virtualHost(name) {
	const lines = virtualHosts().split("\n");
	const start = lines.indexOf(`${" ".repeat(20)}- name: ${name}`);
	assert.ok(start > 0, name);
	const end = lines.findIndex((line, index) => index > start && line.startsWith(`${" ".repeat(20)}- name: `));
	return lines.slice(start, end === -1 ? undefined : end);
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
		assert.match(api, /domains: \["\*"\]/);
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
});

// --- In a real Envoy ---------------------------------------------------------------------------------------------------

function heldImage() {
	for (const image of IMAGES) {
		const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { stdio: "ignore" });
		if (inspected.status === 0) return image;
	}
	return null;
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
`;
}

/** One raw HTTP/1.1 request, exactly as written (the Host and every header as given), to the front. The answer ends at
 * its Content-Length (Envoy's own answers wait a second for the client to close first), else at the close. */
function raw(port, path, headers) {
	const text = `GET ${path} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}Connection: close\r\n\r\n`;
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let answer = Buffer.alloc(0);
		const done = () => {
			const whole = answer.toString("utf8");
			const end = whole.indexOf("\r\n\r\n");
			const head = end === -1 ? whole : whole.slice(0, end);
			resolve({ status: Number(head.split(" ")[1]), body: end === -1 ? "" : whole.slice(end + 4) });
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

const image = heldImage();

describe(
	"envoy-front-sites.yaml: in api-front's Envoy",
	{ skip: image ? false : "no envoyproxy/envoy:v1.39.1 in Docker here" },
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
					image,
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
			// A Host that only looks like the sites host comes here: its own value, which site-serve refuses.
			for (const host of [`${SITES}:443`, `${SITES}.`, `x${SITES}`]) {
				const answer = seen(
					await raw(front, "/rest/v1/", [
						["Host", host],
						["X-Forwarded-Host", SITES],
					]),
				);
				assert.deepEqual(answer.forwardedHost, [host], host);
				assert.deepEqual(answer.fromFront, [host], host);
			}
		});

		it("never passes site-serve on the api name, however the path is spelled", async () => {
			for (const host of [API, `${SITES}:443`, `${SITES}.`])
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
						assert.deepEqual(reached.forwardedHost, [host], `${host} ${path}`);
					} else assert.ok([400, 404].includes(answer.status), `${host} ${path}: ${answer.status}`);
				}
		});
	},
);
