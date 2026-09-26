import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadOfficeRpcSignatures, OFFICE_PROVIDER_RPCS, startOfficeRpcServer } from "./office-rpc-server.mjs";

let root, tls;
const tokens = { guest: randomBytes(32).toString("base64url"), provider: randomBytes(32).toString("base64url") };
const method = "qorpera_check_runtime_office_startup";
const metadata = () => OFFICE_PROVIDER_RPCS.map((name) => ({ name, set: false, defaults: 1,
	args: [{ name: "p_startup", type: "jsonb" }, { name: "p_optional", type: "text" }] }));
before(async () => {
	root = await mkdtemp(join(tmpdir(), "office-rpc-tls-"));
	const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")], { encoding: "utf8" });
	assert.equal(generated.status, 0, "Test TLS certificate creation failed");
	tls = { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) };
});
after(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(t, use = async () => '{"state":"prepared"}') {
	const calls = [];
	const query = async (sql, options) => {
		if (sql.includes("from pg_catalog.pg_proc")) return JSON.stringify(metadata());
		calls.push({ sql, options }); return use(sql, options);
	};
	const server = await startOfficeRpcServer({ query, tls, tokens, listen: { host: "127.0.0.1", port: 0 } });
	t.after(() => server.close());
	return { server, calls };
}
function call(server, { path = `/rest/v1/rpc/${method}`, body = '{"p_startup":{}}', token = tokens.guest, apiKey = token, ca = tls.cert, headers = {}, method: verb = "POST" } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port: server.address.port, path, method: verb, ca,
			headers: { authorization: `Bearer ${token}`, apikey: apiKey, "content-type": "application/json", ...headers } }, (response) => {
			const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
			response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
		});
		req.once("error", reject); req.end(body);
	});
}

test("TLS RPC binds exact payload through stdin variables and executes the actual service role", async (t) => {
	const f = await fixture(t);
	const payload = { p_startup: { text: "'; rollback;\\! dangerous\n$tag$", secret: tokens.provider } };
	const result = await call(f.server, { body: JSON.stringify(payload) });
	assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { state: "prepared" });
	assert.equal(result.headers["cache-control"], "no-store");
	const { sql, options } = f.calls[0];
	assert.match(sql, /^\\set office_args ([A-Za-z0-9+/=]+)\nbegin;/);
	assert.deepEqual(JSON.parse(Buffer.from(sql.split("\n")[0].slice("\\set office_args ".length), "base64")), payload);
	assert(!sql.includes(tokens.provider)); assert(!sql.includes("dangerous"));
	assert.match(sql, /set local role service_role/); assert.match(sql, /request.jwt.claims='\{"role":"service_role"\}'/);
	assert.match(sql, /public.qorpera_check_runtime_office_startup\(p_startup =>/);
	assert(!sql.includes("p_optional"), "Omitted optional parameters must preserve SQL defaults");
	assert.equal(options.maxOutputBytes, 65537); assert.equal(options.timeoutMs, 2500);
});

test("authentication, guest/provider separation and exact RPC paths fail before SQL", async (t) => {
	const f = await fixture(t);
	for (const options of [
		{ token: randomBytes(32).toString("base64url") }, { apiKey: tokens.provider },
		{ path: "/rest/v1/rpc/qorpera_prepare_runtime_computer_permit" },
		{ path: "/rest/v1/rpc/qorpera_record_computer_guard_samples" },
		{ path: "/rest/v1/rpc/qorpera_observe_runtime_node_inventory" },
		{ path: "/rest/v1/rpc/qorpera_prepare_runtime_office_boot_successor" },
		{ path: "/rest/v1/rpc/qorpera_begin_runtime_office_reset" },
		{ path: "/rest/v1/rpc/qorpera_activate_runtime_office_reset_successor" },
		{ path: "/rest/v1/rpc/qorpera_enroll_office_package_provision" },
		{ path: "/rest/v1/rpc/qorpera_computer_billing_rpc", token: tokens.provider },
		{ path: `/rest/v1/rpc/${method}?override=true` }, { method: "GET" },
	]) assert([401, 403].includes((await call(f.server, options)).status));
	assert.equal(f.calls.length, 0);
	assert.equal((await call(f.server, { path: "/rest/v1/rpc/qorpera_prepare_runtime_computer_permit", token: tokens.provider })).status, 200);
	for (const name of ["qorpera_begin_runtime_office_reset", "qorpera_check_runtime_office_reset_phase", "qorpera_activate_runtime_office_reset_successor", "qorpera_enroll_office_package_provision", "qorpera_ack_office_package_provision"])
		assert.equal((await call(f.server, { path: `/rest/v1/rpc/${name}`, token: tokens.provider })).status, 200);
});

test("unknown arguments, malformed UTF8/JSON, compression and oversized requests never invoke SQL", async (t) => {
	const f = await fixture(t);
	for (const body of ['{"p_unexpected":1}', "{}", "[]", "null", "{", Buffer.from([0xff])]) assert.equal((await call(f.server, { body })).status, 400);
	assert.equal((await call(f.server, { headers: { "content-encoding": "gzip" } })).status, 415);
	assert.equal((await call(f.server, { body: JSON.stringify({ p_startup: "a".repeat(129 * 1024) }) })).status, 413);
	assert.equal(f.calls.length, 0);
});

