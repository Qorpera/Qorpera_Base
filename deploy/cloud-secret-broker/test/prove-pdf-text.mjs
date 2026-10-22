#!/usr/bin/env node
// Proves the PDF text service on a real host (deploy/first-node/RUNTIME-DIGITAL-POST.md, part 5): run as root after the
// install steps, or with --transient on a test machine, where it installs poppler-utils, the vault's group and the two
// units for the run alone (units under /run/systemd/system) and takes away exactly what it added.
//
//   sudo node deploy/cloud-secret-broker/test/prove-pdf-text.mjs [--transient]
//
// It checks: the socket is root's, the vault's group's, mode 0660; a PDF's text comes back, Danish letters included; a
// file that is not a PDF gives no text and the connection closes; a PDF never finished is ended by the service's own
// limit; a user outside the vault's group cannot connect; and a running instance has its own user, network and mounts.
// It prints systemd's exposure score for the service. No dependencies: Node's own modules only.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
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

/** A one-page PDF in Helvetica with WinAnsi text (\370 is ø), with a correct cross-reference table. */
function pdf() {
	const content = "BT /F1 12 Tf 14 TL 72 770 Td (Skattestyrelsen) Tj T* (Afg\\370relse om skat for 2026) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

/** Sends `input` (closing the sending side unless `finish` is false) and reads until the service closes. */
function ask(input, { finish = true, deadlineMs = 60_000 } = {}) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const chunks = [];
		const socket = connect({ path: SOCKET });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("no answer before the deadline"));
		}, deadlineMs);
		socket.on("connect", () => (finish ? socket.end(input) : socket.write(input)));
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			resolve({ text: Buffer.concat(chunks).toString("utf8"), seconds: (Date.now() - started) / 1000 });
		});
	});
}

const added = { group: false, packages: [], units: false };
function setUp() {
	if (quiet("getent", ["group", GROUP]).status !== 0) {
		run("groupadd", ["--system", GROUP]);
		added.group = true;
	}
	if (quiet("test", ["-x", "/usr/bin/pdftotext"]).status !== 0) {
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
	for (const unit of UNITS)
		run("install", ["-m", "0644", join(here, "..", unit), join("/run/systemd/system", unit)]);
	added.units = true;
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["start", "qorpera-pdf-text.socket"]);
}
function tearDown() {
	if (added.units) {
		quiet("systemctl", ["stop", "qorpera-pdf-text.socket", "qorpera-pdf-text@*.service"]);
		for (const unit of UNITS) quiet("rm", ["-f", join("/run/systemd/system", unit)]);
		quiet("systemctl", ["daemon-reload"]);
		quiet("rm", ["-rf", "/run/qorpera-pdf-text"]);
	}
	if (added.packages.length)
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

	const read = await ask(pdf());
	check(
		"a PDF's text comes back, Danish letters included",
		read.text.includes("Skattestyrelsen") && read.text.includes("Afgørelse om skat for 2026"),
		`${read.text.trim().split("\n").length} lines in ${read.seconds.toFixed(1)} s`,
	);

	const junk = await ask(Buffer.from("This is not a PDF.\n".repeat(100)));
	check("a file that is not a PDF gives no text and closes", junk.text.trim() === "", `${junk.seconds.toFixed(1)} s`);

	const unfinished = ask(pdf().subarray(0, 200), { finish: false });
	// While that instance waits for the rest, look at it from outside.
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const instance = run("systemctl", ["list-units", "qorpera-pdf-text@*.service", "--plain", "--no-legend"])
		.trim()
		.split(/\s+/)[0];
	const pid = Number(run("systemctl", ["show", instance, "-p", "MainPID", "--value"]).trim());
	const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
	check("a running instance has a throwaway user", uid >= 61184 && uid <= 65519, `uid ${uid}`);
	for (const space of ["net", "mnt"])
		check(
			`a running instance has its own ${space} namespace`,
			readlinkSync(`/proc/${pid}/ns/${space}`) !== readlinkSync(`/proc/1/ns/${space}`),
		);
	const ended = await unfinished;
	check(
		"a PDF never finished is ended by the service's 30-second limit",
		ended.seconds >= 25 && ended.seconds <= 45,
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
