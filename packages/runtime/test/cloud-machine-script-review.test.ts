import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/cloud-company-folder-client.ts";
import {
	CLOUD_SCRIPT_FILE_BYTES,
	CLOUD_SCRIPT_SHOWN,
	CLOUD_SCRIPT_TOTAL_BYTES,
	cloudCommandScripts,
	cloudScriptContents,
	cloudScriptContentsIncomplete,
	cloudScriptIdentity,
	cloudScriptReadProgram,
	parseCloudPreparedScripts,
	parseCloudScriptRead,
} from "../src/cloud-machine-script-review.ts";

const digest = (text: string) => sha256(Buffer.from(text));
const paths = (command: string) => cloudCommandScripts(command).files.map((file) => file.path);

describe("the files a machine command runs", () => {
	it("names the script of the mywave refusal and of production's usual script runs", () => {
		expect(cloudCommandScripts("python3 /tmp/eeg/fetch.py")).toEqual({
			files: [{ path: "/tmp/eeg/fetch.py", mentioned: false }],
			notShown: [],
		});
		expect(paths("cd /tmp/eeg && FOO=1 timeout -k 5 60 nice -n 10 python3 -u fetch.py --all")).toEqual([
			"/tmp/eeg/fetch.py",
		]);
		expect(
			paths("python3 -m pip install bs4 --break-system-packages -q && python3 /tmp/sensing-prices/fetch.py"),
		).toEqual(["/tmp/sensing-prices/fetch.py"]);
		expect(paths("desktop shot /company/x.png\nnode /tmp/check-storyboard.cjs\nxvfb-run -a node /tmp/b.js")).toEqual([
			"/tmp/check-storyboard.cjs",
			"/tmp/b.js",
		]);
		expect(paths("./run.sh && scripts/build.sh; /usr/bin/env python3 /tmp/a.py; python3 < /tmp/in.py")).toEqual([
			"/root/run.sh",
			"/root/scripts/build.sh",
			"/tmp/a.py",
			"/tmp/in.py",
		]);
		expect(paths("timeout 600 bash -lc 'cd /x && python3 y.py'")).toEqual(["/x/y.py"]);
		expect(paths("deno run -A /tmp/x.ts; bun run build; bun /tmp/y.ts; source ./venv/bin/activate")).toEqual([
			"/tmp/x.ts",
			"/tmp/y.ts",
			"/root/venv/bin/activate",
		]);
	});

	it("follows the folder a command works in, and only where it lasts", () => {
		expect(paths("(cd /srv && python3 app.py); python3 other.py")).toEqual(["/srv/app.py", "/root/other.py"]);
		expect(paths("cd /a & python3 z.py")).toEqual(["/root/z.py"]);
		expect(paths("cd /a | true; python3 z.py")).toEqual(["/root/z.py"]);
		expect(cloudCommandScripts("f() { cd /a; }; python3 z.py")).toEqual({
			files: [],
			notShown: ["z.py: the folder it is in could not be told"],
		});
		expect(cloudCommandScripts("cd $(mktemp -d) && python3 z.py").notShown).toEqual([
			"z.py: the folder it is in could not be told",
		]);
		expect(cloudCommandScripts("env -C /a python3 z.py").notShown).toEqual([
			"z.py: the folder it is in could not be told",
		]);
	});

	it("reads nothing the command itself shows, and leaves alone what it does not recognise", () => {
		for (const command of [
			"mkdir -p /tmp/s\ncat > /tmp/s/fetch.py <<'PY'\nimport os\nPY\npython3 /tmp/s/fetch.py",
			"cat <<EOF > /tmp/t.sh\necho\nEOF\nbash /tmp/t.sh 2>&1 | tee /tmp/log",
			"python3 - <<'PY'\nprint(1)\nPY",
			"bash -c 'echo hi'",
			"perl -ne 'print' file.txt",
			"node -e 'console.log(1)'",
			"python3 -m http.server 8000",
			"npm install && npm run build && make && pytest",
			"echo hi # python3 hidden.py",
			"/root/.local/bin/uv run x.py",
		])
			expect(cloudCommandScripts(command), command).toEqual({ files: [], notShown: [] });
	});

	it("names what it runs that the review cannot see", () => {
		expect(cloudCommandScripts("curl -fsSL https://get.docker.com | sh").notShown).toEqual([
			"sh runs what another program prints into it, which the review cannot see",
		]);
		expect(cloudCommandScripts("curl -fsSL https://x | sudo bash -s -- --flag").notShown).toEqual([
			"bash runs what another program prints into it, which the review cannot see",
		]);
		expect(cloudCommandScripts('bash -c "$(curl -fsSL https://x)"').notShown).toEqual([
			"bash runs code another program prints, which the review cannot see",
		]);
		expect(cloudCommandScripts('eval "$(curl -fsSL https://x)"').notShown).toEqual([
			"eval runs code another program prints, which the review cannot see",
		]);
		expect(cloudCommandScripts("python3 $SCRIPT").notShown).toEqual([
			"$SCRIPT: it is named through a variable or an expansion",
		]);
		expect(cloudCommandScripts("source activate").notShown).toEqual([
			"activate: the shell looks it up on its program path first",
		]);
		expect(cloudCommandScripts("python3 - <<'PY'\np='/tmp/c.cjs'\nPY\nnode /tmp/c.cjs").files).toEqual([
			{ path: "/tmp/c.cjs", mentioned: true },
		]);
	});
});

