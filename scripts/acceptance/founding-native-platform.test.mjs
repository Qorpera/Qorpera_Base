import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startFoundingNativePlatform } from "./founding-native-platform.mjs";

test("actual TLS guest gateway refuses financial authority and other capsules, preserving real execution responses", async () => {
	const root = await mkdtemp(join(tmpdir(), "founding-native-platform-"));
	let platform;
	try {
		await promisify(execFile)(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-keyout",
				join(root, "key"),
				"-out",
				join(root, "cert"),
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ timeout: 15000 },
		);
		const key = await readFile(join(root, "key")),
			cert = await readFile(join(root, "cert"));
		const guestKey = randomBytes(32).toString("base64url"),
			capsuleId = randomUUID(),
			calls = [];
		const stored = new Map([[`native-capsule/${capsuleId}`, Buffer.from("encrypted-capsule")]]);
		platform = await startFoundingNativePlatform({
			host: "127.0.0.1",
			key,
			cert,
			guestKey,
			publicKey: "public",
			serviceJwt: "host-private-service",
			restPort: 43210,
			capsuleId,
			capsules: {
				get: async (id) => stored.get(id),
				put: async (id, bytes) => {
					stored.set(id, bytes);
				},
			},
			nativeObjects: (_req, res) => res.writeHead(403).end(),
			edges: {
				"runner-control": {
					handler: async (req) => {
						assert.equal(req.headers.get("authorization"), "Bearer actual-runner-capability");
						return new Response('{"edge":"actual-handler"}', { status: 409 });
					},
				},
			},
			transport: async (url, init) => {
				calls.push({ url, init });
				return new Response('{"code":"actual-authority-denied"}', { status: 403 });
			},
		});
		const send = (path, apikey = guestKey, method = "POST", body = "{}", headers = {}) =>
			new Promise((resolve, reject) => {
				const req = request(
					`${platform.origin}${path}`,
					{ ca: cert, method, headers: { apikey, ...headers } },
					(res) => {
						const chunks = [];
						res.on("data", (bytes) => chunks.push(bytes));
						res.once("end", () =>
							resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
						);
					},
				);
				req.once("error", reject);
				req.end(method === "GET" ? undefined : body);
			});
		for (const method of [
			"qorpera_prepare_runtime_computer_permit",
			"qorpera_computer_billing_rpc",
			"qorpera_set_account_entitlement",
			"qorpera_begin_company_founding",
		]) {
			assert.equal((await send(`/rest/v1/rpc/${method}`)).status, 403);
		}
		assert.equal((await send("/rest/v1/rpc/qorpera_describe_company_run_context", "wrong")).status, 403);
		assert.equal(calls.length, 0);
		assert.deepEqual(await send("/rest/v1/rpc/qorpera_describe_company_run_context"), {
			status: 403,
			body: '{"code":"actual-authority-denied"}',
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "http://127.0.0.1:43210/rpc/qorpera_describe_company_run_context");
		assert.equal(calls[0].init.headers.authorization, "Bearer host-private-service");
		assert.equal(
			(
				await send(
					`/storage/v1/object/qorpera-native-compute-capsules/${randomUUID()}.capsule`,
					guestKey,
					"GET",
				)
			).status,
			403,
		);
		assert.equal(
			(await send(`/storage/v1/object/qorpera-native-compute-capsules/${capsuleId}.capsule`, guestKey, "GET"))
				.body,
			"encrypted-capsule",
		);
		assert.equal((await send("/functions/v1/runner-control", guestKey)).status, 403);
		assert.deepEqual(
			await send("/functions/v1/runner-control", "public", "POST", "{}", {
				authorization: "Bearer actual-runner-capability",
			}),
			{ status: 409, body: '{"edge":"actual-handler"}' },
		);
	} finally {
		await platform?.close();
		await rm(root, { recursive: true });
	}
});
