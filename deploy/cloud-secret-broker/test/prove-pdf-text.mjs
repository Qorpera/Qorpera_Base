#!/usr/bin/env node
// Proves the PDF text service on a real host (deploy/first-node/RUNTIME-DIGITAL-POST.md, "PDF text"): run as root after
// the install steps, or with --transient on a test machine, where it adds poppler-utils, the vault's group and the two
// units for the run alone (units under /run/systemd/system) and takes away exactly what it added. --transient refuses a
// host where any of the units or the socket's folder is already there.
//
//   sudo node deploy/cloud-secret-broker/test/prove-pdf-text.mjs [--transient]
//
// It checks: the socket is root's, the vault's group's, mode 0660; a PDF's text comes back with the one-time code after
// it, Danish letters included; pdftotext reads 201 pages and no more; a file that is not a PDF, and a first line that
// is not a code, give no text and no code; text from an instance killed partway has no code; a PDF never finished is
// ended by the service's 30-second limit; a user outside the vault's group cannot connect; and a running instance has
// its own user, network and mounts. It prints systemd's exposure score for the service. Node's own modules only.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET = "/run/qorpera-pdf-text/socket";
const GROUP = "qorpera-shared-vault";
const UNITS = ["qorpera-pdf-text.socket", "qorpera-pdf-text@.service"];
const here = dirname(fileURLToPath(import.meta.url));
const transient = process.argv.includes("--transient");

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", ...options });
const quiet = (command, args) => spawnSync(command, args, { encoding: "utf8" });
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures += 1;
}

/** A PDF in Helvetica with WinAnsi text (\370 is ø), one page per entry of lines, with a correct cross-reference
 * table. */
function pdf(pages, { size = 12, leading = 14 } = {}) {
	const objects = [];
	const add = (body) => objects.push(body);
	add("");
	add("");
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	const kids = [];
	for (const lines of pages) {
		const content = `BT /F1 ${size} Tf ${leading} TL 40 800 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
		const contents = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
		kids.push(
			add(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
			),
		);
	}
	objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	const parts = ["%PDF-1.4\n"];
	let length = parts[0].length;
	const offsets = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(length);
		const part = `${index + 1} 0 obj\n${object}\nendobj\n`;
		parts.push(part);
		length += part.length;
	}
	parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
	for (const offset of offsets) parts.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
	parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`);
	return Buffer.from(parts.join(""), "latin1");
}

/** Sends a one-time code line and `input` (closing the sending side unless `finish` is false), and reads until the
 * service closes. `complete`: the answer ends with the code, as the service writes it after a clean exit. */
function ask(input, { finish = true, firstLine, onData } = {}) {
	const code = randomBytes(16).toString("hex");
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const chunks = [];
		const socket = connect({ path: SOCKET });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("no answer within 60 s"));
		}, 60_000);
		socket.on("connect", () => {
			socket.write(`${firstLine ?? code}\n`);
			if (finish) socket.end(input);
			else socket.write(input);
		});
		socket.on("data", (chunk) => {
			chunks.push(chunk);
			onData?.();
		});
		socket.on("error", (error) => {
			// The service closing while the PDF is still on its way is an answer: nothing, then "close".
			if (error.code === "ECONNRESET" || error.code === "EPIPE") return;
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks).toString("utf8");
			const trailer = `\n${code}\n`;
			const complete = raw.endsWith(trailer);
			resolve({
				raw,
				complete,
				text: complete ? raw.slice(0, -trailer.length) : raw,
				seconds: (Date.now() - started) / 1000,
			});
		});
	});
}

/** This process's own instances: their names carry the peer's PID, then `_` and its start (systemd 259:
 * `qorpera-pdf-text@3-13095-3878173_167415634-0.service`), or `-` in older systemd. */
function ownInstances() {
	const own = new RegExp(`-${process.pid}[_-]`);
	return run("systemctl", ["list-units", "qorpera-pdf-text@*.service", "--plain", "--no-legend", "--all"])
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[0] ?? "")
		.filter((name) => own.test(name));
}

const added = { group: false, packages: [], units: false };
function setUp() {
	const present = [
		...UNITS.flatMap((unit) =>
			["/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system"].map((folder) => join(folder, unit)),
		),
		"/run/qorpera-pdf-text",
	].filter((path) => existsSync(path));
	if (present.length > 0) throw new Error(`--transient refuses a host that has them already: ${present.join(", ")}`);
	if (quiet("getent", ["group", GROUP]).status !== 0) {
		run("groupadd", ["--system", GROUP]);
		added.group = true;
	}
	if (!existsSync("/usr/bin/pdftotext")) {
		const before = new Set(run("dpkg-query", ["-W", "-f", "${Package}\n"]).split("\n"));
		const apt = ["-o", "DPkg::Lock::Timeout=120", "-qq"];
		run("apt-get", [...apt, "update"], { stdio: "ignore" });
		run("apt-get", [...apt, "install", "-y", "--no-install-recommends", "poppler-utils"], {
			stdio: "ignore",
			env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
		});
		added.packages = run("dpkg-query", ["-W", "-f", "${Package}\n"])
			.split("\n")
			.filter((name) => name && !before.has(name));
	}
	added.units = true;
	for (const unit of UNITS)
		run("install", ["-m", "0644", join(here, "..", unit), join("/run/systemd/system", unit)]);
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["start", "qorpera-pdf-text.socket"]);
}
function tearDown() {
	if (added.units) {
		quiet("systemctl", ["stop", "qorpera-pdf-text.socket", ...ownInstances()]);
		for (const unit of UNITS) quiet("rm", ["-f", join("/run/systemd/system", unit)]);
		quiet("systemctl", ["daemon-reload"]);
		quiet("rm", ["-rf", "/run/qorpera-pdf-text"]);
	}
	if (added.packages.length > 0)
		quiet("apt-get", ["-o", "DPkg::Lock::Timeout=120", "-qq", "purge", "-y", ...added.packages]);
	if (added.group) quiet("groupdel", [GROUP]);
	console.log(
		`cleaned up: units ${added.units ? "removed" : "untouched"}, packages purged ${added.packages.length}, group ${added.group ? "removed" : "untouched"}`,
	);
}

