import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { foundingOptions } from "./founding-native.mjs";
import { bootstrapCompanySql, computerPlansSql, modelAccountsSql, runtimeEvidenceSql, sqlUuid } from "./founding-fixtures.mjs";
import { platformBootstrapParts, startFoundingGateway, startFoundingMail } from "./founding-services.mjs";

test("founding runner cannot attach an existing remote service or database", () => {
	assert.deepEqual(foundingOptions(["--bin", "/usr/lib/postgresql/17/bin", "--tools", "/tmp/tools", "--out", "/tmp/results"]),
		{ binDirectory: "/usr/lib/postgresql/17/bin", tools: "/tmp/tools", out: "/tmp/results" });
	for (const args of [["--database", "postgres://production"], ["--out", "/tmp/../private"], ["--bin", "/"],
		["--tools", "/tmp/a", "--tools", "/tmp/b"], ["--out", "/tmp/a b"]]) assert.throws(() => foundingOptions(args));
});

test("real Auth bootstrap excludes only the stub users and tolerates Auth-owned functions", async () => {
	const sql = await readFile(new URL("../../supabase/tests/bootstrap.sql", import.meta.url), "utf8");
	const [before, after] = platformBootstrapParts(sql);
	assert(before.includes("create schema auth;"));
	assert(before.includes("create role authenticated nologin;"));
	assert(!`${before}${after}`.includes("create table auth.users"));
	assert(after.includes("create or replace function auth.uid()"));
	assert(after.includes("create table storage.objects"));
	assert(after.includes("alter default privileges in schema public grant all on tables"));
	assert.throws(() => platformBootstrapParts("create table changed;"));
});

test("bootstrap and model fixtures preserve real publication and member identity boundaries", async () => {
	const id = "f0000000-0000-4000-8000-000000000001";
	const sql = await bootstrapCompanySql(id);
	assert(sql.includes("qorpera_claim_company_bootstrap"));
	assert(sql.includes("qorpera_verify_company_path_tree"));
	assert(sql.includes("qorpera_finalize_company_bootstrap"));
	assert(!sql.includes("qorpera_create_cloud_company"));
	assert(!sql.includes("insert into auth.users"));
	assert(modelAccountsSql(id, [id]).includes("qorpera_create_member_execution_sponsor"));
	const plans = computerPlansSql([id, "f0000000-0000-4000-8000-000000000002"]);
	assert(plans.includes("qorpera_finish_computer_billing_sync"));
	assert(!plans.includes("complimentary"));
	assert(!plans.includes("insert into public.qorpera_computer_allowance_buckets"));
	assert(runtimeEvidenceSql(id).includes("qorpera_materialize_session_turn_requests"));
	assert.throws(() => sqlUuid("' or true;--"));
});

test("private SMTP accepts only owned test addresses and captures an Auth-generated OTP", async () => {
	const mail = await startFoundingMail();
	const socket = connect(mail.port, "127.0.0.1");
	let buffer = "", response;
	const line = () => new Promise(done => { response = done; drain(); });
	const drain = () => { const end = buffer.indexOf("\r\n"); if (response && end >= 0) { const done = response; response = undefined; const value = buffer.slice(0, end); buffer = buffer.slice(end + 2); done(value); } };
	// drain is called only after its declaration has initialized.
	socket.on("data", chunk => { buffer += chunk.toString(); drain(); });
	try {
		assert.match(await line(), /^220/);
		for (const [command, code] of [["EHLO localhost", "250"], ["MAIL FROM:<auth@founding.example.test>", "250"],
			["RCPT TO:<someone@example.com>", "550"], ["RCPT TO:<founder-a@founding.example.test>", "250"], ["DATA", "354"]]) {
			socket.write(`${command}\r\n`); assert((await line()).startsWith(code));
		}
		socket.write("Subject: OTP\r\n\r\n<p>12345678</p>\r\n.\r\n"); assert.match(await line(), /^250/);
		assert.equal(await mail.code("founder-a@founding.example.test"), "12345678");
		const template = await fetch(mail.templateUrl); assert((await template.text()).includes("{{ .Token }}"));
		assert.deepEqual(mail.diagnostics(), { connections: 1, acceptedRecipients: 1, rejectedRecipients: 1, dataMessages: 1, codesCaptured: 1, templateRequests: 1 });
		assert(!JSON.stringify(mail.diagnostics()).includes("12345678"));
	} finally { socket.destroy(); await mail.close(); }
});

test("optional billing transport preserves exact signatures and bearer without granting another function route", async () => {
	const root = await mkdtemp(join(tmpdir(), "founding-billing-transport-"));
	let gateway;
	try {
		const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
			"-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")], { encoding: "utf8" });
		assert.equal(generated.status, 0);
		const cert = await readFile(join(root, "cert.pem"));
		gateway = await startFoundingGateway({ cert, key: await readFile(join(root, "key.pem")), publicKey: "test-public", webRoot: root });
		const body = '{ "signed" : "unaltered\\nbytes" }';
		const call = path => new Promise((resolve, reject) => {
			const req = request(`${gateway.origin}${path}`, { method: "POST", ca: cert,
				headers: { authorization: "Bearer actual-session-forwarded", "stripe-signature": "original-signature", "content-type": "application/json" } }, response => {
				response.resume(); response.on("end", () => resolve(response.statusCode));
			});
			req.once("error", reject); req.end(body);
		});
		assert.equal(await call("/functions/v1/computer-billing/checkout"), 503);
		const observed = [];
		gateway.upstream.computerBilling = async value => {
			observed.push({ url: value.url, bearer: value.headers.get("authorization"), signature: value.headers.get("stripe-signature"), body: await value.text() });
			return Response.json({ refused: true }, { status: 401 });
		};
		assert.equal(await call("/functions/v1/computer-billing/checkout"), 401);
		assert.equal(await call("/functions/v1/computer-billing/webhook"), 401);
		assert.equal(await call("/functions/v1/computer-billing/secret-admin"), 503);
		assert.equal(await call("/functions/v1/other/checkout"), 503);
		assert.equal(observed.length, 2);
		for (const value of observed) {
			assert.equal(value.bearer, "Bearer actual-session-forwarded"); assert.equal(value.signature, "original-signature");
			assert.equal(value.body, body); assert(value.url.startsWith(gateway.origin));
		}
	} finally { await gateway?.close(); await rm(root, { recursive: true }); }
});
