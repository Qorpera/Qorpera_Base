import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
	FOUNDING_MODEL_ADDRESS,
	FOUNDING_MODEL_TOKEN,
	foundingNativeDnsResponse,
	startFoundingNativeModel,
} from "./founding-native-model.mjs";

function query(name, type = 1) {
	const labels = name.split(".").flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
	const head = Buffer.alloc(12);
	head.writeUInt16BE(321, 0);
	head.writeUInt16BE(0x100, 2);
	head.writeUInt16BE(1, 4);
	const tail = Buffer.alloc(5);
	tail.writeUInt16BE(type, 1);
	tail.writeUInt16BE(1, 3);
	return Buffer.concat([head, ...labels, tail]);
}

test("fixture DNS resolves only exact native subscription hosts and never recurses", () => {
	for (const name of ["chatgpt.com", "auth.openai.com"]) {
		const answer = foundingNativeDnsResponse(query(name));
		assert.equal(answer.readUInt16BE(6), 1);
		assert.equal([...answer.subarray(-4)].join("."), FOUNDING_MODEL_ADDRESS);
		assert.equal(answer.readUInt16BE(2) & 0x80, 0);
	}
	assert.equal(foundingNativeDnsResponse(query("api.openai.com")).readUInt16BE(2) & 0xf, 3);
	assert.equal(foundingNativeDnsResponse(query("chatgpt.com", 28)).readUInt16BE(6), 0);
	const compressed = query("chatgpt.com");
	compressed[12] = 0xc0;
	assert.throws(() => foundingNativeDnsResponse(compressed));
	assert.throws(() => foundingNativeDnsResponse(Buffer.concat([query("chatgpt.com"), Buffer.from([0])])));
});

test("real local TLS and UDP fixture requires synthetic credential plus exact founding context", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-founding-model-"));
	const receiptId = randomUUID(),
		observations = [];
	let server;
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
				join(root, "key.pem"),
				"-out",
				join(root, "cert.pem"),
				"-subj",
				"/CN=chatgpt.com",
				"-addext",
				"subjectAltName=DNS:chatgpt.com,DNS:auth.openai.com",
			],
			{ timeout: 15000, maxBuffer: 8192 },
		);
		const cert = await readFile(join(root, "cert.pem"));
		server = await startFoundingNativeModel({
			host: "127.0.0.1",
			key: await readFile(join(root, "key.pem")),
			cert,
			receiptId,
			onObservation: (observation) => observations.push(observation),
		});
		const resolver = new Resolver({ timeout: 1000, tries: 1 });
		resolver.setServers([`127.0.0.1:${server.dnsPort}`]);
		assert.deepEqual(await resolver.resolve4("chatgpt.com"), [FOUNDING_MODEL_ADDRESS]);
		const socket = createSocket("udp4");
		try {
			const reply = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Fixture DNS timed out")), 3000);
				socket.once("message", (bytes) => {
					clearTimeout(timer);
					resolve(bytes);
				});
			});
			socket.send(query("chatgpt.com"), server.dnsPort, "127.0.0.1");
			assert.equal([...(await reply).subarray(-4)].join("."), FOUNDING_MODEL_ADDRESS);
		} finally {
			socket.close();
		}
		const send = (token, input, servername = "chatgpt.com") =>
			new Promise((resolve, reject) => {
				const req = request(
					{
						hostname: "127.0.0.1",
						port: server.tlsPort,
						servername,
						ca: cert,
						method: "POST",
						path: "/backend-api/codex/responses",
						headers: { host: servername, authorization: `Bearer ${token}`, "content-encoding": "zstd" },
						timeout: 3000,
					},
					(response) => {
						let body = "";
						response.on("data", (bytes) => {
							body += bytes;
						});
						response.once("end", () => resolve({ status: response.statusCode, body }));
					},
				);
				req.once("error", reject);
				req.once("timeout", () => req.destroy(new Error("Fixture TLS timed out")));
				req.end(
					zstdCompressSync(
						Buffer.from(
							JSON.stringify({
								model: "offline-probe",
								input,
								tools: [{ type: "namespace", name: "qorpera", tools: [{ name: "send_message" }] }],
							}),
						),
					),
				);
			});
		assert.equal((await send("not-the-synthetic-token", receiptId)).status, 403);
		const fallback = await new Promise((resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					port: server.tlsPort,
					servername: "chatgpt.com",
					ca: cert,
					path: "/backend-api/codex/responses",
					headers: {
						host: "chatgpt.com",
						authorization: `Bearer ${FOUNDING_MODEL_TOKEN}`,
						connection: "Upgrade",
						upgrade: "websocket",
						"sec-websocket-version": "13",
						"sec-websocket-key": "MTIzNDU2Nzg5MDEyMzQ1Ng==",
					},
				},
				(response) => {
					response.resume();
					response.once("end", () => resolve(response.statusCode));
				},
			);
			req.once("error", reject);
			req.end();
		});
		assert.equal(fallback, 426, "Pinned Codex's supported HTTP fallback must remain available");
		assert.equal((await send(FOUNDING_MODEL_TOKEN, "different company")).status, 403);
		const result = await send(FOUNDING_MODEL_TOKEN, `Company founding receipt ${receiptId}`);
		assert.equal(result.status, 200);
		assert(result.body.includes("response.completed"));
		assert(result.body.includes('"namespace":"qorpera","name":"send_message"'));
		assert.equal((await send(FOUNDING_MODEL_TOKEN, receiptId)).status, 403);
		assert.equal(observations.filter((value) => value.kind === "scripted_model_completion").length, 1);
		assert(!JSON.stringify(observations).includes(FOUNDING_MODEL_TOKEN));
	} finally {
		await server?.close();
		await rm(root, { recursive: true });
	}
});