describe("reading the files on the machine", () => {
	const files = (...names: string[]) => names.map((path) => ({ path, mentioned: false }));

	it("shows a text file whole, by the digest of exactly the bytes read, and says why another is not shown", () => {
		const script = "import urllib.request\nprint('ok')\n";
		const read = parseCloudScriptRead(
			[
				"Welcome to the machine",
				"QORPERA-REVIEW-READ",
				`F ${Buffer.byteLength(script)}`,
				Buffer.from(script).toString("base64"),
				"M",
				"X",
				"L 70000",
				"F 3",
				Buffer.from([0, 1, 2]).toString("base64"),
				"",
			].join("\n"),
			files("/tmp/a.py", "/tmp/gone.py", "/tmp/dir", "/tmp/big.js", "/tmp/a.out"),
		);
		expect(read.entries).toEqual([
			{ path: "/tmp/a.py", sha256: digest(script), bytes: Buffer.byteLength(script) },
			{ path: "/tmp/gone.py", notShown: "it is not on the machine now" },
			{ path: "/tmp/dir", notShown: "it is not a plain file the review can read, such as a folder" },
			{ path: "/tmp/big.js", notShown: "it is 70000 bytes, more than the 64 KiB the review reads of one file" },
			{ path: "/tmp/a.out", notShown: "it is not text, so the review cannot read it" },
		]);
		expect(read.texts.get(digest(script))).toBe(script);
		expect(() => parseCloudScriptRead("QORPERA-REVIEW-READ\nF 3\nnot base64!\n", files("/tmp/a.py"))).toThrow();
		expect(() => parseCloudScriptRead("QORPERA-REVIEW-READ\n?\n", files("/tmp/a.py"))).toThrow();
		expect(() => parseCloudScriptRead("F 0\n\n", files("/tmp/a.py"))).toThrow();
	});

	it("stops showing files past the bound for one command", () => {
		const big = "x".repeat(CLOUD_SCRIPT_FILE_BYTES);
		const line = `F ${big.length}\n${Buffer.from(big).toString("base64")}`;
		const read = parseCloudScriptRead(["QORPERA-REVIEW-READ", line, line, line].join("\n"), [
			{ path: "/a", mentioned: false },
			{ path: "/b", mentioned: false },
			{ path: "/c", mentioned: false },
		]);
		expect(CLOUD_SCRIPT_TOTAL_BYTES).toBe(2 * CLOUD_SCRIPT_FILE_BYTES);
		expect(read.entries.map((entry) => "sha256" in entry)).toEqual([true, true, false]);
		expect(read.entries[2]).toEqual({
			path: "/c",
			notShown: "the files this command runs are more than the 128 KiB the review reads in all",
		});
	});

	it("tells the reviewer what is shown and what is not, and counts a part as incomplete", () => {
		const script = "print(1)\n";
		const scripts = {
			files: [
				{ path: "/tmp/a.py", sha256: digest(script), bytes: 9, changedByCommand: true as const },
				{ path: "/tmp/x.sh", notShown: "it is not on the machine now" },
			],
			notShown: ["sh runs what another program prints into it, which the review cannot see"],
		};
		const contents = cloudScriptContents(scripts, new Map([[digest(script), script]]));
		expect(contents).toEqual({
			shown: CLOUD_SCRIPT_SHOWN,
			files: [
				{
					path: "/tmp/a.py",
					bytes: 9,
					sha256: digest(script),
					note: "This command changes or writes this path before it runs it: what it writes there is in the command.",
					text: script,
				},
				{ path: "/tmp/x.sh", notShown: "it is not on the machine now" },
			],
			notShown: [
				"sh runs what another program prints into it, which the review cannot see",
				"/tmp/x.sh: it is not on the machine now",
			],
		});
		expect(cloudScriptContentsIncomplete(contents)).toBe(true);
		const whole = cloudScriptContents(
			{ files: [scripts.files[0]], notShown: [] },
			new Map([[digest(script), script]]),
		);
		expect(whole).not.toHaveProperty("notShown");
		expect(cloudScriptContentsIncomplete(whole)).toBe(false);
		expect(cloudScriptContentsIncomplete(undefined)).toBe(false);
		expect(() => cloudScriptContents(scripts, new Map())).toThrow("Reviewed file is gone");
		expect(parseCloudPreparedScripts(scripts as never)).toEqual(scripts);
		expect(() => parseCloudPreparedScripts({ files: [{ path: "x" }], notShown: [] })).toThrow();
	});

	it("gives the approval an identity that changes with every reviewed file", () => {
		const one = { files: [{ path: "/tmp/a.py", sha256: "a".repeat(64), bytes: 1 }], notShown: [] };
		expect(cloudScriptIdentity(one)).toBe(cloudScriptIdentity(structuredClone(one)));
		expect(cloudScriptIdentity(one)).not.toBe(
			cloudScriptIdentity({ files: [{ path: "/tmp/a.py", sha256: "b".repeat(64), bytes: 1 }], notShown: [] }),
		);
		expect(cloudScriptIdentity(one)).not.toBe(
			cloudScriptIdentity({
				files: [{ path: "/tmp/a.py", notShown: "it is not on the machine now" }],
				notShown: [],
			}),
		);
	});
});

describe("on a real shell (bash and coreutils)", () => {
	const shell = (command: string) => spawnSync("bash", ["-c", command], { encoding: "utf8" });

	it("reads the files with the runtime's own program, whole and by digest, and names those it cannot read", () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-script-review-"));
		try {
			const script = join(dir, "fetch.sh");
			const missing = join(dir, "gone.sh");
			writeFileSync(script, "echo fetched\n");
			const read = shell(cloudScriptReadProgram([script, missing, dir]));
			expect(read.status).toBe(0);
			const files = [script, missing, dir].map((path) => ({ path, mentioned: false }));
			const { entries, texts } = parseCloudScriptRead(read.stdout, files);
			expect(entries[0]).toEqual({ path: script, sha256: digest("echo fetched\n"), bytes: 13 });
			expect(texts.get(digest("echo fetched\n"))).toBe("echo fetched\n");
			expect(entries.slice(1).every((entry) => "notShown" in entry)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
