/** Inside the disposable systemd container of scripts/test-run-box-systemd.mjs, as root: the shared execution package
 * installed by its real installer, then one run box started, probed and stopped the way the shared execution service
 * does it. The folder is this repository's folder service with the folder core in memory (run-box-folder-peer.mjs),
 * mounted by the real folder program through the box's real folder unit; only its --connect differs. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chown, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const ENV = "11111111-2222-4333-8444-555555555555";
const STAGING = "/var/lib/qorpera-bootstrap/shared-execution";
const checks = [];
const check = (name) => {
	checks.push(name);
	console.log(`PASS ${name}`);
};
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: "utf8", timeout: 60_000, ...options });
const ok = (file, args, options) => {
	const result = run(file, args, options);
	assert.equal(result.status, 0, `${file} ${args.join(" ")}: ${result.stderr} ${result.stdout}`);
	return result.stdout.trim();
};
const ctl = (...args) => ok("/usr/bin/systemctl", args);
const state = (unit) => run("/usr/bin/systemctl", ["is-active", unit]).stdout.trim();
const id = (flag, name) => Number(ok("/usr/bin/id", [flag, name]));
/** The native host's side of the box's read log: one take, as `account`. */
function takeReads(account) {
	const script =
		"const s=require('net').connect(process.argv[1]);s.on('error',e=>{console.error(e.code);process.exit(3)});" +
		"s.write(JSON.stringify({t:'take',max:10000})+'\\n');let b='';s.on('data',d=>{b+=d;if(b.includes('\\n')){process.stdout.write(b);s.end()}});";
	const result = spawnSync("/usr/bin/node", ["-e", script, "/run/qorpera-shared-box/0.reads"], {
		encoding: "utf8",
		timeout: 10_000,
		uid: id("-u", account),
		gid: id("-g", account),
	});
	return { code: result.status, stderr: result.stderr, answer: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}
const mounted = async (path) =>
	(await readFile("/proc/self/mountinfo", "utf8")).split("\n").some((line) => line.split(" ")[4] === path);
async function until(test, label, ms = 20_000) {
	const started = Date.now();
	while (!(await test())) {
		assert(Date.now() - started < ms, `${label}\n${run("/usr/bin/journalctl", ["-n", "60", "--no-pager"]).stdout}`);
		await delay(50);
	}
}

/** The slot's native host's side of the box socket: a client process under the given account. */
class Client {
	#child;
	#lines = [];
	#waiting = [];
	#buffer = "";
	closed;
	constructor(socket, account) {
		const script =
			"const s=require('net').connect(process.argv[1]);s.on('error',e=>{console.error(e.code);process.exit(3)});" +
			"process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));";
		this.#child = spawn("/usr/bin/node", ["-e", script, socket], {
			uid: id("-u", account),
			gid: id("-g", account),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (text) => {
			this.#buffer += text;
			for (let newline = this.#buffer.indexOf("\n"); newline >= 0; newline = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				const waiter = this.#waiting.shift();
				if (waiter) waiter(line);
				else this.#lines.push(line);
			}
		});
		let stderr = "";
		this.#child.stderr.on("data", (text) => {
			stderr += text;
		});
		this.closed = new Promise((done) =>
			this.#child.on("exit", (code) => {
				for (const waiter of this.#waiting.splice(0)) waiter(undefined);
				done({ code, stderr });
			}),
		);
	}
	next() {
		const line = this.#lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		return new Promise((done) => this.#waiting.push(done));
	}
	async ready() {
		const reply = JSON.parse(await this.next());
		assert.equal(reply.t, "ready");
		return reply.sessions;
	}
	async request(body) {
		const requestId = randomUUID();
		this.#child.stdin.write(`${JSON.stringify({ id: requestId, maxOutputBytes: 16_384, ...body })}\n`);
		const line = await this.next();
		assert(line, "the box answered");
		const reply = JSON.parse(line);
		assert.equal(reply.id, requestId);
		return reply;
	}
	async exec(cmd, options = {}) {
		return this.request({ t: "exec", cmd, workdir: null, tty: false, yieldMs: 10_000, ...options });
	}
	async sh(cmd) {
		const reply = await this.exec(cmd);
		assert.equal(reply.t, "result", JSON.stringify(reply));
		assert.equal(reply.session, null, `${cmd} ended`);
		return { code: reply.exitCode, out: reply.output.head + reply.output.tail };
	}
	end() {
		this.#child.stdin.end();
	}
}

