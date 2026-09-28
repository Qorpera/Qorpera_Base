import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createOfficeCombinedControl } from "./test-runtime-office-combined-control.mjs";

// Explicit local Linux proof. No provider APIs, production paths or host home
// mounts. Set QORPERA_OFFICE_TEST_IMAGE to an already prepared test image.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "qorpera-office-linux-"));
const rebuild = process.argv.slice(2).includes("--combined-rebuild");
const combined = rebuild || process.argv.slice(2).includes("--combined");
const guest = combined || process.argv.slice(2).includes("--guest");
const boundary = process.argv.slice(2).includes("--boundary");
const privateSurface = guest || boundary || process.argv.slice(2).includes("--private");
const browser = privateSurface || process.argv.slice(2).includes("--browser");
const desktop = browser || process.argv.slice(2).includes("--desktop");
// The long-running shell alone: its namespace, relay and namespace entry file.
const shell = process.argv.slice(2).includes("--shell");
if (process.argv.slice(2).some((arg) => !["--desktop", "--browser", "--private", "--guest", "--boundary", "--combined", "--combined-rebuild", "--shell"].includes(arg))) throw new Error("Unsupported Linux proof mode");
if (shell && process.argv.length !== 3) throw new Error("The shell proof runs alone");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE || `qorpera-office-linux-test:step4-${browser ? "browser" : desktop ? "desktop" : shell ? "shell" : "commands"}`;
if (!/^[a-zA-Z0-9_./:@-]+$/.test(image)) throw new Error("Invalid local test image reference");
let runningImage = image;
let combinedControl;
const base = "ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b";
const container = `qorpera-office-probe-${randomUUID()}`;
const boundaryVolume = `qorpera-office-boundary-${randomUUID()}`;
const screenEventsVolume = `qorpera-office-screen-events-${randomUUID()}`;
const canonicalVolume = `qorpera-office-canonical-${randomUUID()}`;
const stop = new AbortController();
const interrupted = () => stop.abort();
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
async function run(args, rpc = false) {
	await new Promise((resolveRun, reject) => {
		const child = spawn("docker", args, { stdio: rpc ? ["pipe", "pipe", "inherit"] : "inherit", signal: stop.signal });
		if (rpc) {
			let buffer = "";
			child.stdout.on("data", bytes => {
				buffer += bytes;
				if (buffer.length > 8*1024*1024) { child.kill(); reject(new Error("Combined proof output limit")); return; }
				let newline;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newline); buffer = buffer.slice(newline+1);
					if (!line.startsWith('{"rpc":')) { console.log(line); continue; }
					const request = JSON.parse(line);
					try { child.stdin.write(`${JSON.stringify({id:request.id,value:combinedControl.rpc(request.rpc,request.args)})}\n`); }
					catch (error) { child.stdin.write(`${JSON.stringify({id:request.id,error:error.message})}\n`); }
				}
			});
			child.stdin.on("error", reject);
		}
		child.once("error", reject);
		child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`docker failed (${code ?? signal})`)));
	});
}
try {
	if (!process.env.QORPERA_OFFICE_TEST_IMAGE) {
		await writeFile(join(root, "Dockerfile"), `FROM ${base}\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs bubblewrap tini xvfb xdotool scrot x11-xserver-utils xauth${shell ? " curl ca-certificates iproute2 nftables iputils-ping" : ""}${desktop ? " tigervnc-standalone-server xfce4-session xfwm4 xfdesktop4 xfconf xfce4-panel xfce4-terminal thunar dbus-x11 x11-utils procps" : ""}${browser ? " curl ca-certificates unzip libnss3 libasound2t64 libgbm1 libcups2t64" : ""} && rm -rf /var/lib/apt/lists/*\n${browser ? `RUN case "$(dpkg --print-architecture)" in arm64) browser_url=https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip; browser_dir=chrome-linux;; amd64) browser_url=https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-linux64.zip; browser_dir=chrome-linux64;; *) exit 1;; esac && curl --fail --location --retry 2 "$browser_url" -o /tmp/chromium.zip && unzip -q /tmp/chromium.zip -d /usr/lib && mv "/usr/lib/$browser_dir" /usr/lib/qorpera-chromium && rm /tmp/chromium.zip\n` : ""}`);
		await run(["build", "--tag", image, root]);
	}
	if (desktop) {
		await mkdir(join(root, "artifacts"));
		await chmod(join(root, "artifacts"), 0o777);
		for (const name of ["qorpera-screen-session", "qorpera-screen-xfce", "qorpera-screen-browser"])
			await copyFile(join(repository, "deploy/lxd-company-computer-guest", name), join(root, name));
		await copyFile(join(repository, "deploy/lxd-company-computer-guest/backdrops/qorpera-screen-pebble.png"), join(root, "wallpaper.png"));
		// The wallpaper follows the agent's avatar, so every creature must be there.
		{
			await mkdir(join(root, "wallpapers"));
			for (const name of await readdir(join(repository, "deploy/lxd-company-computer-guest/backdrops"))) {
				if (!/^qorpera-screen-[a-z]+(?:-(?:[01][0-9]|2[0-3]))?\.png$/.test(name)) throw new Error("Invalid fixture creature artifact");
				await copyFile(join(repository, "deploy/lxd-company-computer-guest/backdrops", name), join(root, "wallpapers", name));
			}
		}
		if (browser) await copyFile(join(repository, "deploy/lxd-company-computer-guest/qorpera-browser-policy.json"), join(root, "browser-policy.json"));
		// Every desktop runs the namespace entry file for its Terminal's proxy.
		await build({ absWorkingDir: repository, entryPoints: ["packages/runtime/src/cloud-company-computer-browser-child.ts"],
			outfile: join(root, "office-browser-child.mjs"), platform: "node", format: "esm", target: "node22.19", bundle: true });
		await writeFile(join(root, "Dockerfile"), `FROM ${image}\nCOPY --chmod=0555 qorpera-screen-session qorpera-screen-xfce qorpera-screen-browser /usr/local/bin/\nCOPY wallpaper.png /usr/share/backgrounds/qorpera-screen-pebble.png\nCOPY --chmod=0444 wallpapers/ /usr/share/backgrounds/\nRUN mkdir -p /usr/local/share/qorpera /usr/local/lib/qorpera && chmod 0755 /usr/local/share/qorpera /usr/local/lib/qorpera\nCOPY --chmod=0555 office-browser-child.mjs /usr/local/lib/qorpera/office-browser-child.mjs\n${browser ? "RUN install -m 0555 /usr/bin/bwrap /usr/local/lib/qorpera/qorpera-browser-bwrap\nCOPY --chmod=0444 browser-policy.json /usr/local/share/qorpera/browser-policy.json\n" : ""}`);
		runningImage = `qorpera-office-desktop-probe:${randomUUID()}`;
		await run(["build", "--tag", runningImage, root]);
	}
	if (shell) {
		await build({ absWorkingDir: repository, entryPoints: ["packages/runtime/src/cloud-company-computer-browser-child.ts"],
			outfile: join(root, "office-browser-child.mjs"), platform: "node", format: "esm", target: "node22.19", bundle: true });
		// The image's network pieces exactly as packaged: the firewall and the root plumber.
		await copyFile(join(repository, "deploy/lxd-company-computer-guest/qorpera-computer-network.nft"), join(root, "computer-network.nft"));
		await copyFile(join(repository, "deploy/lxd-company-computer-guest/qorpera-computer-plumb"), join(root, "qorpera-computer-plumb"));
		await writeFile(join(root, "Dockerfile"), `FROM ${image}\nRUN mkdir -p /usr/local/lib/qorpera /usr/local/share/qorpera && chmod 0755 /usr/local/lib/qorpera /usr/local/share/qorpera\nCOPY --chmod=0444 office-browser-child.mjs /usr/local/lib/qorpera/office-browser-child.mjs\nCOPY --chmod=0555 qorpera-computer-plumb /usr/local/lib/qorpera/qorpera-computer-plumb\nCOPY --chmod=0444 computer-network.nft /usr/local/share/qorpera/computer-network.nft\n`);
		// Stand-ins, as root in the container: systemd's socket activation of the
		// plumber (one script per connection), and hosts behind the machine.
		await writeFile(join(root, "plumb-socket.mjs"), `import { spawn } from "node:child_process";
import { chownSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
mkdirSync("/run/qorpera-computer-network", { recursive: true, mode: 0o755 });
const server = createServer((socket) => {
	const plumb = spawn("/usr/local/lib/qorpera/qorpera-computer-plumb", [], { env: { QORPERA_OFFICE_USER: process.argv[2] }, stdio: ["pipe", "pipe", "inherit"] });
	socket.pipe(plumb.stdin);
	plumb.stdout.pipe(socket);
	socket.on("error", () => plumb.kill());
});
server.listen("/run/qorpera-computer-network/plumb.sock", () => {
	chownSync("/run/qorpera-computer-network/plumb.sock", 1000, 1000);
	console.log("plumber listening");
});
`);
		await writeFile(join(root, "stand-in.mjs"), `import { createSocket } from "node:dgram";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
const name = process.argv[2];
// High ports: the container keeps no right to bind low ones.
createHttp((request, response) => response.end(name + ":" + request.url)).listen(8080, "0.0.0.0");
createServer((socket) => {
	// A client may hang up as soon as it has read enough.
	socket.on("error", () => undefined);
	socket.end("SSH-2.0-" + name + "\\r\\n");
}).listen(2222, "0.0.0.0");
const udp = createSocket("udp4");
udp.on("message", (message, from) => udp.send(Buffer.concat([Buffer.from(name + ":"), message]), from.port, from.address));
// Answers from the host's own address, as a real server does, so the reply matches.
udp.bind(5353, process.argv[3]);
`);
		runningImage = `qorpera-office-shell-probe:${randomUUID()}`;
		await run(["build", "--tag", runningImage, root]);
	}
	if (browser) {
		await mkdir(join(root, "node_modules"));
		await cp(join(repository, "node_modules/playwright-core"), join(root, "node_modules/playwright-core"), { recursive: true });
	}
	await build({ absWorkingDir: repository, entryPoints: [combined ? "packages/runtime/test/fixtures/company-computer-linux-combined-probe.mjs" : `packages/runtime/test/fixtures/company-computer-linux-${boundary ? "boundary-" : guest ? "guest-" : privateSurface ? "private-" : browser ? "browser-" : desktop ? "desktop-" : shell ? "shell-" : ""}probe.ts`],
		outfile: join(root, "probe.mjs"), platform: "node", format: "esm", target: "node22.19", bundle: true, external: browser ? ["playwright-core"] : [],
		...(combined ? {banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'},
			plugins:[{name:"disposable-browser-content",setup(builder) {
				// Intercept only page content in this test bundle. The unmodified
				// production launch, namespace, browser control and input code run.
				builder.onLoad({filter:/\/cloud-company-computer-linux-browser\.ts$/},async ({path}) => {
					const source = await readFile(path,"utf8");
					const anchor = "return { context: contexts[0], close };";
					if (source.split(anchor).length !== 2) throw new Error("Browser fixture anchor changed");
					const body = '<!doctype html><title>Office reconciliation</title><label>First total<input aria-label="First total"></label><label>Second total<input aria-label="Second total"></label><button onclick="document.querySelector(\'output\').textContent=Number(document.querySelectorAll(\'input\')[0].value)+Number(document.querySelectorAll(\'input\')[1].value)">Reconcile</button><output>Pending</output>';
					return {contents:source.replace(anchor,`await contexts[0].route("https://office.example/**", route => route.fulfill({contentType:"text/html",body:${JSON.stringify(body)}}));\n${anchor}`),loader:"ts"};
				});
			}}]} : {}) });
	if (combined) {
		const cert = spawnSync("openssl", ["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(root,"key.pem"),"-out",join(root,"cert.pem"),"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"], {encoding:"utf8",timeout:15000});
		if (cert.status !== 0) throw new Error(cert.stderr);
		await chmod(join(root,"key.pem"),0o644);
		combinedControl = await createOfficeCombinedControl(repository,{rebuild});
		await writeFile(join(root,"combined-setup.json"),JSON.stringify(combinedControl.setup));
	}
	await writeFile(join(root, "start.sh"), `#!/bin/sh
set -eu
mkdir -p /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/.X11-unix /tmp/office-x
chmod 700 /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/office-x
chown 1000:1000 /srv/workbench /srv/desktop /srv/screens /srv/profiles /tmp/office-x
${guest ? `mkdir -m 700 /srv/.qorpera-adopted-00000000-0000-4000-8000-000000000072
for office_fixture_part in workbench desktop screens profiles; do
mkdir -m 700 /srv/.qorpera-adopted-00000000-0000-4000-8000-000000000072/$office_fixture_part
chown 1000:1000 /srv/.qorpera-adopted-00000000-0000-4000-8000-000000000072/$office_fixture_part
done
chown 1000:1000 /srv/.qorpera-adopted-00000000-0000-4000-8000-000000000072
chmod 700 /srv
chown 1000:1000 /srv
chmod 700 /var/lib/qorpera-office-events
chown 1000:1000 /var/lib/qorpera-office-events` : ""}
chmod 1777 /tmp/.X11-unix
${combined ? `mkdir -p /var/lib/qorpera-proof-canonical
chmod 700 /var/lib/qorpera-proof-canonical
chown 1000:1000 /var/lib/qorpera-proof-canonical` : ""}
dpkg-query -W nodejs bubblewrap tini xvfb xdotool scrot
${desktop ? "dpkg-query -W tigervnc-standalone-server xfce4-session xfwm4 xfdesktop4" : ""}
${browser ? "/usr/lib/qorpera-chromium/chrome --version" : ""}
${boundary ? "node /opt/probe/probe.mjs --prepare" : ""}
${shell ? `# The machine: the computers' firewall, a public and a private host behind it, the plumber.
nft -f /usr/local/share/qorpera/computer-network.nft
sysctl -q -w net.ipv4.ip_forward=1
ip link set lo up
for side in pub:1:93.184.216.34 priv:5:10.9.9.9; do
	netns=\${side%%:*}; rest=\${side#*:}; low=\${rest%%:*}; address=\${rest#*:}
	ip netns add "\$netns"
	ip link add "\${netns}net" type veth peer name eth0 netns "\$netns"
	ip addr add "192.0.2.\$low/30" dev "\${netns}net"
	ip link set "\${netns}net" up
	ip -n "\$netns" link set lo up
	ip -n "\$netns" addr add "192.0.2.\$((low + 1))/30" dev eth0
	ip -n "\$netns" link set eth0 up
	ip -n "\$netns" addr add "\$address/32" dev lo
	ip -n "\$netns" route add default via "192.0.2.\$low"
	ip route add "\$address/32" via "192.0.2.\$((low + 1))"
done
ip -n priv addr add 169.254.169.254/32 dev lo
ip route add 169.254.169.254/32 via 192.0.2.6
ip netns exec pub node /opt/probe/stand-in.mjs public 93.184.216.34 &
ip netns exec priv node /opt/probe/stand-in.mjs private 10.9.9.9 &
node /opt/probe/plumb-socket.mjs "$(getent passwd 1000 | cut -d: -f1)" &
sleep 1
` : ""}exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all node /opt/probe/probe.mjs
`);
	// Docker's default seccomp and proc masks block nested user/PID namespaces.
	// The outer container permits that setup; the real bwrap boundary then runs
	// as uid 1000 with no capabilities, no network, and finite cgroup ceilings.
	const guestArgs = ["run", ...(combined ? ["-i"] : []), "--rm", "--name", container, "--network", "none", "--read-only", "--memory", browser ? "2g" : desktop ? "1g" : shell ? "640m" : "512m", "--memory-swap", browser ? "2g" : desktop ? "1g" : shell ? "640m" : "512m",
		"--pids-limit", browser ? "512" : desktop || shell ? "256" : "128", "--cpus", desktop ? "2" : "1", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP",
		// The shell proof's root plumber and machine firewall; the probe itself drops them.
		...(shell ? ["--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_PTRACE", "--security-opt", "apparmor=unconfined",
			"--tmpfs", "/run/netns:rw,nosuid,nodev,size=1m,mode=755", "--tmpfs", "/run/qorpera-computer-network:rw,nosuid,nodev,size=1m,mode=755"] : []),
		// Root attester reads uid-1000 private mounts; setpriv drops this before the broker probe.
		...(boundary ? ["--cap-add", "DAC_READ_SEARCH"] : []),
		"--security-opt", "no-new-privileges", "--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined",
		"--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
		...(boundary ? ["--mount", `type=volume,source=${boundaryVolume},target=/srv`] : ["--tmpfs", "/srv:rw,nosuid,nodev,size=128m,mode=755"]),
		"--tmpfs", "/run/office-captures:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700",
		"--tmpfs", "/run/office-screens:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700",
		...(browser ? ["--tmpfs", "/run/office-browser:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700"] : []),
		...(privateSurface ? ["--tmpfs", "/run/office-private-workbench:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700"] : []),
		...(boundary ? ["--tmpfs", "/run/office-attestation:rw,nosuid,nodev,noexec,size=1m,mode=755"] : []),
		...(desktop ? ["--mount", `type=bind,source=${join(root, "artifacts")},target=/opt/probe-artifacts`] : []),
		...(guest ? ["--mount", `type=volume,source=${screenEventsVolume},target=/var/lib/qorpera-office-events`] : []),
		...(combined ? ["--mount", `type=volume,source=${canonicalVolume},target=/var/lib/qorpera-proof-canonical`] : []),
		"--mount", `type=bind,source=${root},target=/opt/probe,readonly`, runningImage, "sh", "/opt/probe/start.sh"];
	await run(guestArgs,combined);
	if (rebuild) {
		const deadline = Date.now()+5000;
		for (;;) {
			const remaining = spawnSync("docker",["ps","-aq","--filter",`name=^/${container}$`],{encoding:"utf8",timeout:5000});
			if (remaining.status !== 0) throw new Error(`Guest removal query failed: ${remaining.stderr}`);
			if (!remaining.stdout.trim()) break;
			if (Date.now() >= deadline) throw new Error(`Prior guest removal not confirmed: ${remaining.stdout.trim()}`);
			await new Promise(resolve=>setTimeout(resolve,100));
		}
		const next = await combinedControl.prepareRebuild();
		await writeFile(join(root,"combined-setup.json"),JSON.stringify(next));
		// New container and empty /srv tmpfs: neither old desktops nor old
		// workbench bytes survive. Only the separate canonical volume persists.
		await run(guestArgs,combined);
	}
	if (combined) combinedControl.verify();
	if (desktop && !boundary && !combined && process.env.QORPERA_OFFICE_TEST_OUTPUT) {
		const output = resolve(process.env.QORPERA_OFFICE_TEST_OUTPUT);
		await mkdir(output, { recursive: true, mode: 0o700 });
		for (const name of guest ? ["guest.png"] : privateSurface ? ["private.png"] : browser ? ["desktop.png", "browser.png"] : ["desktop.png"]) {
			const source = join(root, "artifacts", name);
			const info = await lstat(source);
			if (!info.isFile() || info.nlink !== 1 || info.size > 16777216) throw new Error("Invalid office proof image");
			await writeFile(join(output, name), await readFile(source), { flag: "wx", mode: 0o600 });
		}
	}
} finally {
	combinedControl?.close();
	// Only this invocation's unique disposable container, including interrupted runs.
	spawnSync("docker", ["rm", "--force", container], { stdio: "ignore", timeout: 10000 });
	if (boundary) spawnSync("docker", ["volume", "rm", boundaryVolume], { stdio: "ignore", timeout: 10000 });
	if (guest) spawnSync("docker", ["volume", "rm", screenEventsVolume], { stdio: "ignore", timeout: 10000 });
	if (combined) spawnSync("docker", ["volume", "rm", canonicalVolume], { stdio: "ignore", timeout: 10000 });
	if (runningImage !== image) spawnSync("docker", ["image", "rm", runningImage], { stdio: "ignore", timeout: 10000 });
	process.removeListener("SIGINT", interrupted);
	process.removeListener("SIGTERM", interrupted);
	await rm(root, { recursive: true, force: true });
}
