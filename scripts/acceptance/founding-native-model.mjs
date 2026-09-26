import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:https";
import { isIPv4 } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import {
	NATIVE_CODEX_EGRESS_HOSTS,
	nativeEgressPublicAddress,
} from "../../packages/runtime/src/cloud-native-egress.ts";
import { assertFoundingSyntheticToken, foundingNativeSyntheticAuth } from "./founding-native-accounts.mjs";

// This destination is never dialed externally. The isolated Linux host must
// DNAT it to the local TLS server and DROP all other forwarded guest packets
// before the guest starts. It deliberately passes the real relay's public-IP
// predicate; the relay, native binary and namespace are not patched.
export const FOUNDING_MODEL_ADDRESS = "93.184.215.14";
export const FOUNDING_MODEL_TOKEN = foundingNativeSyntheticAuth("11111111-1111-4111-8111-111111111111").tokens
	.access_token;

/** Minimal authoritative fixture DNS. No recursive resolver, forwarding,
 * compression, arbitrary name or destination is supported. */
export function foundingNativeDnsResponse(bytes) {
	assert(Buffer.isBuffer(bytes) && bytes.length >= 17 && bytes.length <= 512);
	assert.equal(bytes.readUInt16BE(2) & 0xfef0, 0, "Only ordinary DNS queries accepted");
	assert.equal(bytes.readUInt16BE(4), 1);
	assert.equal(bytes.readUInt16BE(6) + bytes.readUInt16BE(8) + bytes.readUInt16BE(10), 0);
	let offset = 12;
	const labels = [];
	while (bytes[offset] !== 0) {
		const length = bytes[offset++];
		assert(length > 0 && length <= 63 && offset + length < bytes.length);
		const label = bytes.subarray(offset, offset + length).toString("ascii");
		assert(/^[a-zA-Z0-9-]+$/.test(label));
		labels.push(label.toLowerCase());
		offset += length;
	}
	offset++;
	assert.equal(offset + 4, bytes.length);
	const type = bytes.readUInt16BE(offset),
		klass = bytes.readUInt16BE(offset + 2);
	const known = NATIVE_CODEX_EGRESS_HOSTS.includes(labels.join("."));
	const answer = known && type === 1 && klass === 1;
	const header = Buffer.alloc(12);
	header.writeUInt16BE(bytes.readUInt16BE(0), 0);
	header.writeUInt16BE(0x8400 | (bytes.readUInt16BE(2) & 0x0100) | (known ? 0 : 3), 2);
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(answer ? 1 : 0, 6);
	const record = Buffer.alloc(answer ? 16 : 0);
	if (answer) {
		record.writeUInt16BE(0xc00c, 0);
		record.writeUInt16BE(1, 2);
		record.writeUInt16BE(1, 4);
		record.writeUInt32BE(1, 6);
		record.writeUInt16BE(4, 10);
		Buffer.from(FOUNDING_MODEL_ADDRESS.split(".").map(Number)).copy(record, 12);
	}
	return Buffer.concat([header, bytes.subarray(12), record]);
}

/** Scripted model boundary only. It never proxies traffic or accepts a real
 * provider token. The request must contain this exact launched receipt, proving
 * the company vision crossed the real context/native wire before completion. */