async function prove() {
	console.log(`pdftotext: ${quiet("/usr/bin/pdftotext", ["-v"]).stderr.split("\n")[0]}`);
	const socket = statSync(SOCKET);
	const gid = Number(run("getent", ["group", GROUP]).split(":")[2]);
	check(
		"the socket is root's and the vault group's, mode 0660",
		socket.isSocket() && socket.uid === 0 && socket.gid === gid && (socket.mode & 0o777) === 0o660,
		`uid ${socket.uid}, gid ${socket.gid}, mode ${(socket.mode & 0o777).toString(8)}`,
	);

	const read = await ask(pdf([["Skattestyrelsen", "Afg\\370relse om skat for 2026"]]));
	check(
		"a PDF's text comes back with the code after it, Danish letters included",
		read.complete && read.text.includes("Skattestyrelsen") && read.text.includes("Afgørelse om skat for 2026"),
		`${read.text.trim().split("\n").length} lines in ${read.seconds.toFixed(1)} s`,
	);

	const long = await ask(pdf(Array.from({ length: 202 }, (_, page) => [`Page ${page + 1} of 202`])));
	check(
		"pdftotext reads 201 pages and no more, so the vault can tell a longer PDF",
		long.complete &&
			long.text.includes("Page 201 of 202") &&
			!long.text.includes("Page 202 of 202") &&
			long.text.split("\f").length === 202,
		`${long.text.split("\f").length - 1} pages`,
	);

	const junk = await ask(Buffer.from("This is not a PDF.\n".repeat(100)));
	check("a file that is not a PDF gives no text and no code", !junk.complete && junk.raw === "", `${junk.seconds} s`);
	const noCode = await ask(pdf([["Hello"]]), { firstLine: "not a code" });
	check("a first line that is not a code gives nothing", noCode.raw === "", `${noCode.seconds} s`);

	let killed = false;
	const heavy = await ask(
		pdf(
			Array.from({ length: 201 }, (_, page) =>
				Array.from({ length: 900 }, (_, line) => `Page ${page + 1} line ${line + 1} lorem ipsum dolor sit amet`),
			),
			{ size: 1, leading: 0.85 },
		),
		{
			onData: () => {
				if (killed) return;
				killed = true;
				for (const name of ownInstances()) quiet("systemctl", ["kill", "--signal=SIGKILL", name]);
			},
		},
	);
	check(
		"text from an instance killed partway has no code, so the vault keeps none of it",
		killed && heavy.raw.length > 0 && !heavy.complete,
		`${heavy.raw.length} bytes before the kill`,
	);

	const unfinished = ask(pdf([["Never finished"]]).subarray(0, 200), { finish: false });
	// While that instance waits for the rest of its PDF, look at it from outside.
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const [instance] = ownInstances().filter(
		(name) => run("systemctl", ["show", name, "-p", "ActiveState", "--value"]).trim() === "active",
	);
	const pid = Number(run("systemctl", ["show", instance ?? "", "-p", "ExecMainPID", "--value"]).trim());
	const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
	check("a running instance has a throwaway user", uid >= 61184 && uid <= 65519, `uid ${uid}`);
	for (const space of ["net", "mnt"])
		check(
			`a running instance has its own ${space} namespace`,
			readlinkSync(`/proc/${pid}/ns/${space}`) !== readlinkSync(`/proc/1/ns/${space}`),
		);
	const ended = await unfinished;
	check(
		"a PDF never finished is ended by the service's 30-second limit, with no code",
		!ended.complete && ended.seconds >= 25 && ended.seconds <= 45,
		`closed after ${ended.seconds.toFixed(1)} s`,
	);

	const outsider = quiet("runuser", [
		"-u",
		"nobody",
		"--",
		"python3",
		"-c",
		`import socket\ns = socket.socket(socket.AF_UNIX)\ntry:\n    s.connect(${JSON.stringify(SOCKET)})\n    print("CONNECTED")\nexcept PermissionError:\n    print("EACCES")`,
	]);
	check("a user outside the vault's group cannot connect", outsider.stdout.trim() === "EACCES", outsider.stdout.trim());

	const security = quiet("systemd-analyze", ["security", "--no-pager", "qorpera-pdf-text@proof.service"]);
	const level = /Overall exposure level for .*: ([\d.]+) (\S+)/.exec(security.stdout);
	check(
		"systemd's exposure score for the service is low",
		level !== null && Number(level[1]) <= 2.5,
		level ? `${level[1]} ${level[2]}` : "no score",
	);
}

if (process.getuid?.() !== 0) {
	console.error("Run as root.");
	process.exit(2);
}
try {
	if (transient) setUp();
	await prove();
} catch (error) {
	check("the proof ran to its end", false, error instanceof Error ? error.message : String(error));
} finally {
	if (transient) tearDown();
}
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
