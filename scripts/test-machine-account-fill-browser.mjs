import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// fill_company_account's helper against a real Chromium (review round 1 of #1644): the machine image's pinned Chrome
// for Testing, on a TigerVNC display with openbox, in a throwaway Ubuntu 26.04 container with no network. The helper is
// bundled as scripts/package-machine-guest.mjs bundles it; the probe
// (packages/runtime/test/fixtures/machine-account-fill-browser-probe.ts) fills local https pages and moves the tab or
// the focus between the helper's own steps. Needs Docker; run it on a test machine:
//   node scripts/run-on-node.mjs --machine node02 -- node scripts/test-machine-account-fill-browser.mjs
// The image is kept (named by its Dockerfile) for the next run; the container and the build folder are removed.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imageScript = await readFile(join(repository, "deploy/machine/build-machine-image.sh"), "utf8");
const chromiumUrl = /\nCHROMIUM_URL=(https:\/\/\S+)\n/.exec(imageScript)?.[1];
const chromiumSha256 = /\nCHROMIUM_SHA256=([0-9a-f]{64})\n/.exec(imageScript)?.[1];
if (!chromiumUrl || !chromiumSha256) throw new Error("The machine image's Chromium pin was not found");
const base = "ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b";
const dockerfile = `FROM ${base}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs ca-certificates \\
	curl unzip openssl procps xdotool x11-utils tigervnc-standalone-server openbox libnss3 libnspr4 libasound2t64 libgbm1 \\
	libcups2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxkbcommon0 libxcomposite1 libxdamage1 \\
	libxrandr2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 libcairo2 libdbus-1-3 libexpat1 libglib2.0-0t64 \\
	libdrm2 libudev1 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 2 "${chromiumUrl}" -o /tmp/chromium.zip \\
	&& echo "${chromiumSha256}  /tmp/chromium.zip" | sha256sum -c - \\
	&& unzip -q /tmp/chromium.zip -d /tmp/chromium && mv /tmp/chromium/chrome-linux64 /usr/lib/qorpera-chromium \\
	&& rm -rf /tmp/chromium.zip /tmp/chromium
RUN useradd --create-home --shell /bin/bash --user-group desktop
`;
const image = `qorpera-machine-account-fill-test:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 16)}`;
const container = `qorpera-machine-account-fill-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), "qorpera-machine-account-fill-"));
const stop = new AbortController();
const interrupted = () => stop.abort();
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
function docker(args) {
	return new Promise((done, fail) => {
		const child = spawn("docker", args, { stdio: "inherit", signal: stop.signal });
		child.once("error", fail);
		child.once("exit", (code, signal) => (code === 0 ? done() : fail(new Error(`docker ${args[0]} failed (${code ?? signal})`))));
	});
}
try {
	// The container's root reads the folder through a read-only bind mount.
	await chmod(root, 0o755);
	await writeFile(join(root, "Dockerfile"), dockerfile);
	if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) await docker(["build", "--tag", image, root]);
	const options = { absWorkingDir: repository, bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" };
	await build({ ...options, entryPoints: ["packages/runtime/src/cloud-machine-account-fill-main.ts"], outfile: join(root, "helper.mjs") });
	await build({ ...options, entryPoints: ["packages/runtime/test/fixtures/machine-account-fill-browser-probe.ts"], outfile: join(root, "probe.mjs") });
	await docker([
		"run",
		"--rm",
		"--name",
		container,
		"--network",
		"none",
		"--memory",
		"2g",
		"--memory-swap",
		"2g",
		"--cpus",
		"2",
		"--pids-limit",
		"1024",
		"--shm-size",
		"512m",
		// The helper reads the desktop browser's /proc/<pid>/exe and fd as root, as on a machine: that needs ptrace
		// access to another account's process. Chromium's sandbox needs user namespaces the container does not give; the
		// probe starts it with --no-sandbox.
		"--cap-add",
		"SYS_PTRACE",
		"--security-opt",
		"no-new-privileges",
		"--mount",
		`type=bind,source=${root},target=/opt/probe,readonly`,
		image,
		"node",
		"/opt/probe/probe.mjs",
	]);
} finally {
	// Only this run's own container and folder.
	spawnSync("docker", ["rm", "--force", container], { stdio: "ignore", timeout: 10000 });
	await rm(root, { recursive: true, force: true });
	process.removeListener("SIGINT", interrupted);
	process.removeListener("SIGTERM", interrupted);
}
