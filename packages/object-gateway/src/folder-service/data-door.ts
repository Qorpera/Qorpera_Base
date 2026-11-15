/** The data gateway's run door, as the folder service calls it for a company machine's `data` command (company
 * databases, slice 8a: deploy/first-node/RUNTIME-COMPANY-DATABASES.md §9a). A provider host calls the same door for a
 * run's data tools (packages/runtime/src/cloud-data-tools.ts `httpsCompanyDataDoor`): the node's private token as the
 * bearer, the certificate checked against the store's own CA and nothing else, a data pass in the body. */
import { request as httpsRequest } from "node:https";
import { DATA_MAX_PAYLOAD, type DataVerb } from "./protocol.ts";

/** What the door said: its status and its answer's bytes, or that the answer held more than a frame carries. */
export type DoorAnswer = { readonly status: number; readonly body: Buffer } | "too_large";

export interface DataDoor {
	/** One call. It ends with the signal: a call ended so has no answer, whatever the gateway went on to do. */
	call(verb: DataVerb, body: Buffer, signal: AbortSignal): Promise<DoorAnswer>;
}

/** The run door over HTTPS, on node:https (the unit runs `node --jitless`, which has no fetch): never pooled or
 * redirected, the answer read up to a frame's size. */
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
						agent: false,
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
					// A connection the gateway closed inside its answer.
					if (!settled) reject(new Error("The company data door closed the connection"));
				});
				outgoing.once("error", reject);
				outgoing.end(body);
			}),
	};
}
