import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { DATA_MAX_PAYLOAD, type DataVerb } from "./protocol.ts";

export type DoorAnswer = { readonly status: number; readonly body: Buffer } | "too_large";

export interface DataDoor {
	call(verb: DataVerb, body: Buffer, signal: AbortSignal): Promise<DoorAnswer>;
}

// WHY: node:https, never fetch: the unit runs `node --jitless`, and fetch needs WebAssembly, which it removes.
export function httpsDataDoor(options: { url: string; ca: string; token: string }): DataDoor {
	const url = new URL(options.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!/^[A-Za-z0-9_-]{43}$/.test(options.token) ||
		!options.ca.includes("-----BEGIN CERTIFICATE-----")
	)
		throw new Error("The company data door's URL, token or CA is not one");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : 443;
	const agent = new HttpsAgent({
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 8,
		maxFreeSockets: 4,
		ca: options.ca,
		minVersion: "TLSv1.2",
	});
	return {
		call: (verb, body, signal) =>
			new Promise((resolve, reject) => {
				if (signal.aborted) return reject(new Error("The company data door call ended"));
				let settled = false;
				const outgoing = httpsRequest(
					{
						host,
						port,
						ca: options.ca,
						minVersion: "TLSv1.2",
						method: "POST",
						path: `/v1/run-data/${verb}`,
						headers: {
							authorization: `Bearer ${options.token}`,
							"content-type": "application/json",
							"content-length": String(body.byteLength),
						},
						agent,
					},
					(response) => {
						const chunks: Buffer[] = [];
						let bytes = 0;
						response.on("data", (chunk: Buffer) => {
							bytes += chunk.byteLength;
							if (bytes <= DATA_MAX_PAYLOAD) chunks.push(chunk);
							else if (!settled) {
								settled = true;
								resolve("too_large");
								response.destroy();
							}
						});
						response.once("error", reject);
						response.once("end", () => {
							settled = true;
							resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, bytes) });
						});
					},
				);
				const end = (): void => {
					outgoing.destroy(new Error("The company data door call ended"));
				};
				signal.addEventListener("abort", end, { once: true });
				outgoing.once("close", () => {
					signal.removeEventListener("abort", end);
					if (!settled) reject(new Error("The company data door closed the connection"));
				});
				outgoing.once("error", reject);
				outgoing.end(body);
			}),
	};
}
