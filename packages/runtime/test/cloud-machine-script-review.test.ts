import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	cloudScriptKeepsFolder,
	cloudScriptReadProgram,
	parseCloudPreparedScripts,
	parseCloudScriptRead,
} from "../src/cloud-machine-script-review.ts";

const digest = (text: string) => sha256(Buffer.from(text));
const paths = (command: string) => cloudCommandScripts(command).files.map((file) => file.path);

const VENV_ACTIVATE = `# This file must be used with "source bin/activate" *from bash*
# You cannot run it directly

deactivate () {
    # reset old environment variables
    if [ -n "\${_OLD_VIRTUAL_PATH:-}" ] ; then
        PATH="\${_OLD_VIRTUAL_PATH:-}"
        export PATH
        unset _OLD_VIRTUAL_PATH
    fi
    if [ -n "\${_OLD_VIRTUAL_PYTHONHOME:-}" ] ; then
        PYTHONHOME="\${_OLD_VIRTUAL_PYTHONHOME:-}"
        export PYTHONHOME
        unset _OLD_VIRTUAL_PYTHONHOME
    fi

    # Call hash to forget past locations. Without forgetting
    # past locations the $PATH changes we made may not be respected.
    # See "man bash" for more details. hash is usually a builtin of your shell
    hash -r 2> /dev/null

    if [ -n "\${_OLD_VIRTUAL_PS1:-}" ] ; then
        PS1="\${_OLD_VIRTUAL_PS1:-}"
        export PS1
        unset _OLD_VIRTUAL_PS1
    fi

    unset VIRTUAL_ENV
    unset VIRTUAL_ENV_PROMPT
    if [ ! "\${1:-}" = "nondestructive" ] ; then
    # Self destruct!
        unset -f deactivate
    fi
}

# unset irrelevant variables
deactivate nondestructive

# on Windows, a path can contain colons and backslashes and has to be converted:
case "$(uname)" in
    CYGWIN*|MSYS*|MINGW*)
        # transform D:\\path\\to\\venv to /d/path/to/venv on MSYS and MINGW
        # and to /cygdrive/d/path/to/venv on Cygwin
        VIRTUAL_ENV=$(cygpath /srv/app/.venv)
        export VIRTUAL_ENV
        ;;
    *)
        # use the path as-is
        export VIRTUAL_ENV=/srv/app/.venv
        ;;
esac

_OLD_VIRTUAL_PATH="$PATH"
PATH="$VIRTUAL_ENV/"bin":$PATH"
export PATH

VIRTUAL_ENV_PROMPT=v
export VIRTUAL_ENV_PROMPT

# unset PYTHONHOME if set
# this will fail if PYTHONHOME is set to the empty string (which is bad anyway)
# could use \`if (set -u; : $PYTHONHOME) ;\` in bash
if [ -n "\${PYTHONHOME:-}" ] ; then
    _OLD_VIRTUAL_PYTHONHOME="\${PYTHONHOME:-}"
    unset PYTHONHOME
fi

if [ -z "\${VIRTUAL_ENV_DISABLE_PROMPT:-}" ] ; then
    _OLD_VIRTUAL_PS1="\${PS1:-}"
    PS1="("v") \${PS1:-}"
    export PS1
fi

# Call hash to forget past commands. Without forgetting
# past commands the $PATH changes we made may not be respected
hash -r 2> /dev/null
`;

