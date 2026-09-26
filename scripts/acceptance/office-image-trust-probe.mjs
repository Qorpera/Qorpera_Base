import assert from "node:assert/strict";
import { request } from "node:https";

assert.equal(process.env.NODE_EXTRA_CA_CERTS, "/usr/local/share/qorpera-acceptance/ca.pem");
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
assert.equal(process.getuid(), 1100);
const endpoint = new URL(process.argv[2]);
assert.equal(endpoint.protocol, "https:");
function call(servername) {
	return new Promise((resolve, reject) => {
		const req = request(endpoint, { ...(servername ? { servername } : {}), timeout: 5000 }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.once("error", reject);
		req.once("timeout", () => req.destroy(new Error("OFFICE_TLS_PROBE_TIMEOUT")));
		req.end();
	});
}
const trusted = await call();
assert.equal(trusted.status, 200);
assert.deepEqual(JSON.parse(trusted.body), { schema: "qorpera.office-image-tls-proof/v1" });
await assert.rejects(call("wrong-hostname.qorpera.invalid"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
console.log(JSON.stringify({ schema: "qorpera.office-image-node-trust/v1", uid: process.getuid(), node: process.version, managerCaEnvironment: true, trustedHttps: true, mismatchedHostnameRefused: true }));
