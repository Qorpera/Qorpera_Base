// A stand-in for the platform's API in the kit's drill (drill.yml). It is not the platform and proves nothing about
// it: it answers the gateway's two folder reads (gateway.mjs Platform) from /folder/folder.json, which the drill writes:
//   { "member": "<uuid>", "environment": "<uuid>", "run": "<uuid>", "files": { "data/shop/database.toml": "<text>", ... },
//     "passes": { "<43-character pass>": "<database>" } }
// It takes any token whose subject is that member, and the publishable key STANDIN_KEY. It redeems each listed pass
// once (qorpera_data_pass_redeem, with the key alone), keeping every file under data/<database>/; any other pass, or
// one redeemed already, answers null, as the platform does.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const answer = (response, status, value) => {
	const text = JSON.stringify(value);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	response.end(text);
};
const entry = (path, text) => ({ kind: "file", path, fileSha256: sha256(text), bytes: Buffer.byteLength(text) });
const redeemed = new Set();

http
	.createServer((request, response) => {
		const parts = [];
		request.on("data", (part) => parts.push(part));
		request.on("end", () => {
			const folder = JSON.parse(readFileSync("/folder/folder.json", "utf8"));
			if (request.headers.apikey !== process.env.STANDIN_KEY) return answer(response, 401, { message: "No API key found in request" });
			if (request.url === "/rest/v1/rpc/qorpera_data_pass_redeem") {
				const pass = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}").p_pass;
				const database = typeof pass === "string" && Object.hasOwn(folder.passes ?? {}, pass) && !redeemed.has(pass) ? folder.passes[pass] : null;
				if (database === null) return answer(response, 200, null);
				redeemed.add(pass);
				const files = Object.entries(folder.files)
					.filter(([path]) => path.startsWith(`data/${database}/`))
					.map(([path, text]) => ({ path, sha256: sha256(text), bytes: Buffer.byteLength(text) }));
				return answer(response, 200, {
					schema: "qorpera.data-pass-redeemed/v1",
					kind: "run",
					environmentId: folder.environment,
					runId: folder.run,
					staffAgentId: folder.agent,
					requesterUserId: folder.member,
					database,
					files,
				});
			}
			const token = /^Bearer [^.]+\.([^.]+)\.[^.]+$/.exec(request.headers.authorization ?? "")?.[1];
			let subject = null;
			try {
				subject = JSON.parse(Buffer.from(token ?? "", "base64url").toString("utf8")).sub;
			} catch {}
			if (subject !== folder.member) return answer(response, 401, { message: "JWT invalid" });
			const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
			if (request.url === "/rest/v1/rpc/qorpera_member_folder_read_many") {
				const reads = (body.p_paths ?? []).map((path) =>
					Object.hasOwn(folder.files, path) ? { found: true, entry: entry(path, folder.files[path]) } : { found: false },
				);
				return answer(response, 200, { reads });
			}
			if (request.url === "/rest/v1/rpc/qorpera_member_folder_list") {
				const entries = Object.entries(folder.files)
					.filter(([path]) => path.slice(0, path.lastIndexOf("/")) === body.p_parent)
					.map(([path, text]) => entry(path, text));
				return answer(response, 200, { entries });
			}
			answer(response, 404, { message: "not a call the stand-in answers" });
		});
	})
	.listen(8000, "0.0.0.0");