describe("a relative file is named only in a folder bash is in under every outcome (review r4 of #1924)", () => {
	it("agrees with real bash for every shape and every outcome of the commands before the file", () => {
		const base = mkdtempSync(join(tmpdir(), "qorpera-folder-outcomes-"));
		try {
			const slots = 3;
			const trees = Array.from({ length: 2 ** slots }, (_, outcome) => {
				const tree = join(base, `t${outcome}`);
				mkdirSync(tree);
				writeFileSync(join(tree, "env.sh"), "export READY=1\n");
				writeFileSync(join(tree, "go.sh"), "cd d1\n");
				for (let slot = 0; slot < slots; slot += 1)
					if (outcome & (1 << slot)) {
						mkdirSync(join(tree, `d${slot + 1}`));
						writeFileSync(join(tree, `s${slot + 1}`), "");
					}
				return tree;
			});
			const kinds = {
				cd: (slot: number) => `cd d${slot}`,
				status: (slot: number) => `test -e s${slot}`,
				source: () => "source ./env.sh",
				sourceCd: () => "source ./go.sh",
			};
			const joins = [" ; ", "\n", " && ", " || ", " | ", " & "];
			const shapes: string[] = [];
			const chains = (count: number, names: (keyof typeof kinds)[], joinSet: string[]) => {
				const walk = (made: string, slot: number) => {
					if (slot > count) {
						shapes.push(made);
						return;
					}
					for (const name of names)
						for (const joined of joinSet) walk(`${made}${kinds[name](slot)}${joined}`, slot + 1);
				};
				walk("", 1);
			};
			chains(1, ["cd", "status", "source", "sourceCd"], joins);
			chains(2, ["cd", "status", "source", "sourceCd"], joins);
			chains(3, ["cd", "status"], [" ; ", " && ", " || ", " | "]);
			for (const name of ["cd", "status", "sourceCd"] as const) {
				const first = kinds[name](1);
				shapes.push(
					`( ${first} ); `,
					`{ ${first}; }; `,
					`if ${first}; then `,
					`if true; then ${first}; fi; `,
					`for i in 1; do ${first}; done; `,
					`! ${first} && `,
					`! ${first}; `,
					`cd d1 && ( ${first} ) && `,
				);
			}
			const line = (shape: string, next: string) =>
				shape.startsWith("if ") && shape.endsWith("then ") ? `${shape}${next}; fi` : `${shape}${next}`;
			const named = new Map<string, Array<string | null>>();
			for (const shape of shapes)
				named.set(
					shape,
					trees.map((tree) => {
						const settled = new Set(
							[join(tree, "env.sh"), join(tree, "go.sh")].filter((file) =>
								cloudScriptKeepsFolder(readFileSync(file, "utf8")),
							),
						);
						const found = cloudCommandScripts(line(shape, "python3 x.py"), tree, false, settled);
						const file = found.files.find((item) => item.path.endsWith("/x.py"));
						if (!file) expect(found.notShown, shape).toContain("x.py: the folder it is in could not be told");
						return file ? dirname(file.path) : null;
					}),
				);
			let combinations = 0;
			let checked = 0;
			for (const [outcome, tree] of trees.entries()) {
				const script = shapes
					.map((shape, index) => `echo "@${index}"\n( ${line(shape, "pwd")}\nwait ) 2>/dev/null`)
					.join("\n");
				const output = spawnSync("bash", ["-c", script], {
					cwd: tree,
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024,
				}).stdout;
				const ran = new Map<number, string>();
				let current = -1;
				for (const printed of output.split("\n")) {
					const mark = /^@(\d+)$/.exec(printed);
					if (mark) current = Number(mark[1]);
					else if (printed.startsWith("/") && current >= 0) ran.set(current, printed);
				}
				for (const [index, shape] of shapes.entries()) {
					combinations += 1;
					const folder = named.get(shape)?.[outcome] ?? null;
					const where = ran.get(index);
					if (folder === null || where === undefined) continue;
					checked += 1;
					expect(where, `${JSON.stringify(shape)} in outcome ${outcome}`).toBe(folder);
				}
			}
			expect(combinations).toBe(shapes.length * trees.length);
			expect(checked).toBeGreaterThan(1000);
			const full = trees[2 ** slots - 1] as string;
			const at = (shape: string) => named.get(shape)?.[2 ** slots - 1];
			expect(at("test -e s1 ; ")).toBe(full);
			expect(at("test -e s1 || ")).toBe(full);
			expect(at("cd d1 && ")).toBe(join(full, "d1"));
			expect(at("source ./env.sh && ")).toBe(full);
			for (const joined of [" ; ", "\n", " || ", " | ", " & "]) expect(at(`cd d1${joined}`), joined).toBeNull();
			for (const shape of [
				"test -e s1 || cd d2 && ",
				"cd d1 || test -e s2 && ",
				"( cd d1 ); ",
				"{ cd d1; }; ",
				"! cd d1 && ",
				"source ./go.sh && ",
				"cd d1 && ( cd d1 ) && ",
			])
				expect(at(shape), shape).toBeNull();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

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

	it("names a relative file only where its folder is certain by construction (review r4 of #1924)", () => {
		const unknown = (file: string) => `${file}: the folder it is in could not be told`;
		expect(paths("python3 fetch.py; node b.js")).toEqual(["/root/fetch.py", "/root/b.js"]);
		expect(paths("set -euo pipefail; python3 fetch.py")).toEqual(["/root/fetch.py"]);
		expect(paths("cd /tmp/eeg && timeout 60 python3 fetch.py && node b.js")).toEqual([
			"/tmp/eeg/fetch.py",
			"/tmp/eeg/b.js",
		]);
		expect(paths("cd /a && cd b && python3 x.py")).toEqual(["/a/b/x.py"]);
		expect(paths("cd /x && bash -c 'python3 y.py'")).toEqual(["/x/y.py"]);
		for (const command of [
			"true || cd /safe && python3 x.py",
			"cd /srv/app || echo missing && python3 x.py",
			"cd /a; python3 x.py",
			"cd /a\npython3 x.py",
			"cd /a || python3 x.py",
			"cd /a | python3 x.py",
			"cd /a & python3 x.py",
			"cd /a && (python3 x.py)",
			"cd /a && { python3 x.py; }",
			"cd /a && ! python3 x.py",
			"cd /a && python3 x.py | tee log",
			"cd /a && python3 x.py &",
			"cd /a && if true; then python3 x.py; fi",
			"true && cd /a && python3 x.py",
			"cd -P /a && python3 x.py",
			'cd "$D" && python3 x.py',
			"cd - && python3 x.py",
			"cd /a && cd /b; python3 x.py",
			"command -v python3 && python3 x.py",
			"f() { true; }; python3 x.py",
			"env -C /a python3 x.py",
			"export CDPATH=/srv; python3 x.py",
			"echo $(cd /b) && python3 x.py",
			"bash -c 'cd /b' && python3 x.py",
			"bash <<'EOF'\ncd /b\nEOF\npython3 x.py",
			"eval true; python3 x.py",
			"pushd /a; python3 x.py",
			"trap 'cd /b' DEBUG; python3 x.py",
			"x=1 case y; $CMD /a; python3 x.py",
		])
			expect(cloudCommandScripts(command).notShown, command).toContain(unknown("x.py"));
		expect(cloudCommandScripts("true || cd /safe && python3 evil.py")).toEqual({
			files: [],
			notShown: [unknown("evil.py")],
		});
		expect(cloudCommandScripts("cd /srv/app || echo missing && python3 main.py")).toEqual({
			files: [],
			notShown: [unknown("main.py")],
		});
		expect(paths("cd /a; python3 /tmp/x.py")).toEqual(["/tmp/x.py"]);
	});

	it("follows a sourced file only when the review read it whole and nothing in it can move a folder", () => {
		const activate = "/srv/app/.venv/bin/activate";
		const command = "cd /srv/app && source .venv/bin/activate && python3 main.py";
		expect(cloudScriptKeepsFolder(VENV_ACTIVATE)).toBe(true);
		expect(cloudCommandScripts(command, undefined, false, new Set([activate]))).toEqual({
			files: [
				{ path: activate, mentioned: false },
				{ path: "/srv/app/main.py", mentioned: false },
			],
			notShown: [],
		});
		expect(cloudCommandScripts(command)).toEqual({
			files: [{ path: activate, mentioned: false }],
			notShown: ["main.py: the folder it is in could not be told"],
		});
		expect(
			cloudCommandScripts(command.replace(" && python3", "; python3"), undefined, false, new Set([activate])),
		).toEqual({
			files: [{ path: activate, mentioned: false }],
			notShown: ["main.py: the folder it is in could not be told"],
		});
		for (const text of [
			"cd /srv\n",
			"x=1; pushd /a\n",
			"source ./more.sh\n",
			". ./more.sh\n",
			'eval "$X"\n',
			'"$TOOL" run\n',
			"export CDPATH=/elsewhere\n",
			"shopt -s expand_aliases\nalias cd='cd /x'\n",
			"shopt -s lastpipe\n",
		])
			expect(cloudScriptKeepsFolder(text), text).toBe(false);
		expect(cloudCommandScripts("source ./env.sh && cd app && python3 x.py").notShown).toEqual([
			"./env.sh: the folder it is in could not be told",
			"x.py: the folder it is in could not be told",
		]);
	});

	it("skips a shell's own option values, such as its startup file", () => {
		expect(paths("bash --rcfile /root/f x.sh; bash --init-file /root/f y.sh")).toEqual(["/root/x.sh", "/root/y.sh"]);
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