test("SQL diagnostics and excessive responses are redacted", async (t) => {
	for (const use of [async () => { throw new Error(`SQL secret ${tokens.provider}`); }, async () => JSON.stringify("a".repeat(65536)), async () => "not-json"]) {
		const f = await fixture(t, use), result = await call(f.server);
		assert.equal(result.status, 503); assert.equal(result.body, '{"error":"RPC unavailable"}');
	}
});

test("an untrusted TLS certificate is rejected by the client", async (t) => {
	const f = await fixture(t);
	await assert.rejects(call(f.server, { ca: [] }));
	assert.equal(f.calls.length, 0);
});

test("missing, overloaded or unsupported production signatures fail server initialization", async () => {
	for (const rows of [metadata().slice(1), [...metadata(), metadata()[0]], metadata().map((row, index) => index ? row : { ...row, set: true }),
		metadata().map((row, index) => index ? row : { ...row, args: [{ name: "p_bad", type: "text);drop table users;--" }], defaults: 0 })]) {
		await assert.rejects(loadOfficeRpcSignatures(async () => JSON.stringify(rows)), /OFFICE_ACCEPTANCE_/);
	}
});

test("fixture tokens must be distinct and cryptographically sized", async () => {
	for (const invalid of [{ guest: "short", provider: tokens.provider }, { guest: tokens.guest, provider: tokens.guest }]) {
		await assert.rejects(startOfficeRpcServer({ query: async () => "[]", tls, tokens: invalid, listen: { host: "127.0.0.1", port: 0 } }), /INVALID_OFFICE_ACCEPTANCE_SERVER/);
	}
});

test("physical evidence captures authorized observations without surrounding credentials", async (t) => {
	const samples = [];
	let fail = false;
	const query = async (sql) => {
		if (sql.includes("from pg_catalog.pg_proc")) return JSON.stringify(metadata().map((row) => ({ ...row, defaults: 0, args: [{ name: "p_request", type: "jsonb" }, { name: "p_executor_secret", type: "text" }] })));
		if (fail) throw new Error("private SQL failure");
		return '{"state":"checkpointed"}';
	};
	const server = await startOfficeRpcServer({ query, tls, tokens, listen: { host: "127.0.0.1", port: 0 }, onSample: (value) => samples.push(value) });
	t.after(() => server.close());
	const sample = { observationId: "physical-observation", state: "running", hostUptimeMs: 1234 };
	const options = { token: tokens.provider, path: "/rest/v1/rpc/qorpera_checkpoint_runtime_computer_permit", body: JSON.stringify({ p_request: { permitId: "permit", sample, privateContext: "private" }, p_executor_secret: tokens.provider }) };
	assert.equal((await call(server, options)).status, 200);
	assert.deepEqual(samples, [{ method: "qorpera_checkpoint_runtime_computer_permit", permitId: "permit", sample }]);
	fail = true;
	assert.equal((await call(server, options)).status, 503);
	assert.deepEqual(samples, [{ method: "qorpera_checkpoint_runtime_computer_permit", permitId: "permit", sample }, { method: "qorpera_checkpoint_runtime_computer_permit", permitId: "permit", sample }], "Observed requests survive ambiguous SQL outcomes for later committed-row reconciliation");
});

test("durable usage batches retain only observations for committed-row reconciliation", async (t) => {
	const samples = [];
	let fail = false, calls = 0;
	const query = async (sql) => {
		if (sql.includes("from pg_catalog.pg_proc")) return JSON.stringify(metadata().map((row) => ({ ...row, defaults: 0, args: [{ name: "p_request", type: "jsonb" }, { name: "p_executor_secret", type: "text" }] })));
		calls++;
		if (fail) throw new Error("commit reply lost");
		return '{"sealed":false}';
	};
	const server = await startOfficeRpcServer({ query, tls, tokens, listen: { host: "127.0.0.1", port: 0 }, onSample: (value) => samples.push(value) });
	t.after(() => server.close());
	const captured = [{ observationId: "first", state: "running" }, { observationId: "second", state: "gap" }];
	const method = "qorpera_record_computer_guard_samples";
	const options = { token: tokens.provider, path: `/rest/v1/rpc/${method}`, body: JSON.stringify({
		p_request: { permitId: "permit", generation: 1, entries: captured.map((sample, i) => ({ sequence: i + 1, sha256: "digest", entryText: JSON.stringify({ sample, privateContext: "not retained" }) })) },
		p_executor_secret: tokens.provider,
	}) };
	assert.equal((await call(server, options)).status, 200);
	assert.deepEqual(samples, captured.map((sample) => ({ method, permitId: "permit", sample })));
	fail = true;
	assert.equal((await call(server, options)).status, 503);
	assert.equal(calls, 2);
	assert.deepEqual(samples.slice(2), samples.slice(0, 2));
	assert(!JSON.stringify(samples).includes("privateContext"));
	assert(!JSON.stringify(samples).includes(tokens.provider));
});