const loopback = createServer((socket) => socket.end("LOOPBACK-REACHED\n"));
let peer;
try {
	assert.equal(process.getuid(), 0);
	// The installer checks that it runs on the pinned runner image; these stand in for the image's runner files.
	await mkdir("/opt/qorpera-runner", { recursive: true });
	for (const file of ["qorpera-ephemeral-runner.mjs", "qorpera-native-provider-host.mjs", "qorpera-native-isolation-child.mjs"])
		await writeFile(`/opt/qorpera-runner/${file}`, "// stand-in\n", { mode: 0o644 });
	await mkdir(STAGING, { recursive: true, mode: 0o700 });
	await cp("/fixture/package", STAGING, { recursive: true });
	const installed = run("/usr/bin/bash", [`${STAGING}/install-shared-execution-guest.sh`], {
		env: { ...process.env, QORPERA_SHARED_EXECUTION_SLOTS: "2" },
		timeout: 180_000,
	});
	assert.equal(installed.status, 0, installed.stdout + installed.stderr);
	for (const slot of [0, 1]) assert(id("-u", `qorpera-shared-box-${slot}`) > 0);
	assert.equal(state("qorpera-shared-box@0.service"), "inactive");
	check("the real installer verifies the box files, adds a box account per slot and starts nothing");

	// What the box must never reach: credentials, run material, host files a slot account could read, other slots'
	// sockets, host loopback ports, the host's /dev/shm.
	await mkdir("/run/qorpera-shared-execution/slots/0/credentials", { recursive: true, mode: 0o700 });
	await writeFile("/run/qorpera-shared-execution/slots/0/credentials/qorpera-supabase-service-key", "QORPERA-PROBE-SERVICE-KEY\n", { mode: 0o600 });
	await writeFile("/etc/qorpera/shared-execution.env", "QORPERA-PROBE-ENV\n", { mode: 0o600 });
	await writeFile("/etc/qorpera/world-readable", "QORPERA-PROBE-ETC\n", { mode: 0o644 });
	await writeFile("/var/lib/qorpera-shared-execution/world-readable", "QORPERA-PROBE-STATE\n", { mode: 0o644 });
	const runRoot = "/var/lib/qorpera-shared-execution/slots/0/host/qorpera-native-run-proof/codex";
	await mkdir(runRoot, { recursive: true, mode: 0o700 });
	await writeFile(`${runRoot}/auth.json`, '{"QORPERA-PROBE":"LOGIN"}\n', { mode: 0o600 });
	await chown("/var/lib/qorpera-shared-execution/slots/0/host/qorpera-native-run-proof", id("-u", "qorpera-shared-host-0"), id("-g", "qorpera-shared-host-0"));
	await writeFile("/dev/shm/host-secret", "QORPERA-PROBE-SHM\n", { mode: 0o644 });
	await new Promise((done) => loopback.listen(20_000, "127.0.0.1", done));

	// The node's folder service, with a run box view open in its core, and the box's folder unit pointed at it.
	const viewId = randomUUID();
	const pass = randomBytes(32).toString("base64url");
	await mkdir("/run/fixture", { mode: 0o700 });
	peer = spawn("/usr/bin/node", ["/fixture/peer.mjs", "/run/fixture/bridge.sock", "/var/lib/fixture-share", viewId, pass], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise((done, fail) => {
		peer.stdout.on("data", (text) => String(text).includes("READY") && done());
		peer.once("exit", (code) => fail(new Error(`folder peer exited ${code}`)));
	});
	const dropIn = "/etc/systemd/system/qorpera-shared-box-folder@.service.d";
	await mkdir(dropIn, { recursive: true });
	const unit = await readFile("/etc/systemd/system/qorpera-shared-box-folder@.service", "utf8");
	const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
	await writeFile(`${dropIn}/fixture.conf`, `[Service]\nExecStart=\n${execStart} --connect unix:/run/fixture/bridge.sock\n`);
	ctl("daemon-reload");

	// What the shared execution service does for a run: the view file, then the box (which pulls in its mount).
	const viewFile = "/run/qorpera-shared-execution/slots/0/box-view.json";
	await writeFile(viewFile, `${JSON.stringify({ environmentId: ENV, viewId, pass })}\n`, { mode: 0o600 });
	ctl("start", "qorpera-shared-box@0.service");
	for (const name of [
		"qorpera-shared-box@0.service",
		"qorpera-shared-box@0.socket",
		"qorpera-shared-box-reads@0.socket",
		"qorpera-shared-box-folder@0.service",
	])
		assert.equal(state(name), "active", name);
	assert(await mounted("/srv/qorpera-folder/box-0"));
	check("the box starts with its socket and its company folder mounted first");

	for (const account of ["qorpera-shared-runner-0", "qorpera-shared-box-0", "qorpera-shared-host-1"]) {
		const stranger = new Client("/run/qorpera-shared-box/0.sock", account);
		const { code, stderr } = await stranger.closed;
		assert.equal(code, 3, account);
		assert.match(stderr, /EACCES/);
	}
	check("only the slot's native host account can open the box socket");

	let client = new Client("/run/qorpera-shared-box/0.sock", "qorpera-shared-host-0");
	assert.deepEqual(await client.ready(), []);
	let reply = await client.sh("id -un; pwd; cat readme.md docs/plan.md; tools/run.sh; findmnt -n -o FSTYPE,OPTIONS /company");
	assert.equal(reply.code, 0, reply.out);
	const [user, cwd, readme, plan, ran, mount] = reply.out.trim().split("\n");
	assert.equal(user, "qorpera-shared-box-0");
	assert.equal(cwd, "/company");
	assert.equal(readme, "hello from the company folder");
	assert.equal(plan, "the plan, version one");
	assert.equal(ran, "ran");
	assert.match(mount, /^fuse(\.qorpera)?\s+ro,.*\ballow_other\b/);
	reply = await client.sh("touch /company/new 2>&1; echo status=$?");
	assert.match(reply.out, /Read-only file system[\s\S]*status=1/);
	check("a command runs as the box account in /company, reads the company folder and cannot write it");

	for (const account of ["qorpera-shared-runner-0", "qorpera-shared-box-0", "qorpera-shared-host-1"]) {
		const stranger = takeReads(account);
		assert.equal(stranger.code, 3, account);
		assert.match(stranger.stderr, /EACCES/);
	}
	let taken = takeReads("qorpera-shared-host-0");
	assert.equal(taken.answer.t, "reads");
	assert.equal(taken.answer.more, false);
	assert.deepEqual(taken.answer.reads.map((read) => read.path).sort(), ["docs/plan.md", "readme.md", "tools/run.sh"]);
	assert(taken.answer.reads.every((read) => read.kind === "file" && read.authority?.resourceRevision === 1));
	assert.deepEqual(takeReads("qorpera-shared-host-0").answer.reads, []);
	await client.sh("ls docs >/dev/null; cat readme.md >/dev/null");
	taken = takeReads("qorpera-shared-host-0");
	assert.deepEqual(taken.answer.reads.map((read) => `${read.kind} ${read.path}`), ["folder docs", "file readme.md"]);
	check("the box's read log names what each command opened or listed, with its receipt, for the slot's native host only");

	// Hidden means absent, or an inaccessible stand-in (mode 0) where InaccessiblePaths= put one.
	reply = await client.sh(
		[
			"for p in /run/qorpera-shared-execution /run/credentials /run/qorpera-shared-box /run/fixture /var/lib/qorpera-shared-execution",
			"/var/lib/qorpera/identities /var/lib/qorpera-bootstrap /etc/qorpera /etc/qorpera-folder /srv/qorpera-folder /opt/qorpera-runner",
			"/opt/qorpera-folder /dev/shm/host-secret; do",
			'if stat "$p" >/dev/null 2>&1 && [ "$(stat -c %a "$p")" != 0 ]; then echo VISIBLE $p; fi; done;',
			"ls -R /opt",
		].join(" "),
	);
	assert.doesNotMatch(reply.out, /VISIBLE/);
	assert.match(reply.out, /\/opt\/qorpera\/shared-execution:\nqorpera-shared-box-host\.mjs\n/);
	reply = await client.sh("grep -rlsI QORPERA-PROBE /run /var /etc /opt /srv /tmp /dev/shm /company /root /home");
	assert.equal(reply.out, "");
	check("no credential, run material, host state, other mount or the host's /dev/shm is visible in the box");

	reply = await client.sh(
		"ls /sys/class/net; (exec 4<>/dev/tcp/127.0.0.1/20000 && cat <&4) 2>&1; echo net=$?; ls /proc/$$/fd; grep -E '^(CapEff|CapBnd|CapAmb|NoNewPrivs)' /proc/self/status; ps -e -o uid= | tr -d ' ' | sort -u",
	);
	assert.match(reply.out, /^lo\n/);
	assert.doesNotMatch(reply.out, /LOOPBACK-REACHED/);
	assert.match(reply.out, /net=1\n0\n1\n2\n/);
	assert.match(reply.out, /CapEff:\s+0+\nCapBnd:\s+0+\nCapAmb:\s+0+\nNoNewPrivs:\s+1\n/);
	assert(reply.out.endsWith(`NoNewPrivs:\t1\n${id("-u", "qorpera-shared-box-0")}\n`), reply.out);
	check("no network (not even the host's loopback), no inherited socket, no capability, only its own processes");

	reply = await client.sh("echo note > $HOME/note && cat $HOME/note; echo shm > /dev/shm/box-probe; df -P /tmp | tail -1");
	assert.match(reply.out, /^note\n/);
	assert.match(reply.out, /^tmpfs\s/m);
	assert.equal(spawnSync("/usr/bin/test", ["-e", "/dev/shm/box-probe"]).status, 1, "the box's /dev/shm is its own");
	check("home and /tmp are the box's own memory, and so is its /dev/shm");

	reply = await client.sh("test -e /sys/fs/cgroup/system.slice && echo HOST_CGROUPS; cat /proc/self/cgroup");
	assert.doesNotMatch(reply.out, /HOST_CGROUPS/);
	assert.match(reply.out, /^0::\/\n?$/m);
	check("the box sees its own control group only");

	// The box's tools, when the image has them (run-box-toolbox-image.Dockerfile), inside the real unit: its system call
	// filter, read-only /var and /run, no network.
	const toolbox = (await client.sh("command -v soffice >/dev/null && echo yes || echo no")).out.trim() === "yes";
	assert(toolbox || process.env.QORPERA_RUN_BOX_REQUIRE_TOOLBOX !== "1", "the image has the box's tools");
	if (toolbox) {
		reply = await client.sh(
			[
				"set -e; cd /tmp;",
				"python3 -c 'import pandas, openpyxl, docx, pypdf; print(\"python\", pandas.DataFrame({\"a\":[1,2]}).a.sum())';",
				"python3 -c 'import openpyxl; w=openpyxl.Workbook(); w.active[\"A1\"]=7; w.save(\"t.xlsx\")';",
				"soffice --headless --convert-to pdf --outdir /tmp /company/readme.md >/dev/null 2>&1; test -s readme.pdf && echo soffice;",
				"pdftotext readme.pdf - | grep -q 'hello from the company folder' && echo pdftotext;",
				"printf '# Title\\n' | pandoc -f markdown -t html | grep -q '<h1' && echo pandoc;",
				"convert -size 4x4 xc:white t.png && file t.png | grep -q PNG && echo convert;",
				"rg -l plan /company | grep -q docs/plan.md && echo rg;",
				"fd -t f plan /company | grep -q plan.md && echo fd;",
				"echo '{\"a\":1}' | jq .a; sqlite3 :memory: 'select 41+1'",
			].join(" "),
		);
		assert.equal(reply.code, 0, reply.out);
		assert.deepEqual(reply.out.trim().split("\n"), ["python 3", "soffice", "pdftotext", "pandoc", "convert", "rg", "fd", "1", "42"]);
		// add_key(2) on x86-64 is 248: the keyring is closed to the box.
		reply = await client.sh(
			"python3 -c 'import ctypes,os; libc=ctypes.CDLL(None,use_errno=True); r=libc.syscall(248,b\"user\",b\"k\",b\"v\",1,-4); print(r, os.strerror(ctypes.get_errno()))'",
		);
		assert.match(reply.out, /^-1 Operation not permitted/);
		check("the box's tools work in the real unit (python with pandas, LibreOffice, pdftotext, pandoc, ImageMagick, rg, fd, jq, sqlite3), and its keyring is closed");
	}

	const started = await client.exec("read -r name; echo hello $name; tty -s && echo has-tty", { tty: true, yieldMs: 500 });
	assert.equal(started.exitCode, null);
	reply = await client.request({ t: "write", session: started.session, chars: "box\n", yieldMs: 5_000 });
	assert.equal(reply.exitCode, 0);
	assert.match(reply.output.head + reply.output.tail, /hello box[\s\S]*has-tty/);
	reply = await client.exec("seq 1 100000", { maxOutputBytes: 1024 });
	assert(reply.output.skippedBytes > 0 && reply.logPath?.startsWith("/tmp/home/output/"));
	assert.match((await client.sh(`tail -n 1 ${reply.logPath}`)).out, /^100000\n$/);
	check("a terminal command takes input, and long output is cut to head and tail with all of it kept in the home");

	// A command can end the box host (it runs as the same account): the next connection gets a fresh one, folder and all.
	await client.exec("kill -KILL $PPID", { yieldMs: 1_000 }).catch(() => undefined);
	await until(async () => state("qorpera-shared-box@0.service") !== "active", "the box host ended");
	const fresh = new Client("/run/qorpera-shared-box/0.sock", "qorpera-shared-host-0");
	assert.deepEqual(await fresh.ready(), []);
	assert.equal((await fresh.sh("cat /company/readme.md")).out, "hello from the company folder\n");
	client = fresh;
	check("a box host a command ended comes back on the next connection, with the folder");

	peer.kill("SIGUSR1");
	await until(async () => (await client.sh("cat /company/docs/plan.md")).out === "the plan, version two\n", "the edit shows");
	check("a member's edit shows in the running box");

	const background = await client.sh("sleep 600 >/dev/null 2>&1 & echo $!");
	const sleeper = background.out.trim();
	const running = await client.exec("sleep 600", { yieldMs: 0 });
	assert.equal(running.exitCode, null);
	client.end();
	// The run ends: the service stops the box, its socket and its folder.
	ctl(
		"stop",
		"qorpera-shared-box@0.service",
		"qorpera-shared-box@0.socket",
		"qorpera-shared-box-reads@0.socket",
		"qorpera-shared-box-folder@0.service",
	);
	for (const name of [
		"qorpera-shared-box@0.service",
		"qorpera-shared-box@0.socket",
		"qorpera-shared-box-reads@0.socket",
		"qorpera-shared-box-folder@0.service",
	])
		assert.notEqual(state(name), "active", name);
	assert.equal(spawnSync("/usr/bin/test", ["-e", "/run/qorpera-shared-box/0.reads"]).status, 1);
	assert.equal(await mounted("/srv/qorpera-folder/box-0"), false);
	assert.equal(spawnSync("/usr/bin/test", ["-e", "/run/qorpera-shared-box/0.sock"]).status, 1);
	assert.equal(spawnSync("/usr/bin/kill", ["-0", sleeper]).status, 1, "a background command ended with the run");
	check("the run's end stops every command, removes the socket and unmounts the folder");

	ctl("start", "qorpera-shared-box@0.service");
	const again = new Client("/run/qorpera-shared-box/0.sock", "qorpera-shared-host-0");
	assert.deepEqual(await again.ready(), []);
	assert.match((await again.sh("test -e $HOME/note; echo note=$?; cat /company/readme.md")).out, /^note=1\nhello from/);
	again.end();
	ctl(
		"stop",
		"qorpera-shared-box@0.service",
		"qorpera-shared-box@0.socket",
		"qorpera-shared-box-reads@0.socket",
		"qorpera-shared-box-folder@0.service",
	);
	check("the next run's box starts empty");

	await writeFile(viewFile, `${JSON.stringify({ environmentId: ENV, viewId: randomUUID(), pass })}\n`, { mode: 0o600 });
	const refusedAt = Date.now();
	assert.notEqual(run("/usr/bin/systemctl", ["start", "qorpera-shared-box@0.service"]).status, 0);
	assert(Date.now() - refusedAt < 15_000, `a refused view fails the start promptly (${Date.now() - refusedAt} ms)`);
	assert.notEqual(state("qorpera-shared-box@0.service"), "active");
	assert.equal(await mounted("/srv/qorpera-folder/box-0"), false);
	ctl("stop", "qorpera-shared-box@0.socket", "qorpera-shared-box-reads@0.socket");
	check("a view the node refuses starts no box");

	console.log(
		`RUN_BOX_SYSTEMD_PROOF=${JSON.stringify({
			schema: "qorpera.run-box-systemd-proof/v1",
			node: process.version,
			systemd: ok("/usr/bin/systemctl", ["--version"]).split("\n")[0],
			checks,
			actualSystemd: true,
			actualFuse: true,
			folderService: "repository code, core in memory",
			toolbox,
			realNode: false,
		})}`,
	);
} finally {
	peer?.kill("SIGTERM");
	loopback.close();
}