export function foundingNativeModelHandler({
	receiptId,
	token = FOUNDING_MODEL_TOKEN,
	onObservation = () => {},
}) {
	assert(/^[0-9a-f-]{36}$/.test(receiptId));
	assertFoundingSyntheticToken(token);
	let completed = false;
	return async (request, response) => {
		try {
			assert(NATIVE_CODEX_EGRESS_HOSTS.includes(request.socket.servername), "Unexpected model TLS identity");
			assert.equal(request.headers.host?.split(":")[0], request.socket.servername);
			assert.equal(request.headers.authorization, `Bearer ${token}`, "Only synthetic auth accepted");
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/backend-api/codex/responses");
			assert(!completed, "One scripted completion per founding run");
			const chunks = [];
			let size = 0;
			for await (const bytes of request) {
				size += bytes.length;
				assert(size <= 2 * 1024 * 1024, "Model request exceeded bound");
				chunks.push(bytes);
			}
			const encoding = request.headers["content-encoding"];
			assert(encoding === undefined || encoding === "zstd", "Unsupported native request encoding");
			const wire = Buffer.concat(chunks);
			const decoded =
				encoding === "zstd" ? zstdDecompressSync(wire, { maxOutputLength: 2 * 1024 * 1024 }) : wire;
			const body = JSON.parse(decoded.toString("utf8"));
			assert(typeof body.model === "string" && body.model.length < 128);
			assert(
				JSON.stringify([body.instructions, body.input]).includes(receiptId),
				"Founding context absent from model input",
			);
			const base = { id: "resp_isolated_founding", object: "response", model: body.model, created_at: 1 };
			assert(
				Array.isArray(body.tools) &&
					JSON.stringify(body.tools).includes('"send_message"') &&
					JSON.stringify(body.tools).includes('"qorpera"'),
				"Governed public send tool absent",
			);
			const argumentsText = JSON.stringify({
				idempotencyKey: "isolated-founding-final",
				phase: "final",
				text: "Isolated founding runtime boundary completed with this company's shared vision.",
			});
			const item = {
				type: "function_call",
				id: "fc_isolated_founding",
				call_id: "call_isolated_founding",
				namespace: "qorpera",
				name: "send_message",
				arguments: argumentsText,
				status: "completed",
			};
			completed = true;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{ type: "response.created", response: { ...base, status: "in_progress", output: [] } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, arguments: "", status: "in_progress" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: item.id,
					output_index: 0,
					delta: argumentsText,
				},
				{
					type: "response.function_call_arguments.done",
					item_id: item.id,
					output_index: 0,
					arguments: argumentsText,
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.completed",
					response: {
						...base,
						status: "completed",
						output: [item],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			])
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
			onObservation({ kind: "scripted_model_completion", receiptId, inputBytes: size });
		} catch {
			onObservation({ kind: "scripted_model_refused" });
			if (!response.headersSent) response.writeHead(403);
			response.end();
		}
	};
}

export async function startFoundingNativeModel({
	host,
	key,
	cert,
	receiptId,
	token = FOUNDING_MODEL_TOKEN,
	onObservation,
	dnsPort = 0,
	tlsPort = 0,
}) {
	assert(
		isIPv4(host) && (host === "127.0.0.1" || host.startsWith("10.")),
		"Private isolated listener required",
	);
	assert(nativeEgressPublicAddress(FOUNDING_MODEL_ADDRESS));
	assert([dnsPort, tlsPort].every((port) => Number.isSafeInteger(port) && port >= 0 && port <= 65535));
	const dns = createSocket("udp4");
	const tls = createServer(
		{ key, cert, minVersion: "TLSv1.2" },
		foundingNativeModelHandler({ receiptId, token, onObservation }),
	);
	// Pinned 0.155.1 advertises Responses WebSockets by default. Its actual
	// core/src/client.rs explicitly selects normal HTTP on a 426 handshake.
	// Exercise that supported branch instead of modifying native configuration.
	tls.requestTimeout = 15000;
	tls.headersTimeout = 15000;
	tls.setTimeout(15000, (socket) => socket.destroy());
	tls.on("upgrade", (request, socket) => {
		const allowed =
			request.method === "GET" &&
			request.url === "/backend-api/codex/responses" &&
			NATIVE_CODEX_EGRESS_HOSTS.includes(socket.servername) &&
			request.headers.host?.split(":")[0] === socket.servername &&
			request.headers.authorization === `Bearer ${token}`;
		if (allowed) onObservation?.({ kind: "scripted_model_http_fallback" });
		socket.end(
			`HTTP/1.1 ${allowed ? "426 Upgrade Required" : "403 Forbidden"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
		);
	});
	dns.on("message", (bytes, peer) => {
		try {
			dns.send(foundingNativeDnsResponse(bytes), peer.port, peer.address);
		} catch {
			/* malformed query gets no reply */
		}
	});
	try {
		await new Promise((resolve, reject) => {
			dns.once("error", reject);
			dns.bind(dnsPort, host, resolve);
		});
		await new Promise((resolve, reject) => {
			tls.once("error", reject);
			tls.listen(tlsPort, host, resolve);
		});
		return {
			dnsPort: dns.address().port,
			tlsPort: tls.address().port,
			modelAddress: FOUNDING_MODEL_ADDRESS,
			async close() {
				tls.closeAllConnections();
				await new Promise((resolve) => tls.close(resolve));
				await new Promise((resolve) => dns.close(resolve));
			},
		};
	} catch (error) {
		tls.close();
		dns.close();
		throw error;
	}
}
