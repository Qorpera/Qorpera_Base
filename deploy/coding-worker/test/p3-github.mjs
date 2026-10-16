// P3's stand-in GitHub, inside the proof's throwaway node (it has no network card): github.com and api.github.com
// point at 127.0.0.1 in the node's /etc/hosts, and this serves them over HTTPS with a certificate from the node's own
// CA, so the executor's Git broker runs unchanged (its bubblewrap sandbox binds /etc/hosts and /etc/ssl/certs).
// Git's smart HTTP goes to `git http-backend` on bare repositories under the root; every request must carry the
// proof's repository token as GitHub's x-access-token Basic credential. api.github.com answers the calls of the
// executor's draft pull request (coding-workspace.ts publishCloudCodingDraftPullRequest), with the same token as a
// Bearer: a branch's ref, a head's pulls, and a new pull, kept in <root>/<owner>/<name>.pulls.json. Each request is one
// JSON line in the log.
//
//   node p3-github.mjs <root> <certificate> <key> <token> <log>
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const [root, certificate, key, token, logPath] = process.argv.slice(2);
if (!logPath) throw new Error("usage: p3-github.mjs <root> <certificate> <key> <token> <log>");
const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const GIT_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(\/(?:info\/refs|git-upload-pack|git-receive-pack))$/;
const API_PATH = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:pulls|git\/ref\/heads\/([^/]+))$/;
const log = (value) => appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);

/** api.github.com: the three calls of a draft pull request. */
function api(request, reply, url, match) {
	const answer = (status, value) => reply.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
	const [, owner, name, encodedBranch] = match;
	const repository = join(root, owner, `${name}.git`);
	if (!existsSync(repository)) return answer(404, { message: "Not Found" });
	const pullsFile = join(root, owner, `${name}.pulls.json`);
	const pulls = existsSync(pullsFile) ? JSON.parse(readFileSync(pullsFile, "utf8")) : [];
	const headOf = (branch) => {
		try {
			return execFileSync("/usr/bin/git", ["--git-dir", repository, "rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return null;
		}
	};
	// A pull's head is its branch's, as GitHub's follows a push.
	const current = (pull) => ({ ...pull, head: { ...pull.head, sha: headOf(pull.head.ref) } });
	if (encodedBranch !== undefined) {
		if (request.method !== "GET") return answer(404, { message: "Not Found" });
		const branch = decodeURIComponent(encodedBranch);
		const sha = headOf(branch);
		return sha ? answer(200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha } }) : answer(404, { message: "Not Found" });
	}
	if (request.method === "GET")
		return answer(200, pulls.filter((pull) => `${owner}:${pull.head.ref}` === url.searchParams.get("head")).map(current));
	if (request.method !== "POST") return answer(404, { message: "Not Found" });
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return answer(400, { message: "Problems parsing JSON" });
		}
		if (typeof body.head !== "string" || typeof body.base !== "string" || !headOf(body.head) || !headOf(body.base) ||
			pulls.some((pull) => pull.head.ref === body.head))
			return answer(422, { message: "Validation Failed" });
		const number = pulls.length + 1;
		const fullName = `${owner}/${name}`;
		const pull = { number, html_url: `https://github.com/${fullName}/pull/${number}`, state: "open", draft: body.draft === true,
			title: String(body.title ?? ""), body: String(body.body ?? ""), head: { ref: body.head, repo: { full_name: fullName } },
			base: { ref: body.base, repo: { full_name: fullName } } };
		pulls.push(pull);
		writeFileSync(pullsFile, JSON.stringify(pulls));
		log({ pull: number, head: body.head, draft: pull.draft });
		answer(201, current(pull));
	});
}

createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, reply) => {
	const url = new URL(request.url ?? "/", "https://github.com");
	const host = String(request.headers.host ?? "").replace(/:443$/, "");
	const apiMatch = host === "api.github.com" ? API_PATH.exec(url.pathname) : null;
	const authorized = request.headers.authorization === (apiMatch ? `Bearer ${token}` : expected);
	const match = host === "github.com" ? GIT_PATH.exec(url.pathname) : null;
	log({ host, method: request.method, path: url.pathname, query: url.search, authorized, git: Boolean(match) });
	if (apiMatch) {
		if (!authorized) return void reply.writeHead(401, { "content-type": "application/json" }).end('{"message":"Bad credentials"}');
		return void api(request, reply, url, apiMatch);
	}
	if (!match) {
		reply.writeHead(404, { "content-type": "application/json" }).end('{"message":"Not Found"}');
		return;
	}
	if (!authorized) {
		reply.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end();
		return;
	}
	const child = spawn("/usr/bin/git", ["http-backend"], {
		env: {
			PATH: "/usr/bin:/bin",
			GIT_PROJECT_ROOT: root,
			GIT_HTTP_EXPORT_ALL: "1",
			PATH_INFO: `/${match[1]}/${match[2]}.git${match[3]}`,
			REQUEST_METHOD: request.method ?? "GET",
			QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: request.headers["content-type"] ?? "",
			REMOTE_USER: "x-access-token",
			REMOTE_ADDR: "127.0.0.1",
			...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
			...(request.headers["git-protocol"] ? { GIT_PROTOCOL: request.headers["git-protocol"] } : {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	request.pipe(child.stdin);
	let head = Buffer.alloc(0);
	let started = false;
	child.stdout.on("data", (chunk) => {
		if (started) return void reply.write(chunk);
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n") >= 0 ? head.indexOf("\r\n\r\n") : head.indexOf("\n\n");
		if (end < 0) return;
		const separator = head.indexOf("\r\n\r\n") === end ? 4 : 2;
		const headers = {};
		let status = 200;
		for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const name = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
			else headers[name] = value;
		}
		started = true;
		reply.writeHead(status, headers);
		reply.write(head.subarray(end + separator));
	});
	child.stderr.on("data", (chunk) => log({ gitStderr: chunk.toString("utf8").slice(0, 500) }));
	child.on("close", (code) => {
		if (!started) reply.writeHead(502).end();
		else reply.end();
		log({ path: url.pathname, exit: code });
	});
}).listen(443, "127.0.0.1", () => log({ listening: 443 }));
