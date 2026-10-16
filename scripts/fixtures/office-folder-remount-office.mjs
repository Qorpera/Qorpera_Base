// The office side of the Q3 remount proof (office-folder-remount.py). It runs as the office account in a transient
// unit with every confinement line of master's office unit, and starts each namespace through the runtime's own
// process gate (cloud-company-computer-linux-process.ts, type-stripped) with the bubblewrap arguments the launcher
// mirrored from the runtime (shapes.json). It answers one JSON request per line on stdin with one JSON line.
// It is not the office service: no credentials, no plumber, no network of its own.
import { constants } from "node:fs";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const directory = process.argv[2];
const { spawnCompanyComputerLinuxProcess } = await import(
	pathToFileURL(join(directory, "company-computer-process.mjs")).href
);
const shapes = JSON.parse(await readFile(join(directory, "shapes.json"), "utf8"));
const program = await readFile(join(directory, "office-folder-remount-client.py"), "utf8");
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const CALL_MS = 30000;
const clients = new Map();

async function mountinfo() {
	return (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter((line) => line.includes("qorpera-folder"));
}

/** The folder's place in a namespace: the shared parent with `/company` a link into it, or the mount itself. */
function folderArgs(folder, fd) {
	if (folder === "direct") return ["--bind-fd", String(fd), "/company"];
	if (folder === "candidate") return ["--bind-fd", String(fd), "/run/qorpera-company", "--symlink", "/run/qorpera-company/company", "/company"];
	throw new Error("UNKNOWN_FOLDER_FORM");
}

async function start({ name, shape, folder, view, chdir }) {
	if (clients.has(name)) throw new Error("CLIENT_EXISTS");
	const form = shapes.shapes[shape];
	if (!form) throw new Error("UNKNOWN_SHAPE");
	const files = [];
	try {
		for (const file of form.files)
			files.push(await open(file.path, file.directory ? DIRECTORY : constants.O_RDONLY | constants.O_NOFOLLOW));
		const parent = join(shapes.root, "mounts", view);
		files.push(await open(folder === "direct" ? join(parent, "company") : parent, DIRECTORY));
		const fd = 3 + (form.pipeCount ?? 0) + files.length - 1;
		const args = [];
		const skipped = [];
		for (const arg of form.args) {
			if (typeof arg === "string") args.push(arg);
			else if (arg.folder) args.push(...folderArgs(folder, fd));
			else if (arg.requiredRoBind) {
				const info = await lstat(arg.requiredRoBind);
				if (info.isSymbolicLink() || info.isDirectory() !== arg.directory) throw new Error(`IMAGE_ARTIFACT ${arg.requiredRoBind}`);
				args.push("--ro-bind", arg.requiredRoBind, arg.requiredRoBind);
			} else if (arg.optionalRoBind) {
				const info = await lstat(arg.optionalRoBind).catch(() => undefined);
				if (!info) skipped.push(arg.optionalRoBind);
				else if (info.isSymbolicLink() || info.isDirectory() !== arg.directory) throw new Error(`IMAGE_ARTIFACT ${arg.optionalRoBind}`);
				else args.push("--ro-bind", arg.optionalRoBind, arg.optionalRoBind);
			} else throw new Error("UNKNOWN_SHAPE_ARGUMENT");
		}
		// A measured variant only: where the namespace starts. The runtime's own value stays in shapes.json.
		if (chdir) args[args.lastIndexOf("--chdir") + 1] = chdir;
		const launched = spawnCompanyComputerLinuxProcess({
			args,
			command: ["/usr/bin/python3", "-u", "-c", program, name],
			files,
			...(form.pipeCount ? { pipeCount: form.pipeCount } : {}),
			stdin: "pipe",
		});
		const lines = [];
		const waiting = [];
		let stderr = "";
		// A client that already ended answers with a timeout, not an unhandled EPIPE.
		launched.child.stdin.on("error", () => undefined);
		launched.child.stderr.on("data", (part) => {
			stderr = (stderr + part.toString("utf8")).slice(-4096);
		});
		createInterface({ input: launched.child.stdout }).on("line", (line) => {
			const next = waiting.shift();
			if (next) next(line);
			else lines.push(line);
		});
		const closed = new Promise((resolve) => launched.child.once("close", (code, signal) => resolve({ code, signal })));
		const client = {
			launched,
			closed,
			stderr: () => stderr,
			next: () =>
				lines.length
					? Promise.resolve(lines.shift())
					: new Promise((resolve, reject) => {
							const timer = setTimeout(() => {
								waiting.splice(waiting.indexOf(answer), 1);
								reject(new Error("CLIENT_TIMEOUT"));
							}, CALL_MS);
							const answer = (line) => {
								clearTimeout(timer);
								resolve(line);
							};
							waiting.push(answer);
						}),
		};
		try {
			await launched.started;
		} catch (error) {
			const ended = await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
			return { started: false, gate: String(error.message), ended, stderr: stderr };
		}
		clients.set(name, client);
		return { started: true, monitorPid: launched.child.pid, folderFd: fd, args, skipped };
	} finally {
		for (const file of files) await file.close();
	}
}

async function call({ name, request }) {
	const client = clients.get(name);
	if (!client) throw new Error("NO_CLIENT");
	client.launched.child.stdin.write(`${JSON.stringify(request)}\n`);
	try {
		return { reply: JSON.parse(await client.next()) };
	} catch (error) {
		return { callError: String(error.message), stderr: client.stderr() };
	}
}

async function stop({ name }) {
	const client = clients.get(name);
	if (!client) return { stopped: false };
	clients.delete(name);
	client.launched.child.stdin.end();
	const ended = await Promise.race([client.closed, new Promise((resolve) => setTimeout(() => resolve(undefined), 3000))]);
	if (ended) return { stopped: true, ended, stderr: client.stderr() };
	client.launched.stop();
	return { stopped: true, ended: await client.closed, killed: true, stderr: client.stderr() };
}

async function handle(request) {
	switch (request.op) {
		case "info":
			return {
				uid: process.getuid(),
				gid: process.getgid(),
				pid: process.pid,
				node: process.version,
				mountNamespace: await readlink("/proc/self/ns/mnt"),
				mountinfo: await mountinfo(),
			};
		case "start":
			return start(request);
		case "call":
			return call(request);
		case "stop":
			return stop(request);
		case "exit":
			return { stopped: await Promise.all([...clients.keys()].map((name) => stop({ name }))) };
		default:
			throw new Error("UNKNOWN_RELAY_OPERATION");
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	let reply;
	try {
		reply = { id: request.id, ...(await handle(request)) };
	} catch (error) {
		reply = { id: request.id, error: String(error?.stack ?? error) };
	}
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	if (request.op === "exit") break;
}
process.exit(0);
