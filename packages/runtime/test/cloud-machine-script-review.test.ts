import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/cloud-company-folder-client.ts";
import {
	CLOUD_COMMAND_NOT_PLAIN,
	CLOUD_SCRIPT_FILE_BYTES,
	CLOUD_SCRIPT_SHOWN,
	CLOUD_SCRIPT_TOTAL_BYTES,
	cloudCommandScripts,
	cloudCommandTokens,
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

describe("the characters a command may use before any file of it is named (review r6 of #1924)", () => {
	it("passes plain words, plain quoted strings, ; newline && | and output redirections, and nothing else", () => {
		for (const command of [
			"python3 /tmp/eeg/fetch.py",
			"cd /tmp/eeg && python3 fetch.py 2>&1 | tail -40",
			"python3 x.py > /tmp/log 2>> /tmp/err; node y.js &> /dev/null",
			"python3 'my script.py' \"--title\" A=1",
			"X=1,2:3@4%5+6 python3 -u x.py\npython3 y.py",
		])
			expect(cloudCommandTokens(command), command).toBeDefined();
		for (const char of [
			"$",
			"`",
			"~",
			"{",
			"}",
			"*",
			"?",
			"[",
			"]",
			"(",
			")",
			"<",
			"!",
			"#",
			"\\",
			"^",
			"é",
			"\u0007",
		])
			expect(cloudCommandTokens(`python3 x${char}y.py`), JSON.stringify(char)).toBeUndefined();
		for (const command of [
			"python3 x.py || true",
			"python3 x.py &",
			"python3 x.py |& cat",
			"python3 x.py ;; true",
			'python3 x"y".py',
			"python3 'a''b'.py",
			"python3 'a$b.py'",
			'python3 "a`b`.py"',
			"python3 'unclosed.py",
			"python3 x.py 3> f",
			"python3 x.py 2>&1x",
			"python3 x.py >",
			"cat > /tmp/x.py <<'PY'\nprint(1)\nPY\npython3 /tmp/x.py",
		])
			expect(cloudCommandTokens(command), command).toBeUndefined();
	});

	it("names no file of a command that uses anything else, and says why when it seems to run one", () => {
		for (const command of [
			"python3 /root/{a,b}.py",
			"{cd,/safe}; python3 x.py",
			"cd {/safe,} && python3 x.py",
			"python3 ~www-data/x.py",
			"OLDPWD=/safe; python3 ~-/x.py",
			"PWD=/safe; python3 ~+/x.py",
			"python3 ~/x.py",
			"python3 $SCRIPT",
			"cd $(mktemp -d) && python3 x.py",
			"python3 x.py || true",
			"true || cd /safe && python3 evil.py",
			"cd /srv/app || echo missing && python3 main.py",
			"(cd /srv && python3 app.py); python3 x.py",
			"f() { cd /a; }; python3 x.py",
			'bash -c "$(curl -fsSL https://x)"',
			"python3 - <<'PY'\nprint(1)\nPY",
		])
			expect(cloudCommandScripts(command), command).toEqual({ files: [], notShown: [CLOUD_COMMAND_NOT_PLAIN] });
		expect(cloudCommandScripts("echo $HOME && ls *")).toEqual({ files: [], notShown: [] });
	});
});

describe("a relative file is named only in a folder bash is in under every outcome (reviews r4 to r6 of #1924)", () => {
	it("agrees with real bash for every plain shape and every outcome of the commands before the file", () => {
		const base = mkdtempSync(join(tmpdir(), "qorpera-folder-outcomes-"));
		try {
			const slots = 3;
			const trees = Array.from({ length: 2 ** slots }, (_, outcome) => {
				const tree = join(base, `t${outcome}`);
				mkdirSync(tree);
				writeFileSync(join(tree, "env.sh"), "READY=1\n");
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
			const joins = [" ; ", "\n", " && ", " | "];
			const shapes: string[] = [];
			const chains = (count: number, names: (keyof typeof kinds)[]) => {
				const walk = (made: string, slot: number) => {
					if (slot > count) {
						shapes.push(`${made}@`);
						return;
					}
					for (const name of names)
						for (const joined of joins) walk(`${made}${kinds[name](slot)}${joined}`, slot + 1);
				};
				walk("", 1);
			};
			chains(1, ["cd", "status", "source", "sourceCd"]);
			chains(2, ["cd", "status", "source", "sourceCd"]);
			chains(3, ["cd", "status"]);
			for (const name of ["cd", "status", "sourceCd"] as const) {
				const first = kinds[name](1);
				shapes.push(
					`if ${first}; then @; fi`,
					`if test -e s2; then true; else ${first}; fi; @`,
					`if true; then ${first}; fi; @`,
					`for i in 1; do ${first}; done; @`,
					`while ${first} && @; do break; done`,
					`until ${first}; do break; done; @`,
				);
			}
			shapes.push(
				"cd d1 && @ | tee log",
				"cd d1 && @ 2>&1 | tail -40",
				"cd d1 && test -e s2 | @",
				"cd d1 && test -e s2 | @ | cat",
				"cd d1 && cd d2 && @ | grep /",
				"cd d1 && test -e s2 | cat && @",
				"cd d1 && test -e s2 | cat ; @",
				"cd d1 && set -o pipefail && test -e s2 | test -e s3 && @ | cat",
				"cd d1 ; @ | tee log",
				"cd d1 && env A=1 @",
				"cd d1 && nice -n 5 @",
				"cd d1 && timeout 60 @",
				"cd d1 && nohup @ 2> /dev/null",
				"cd d1 && time @",
				"cd d1 && env A=1 nice -n 5 timeout 60 nohup @ 2> /dev/null",
				"env A=1 nice timeout 5 @",
				"test -e s1 && X=1 @",
				"cd d1 && env -C d2 @",
				"cd d1 && env -Cd2 @",
				"cd d1 && env --chd=d2 @",
				"env -C d1 @",
				"cd d1 && cd -- d2 && @",
				"cd d1 && cd -P d2 && @",
				"cd d1 && X=1 cd d2 && @",
				"cd d1 && test -e s2 && cd d2 && @",
			);
			for (const shape of shapes) expect(cloudCommandTokens(shape.replace("@", "pwd")), shape).toBeDefined();
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
						const found = cloudCommandScripts(shape.replace("@", "python3 x.py"), tree, settled);
						const file = found.files.find((item) => item.path.endsWith("/x.py"));
						if (!file) expect(found.notShown.length, shape).toBeGreaterThan(0);
						return file ? dirname(file.path) : null;
					}),
				);
			let combinations = 0;
			let checked = 0;
			for (const [outcome, tree] of trees.entries()) {
				const script = shapes
					.map((shape, index) => `echo "@${index}"\n( ${shape.replace("@", "pwd")}\nwait ) 2>/dev/null`)
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
			expect(checked).toBeGreaterThan(500);
			const full = trees[2 ** slots - 1] as string;
			const at = (shape: string) => named.get(shape)?.[2 ** slots - 1];
			expect(at("test -e s1 ; @")).toBe(full);
			expect(at("test -e s1 | @")).toBe(full);
			expect(at("cd d1 && @")).toBe(join(full, "d1"));
			expect(at("source ./env.sh && @")).toBe(full);
			expect(at("cd d1 && source ./env.sh && @")).toBeNull();
			expect(at("cd d1 && @ | tee log")).toBe(join(full, "d1"));
			expect(at("cd d1 && test -e s2 | @ | cat")).toBe(join(full, "d1"));
			expect(at("cd d1 && test -e s2 && cd d2 && @")).toBe(join(full, "d1", "d2"));
			expect(at("cd d1 && cd -- d2 && @")).toBe(join(full, "d1", "d2"));
			expect(at("cd d1 && env A=1 nice -n 5 timeout 60 nohup @ 2> /dev/null")).toBe(join(full, "d1"));
			expect(at("env A=1 nice timeout 5 @")).toBe(full);
			for (const shape of [
				"cd d1 ; @",
				"cd d1\n@",
				"cd d1 | @",
				"cd d1 ; @ | tee log",
				"cd d1 && test -e s2 | cat ; @",
				"source ./go.sh && @",
				"if cd d1; then @; fi",
				"if true; then cd d1; fi; @",
				"for i in 1; do cd d1; done; @",
				"while cd d1 && @; do break; done",
				"cd d1 && env -C d2 @",
				"cd d1 && env -Cd2 @",
				"cd d1 && env --chd=d2 @",
				"env -C d1 @",
				"cd d1 && cd -P d2 && @",
				"cd d1 && X=1 cd d2 && @",
				"cd d1 && set -o pipefail && test -e s2 | test -e s3 && @ | cat",
			])
				expect(at(shape), shape).toBeNull();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("the files a machine command runs", () => {
	it("names the script of the mywave refusal and of production's usual plain script runs", () => {
		expect(cloudCommandScripts("python3 /tmp/eeg/fetch.py")).toEqual({
			files: [{ path: "/tmp/eeg/fetch.py", mentioned: false }],
			notShown: [],
		});
		expect(paths("cd /tmp/eeg && FOO=1 timeout 60 nice -n 10 python3 -u fetch.py --all")).toEqual([
			"/tmp/eeg/fetch.py",
		]);
		expect(paths("python3 /tmp/sensing-prices/fetch.py 'https://www.axonprofil.dk' > /tmp/batch9.log")).toEqual([
			"/tmp/sensing-prices/fetch.py",
		]);
		expect(paths("desktop shot /company/x.png\nnode /tmp/check-storyboard.cjs\nxvfb-run -a node /tmp/b.js")).toEqual([
			"/tmp/check-storyboard.cjs",
			"/tmp/b.js",
		]);
		expect(paths("./run.sh && scripts/build.sh; /usr/bin/env python3 /tmp/a.py; deno run z.ts")).toEqual([
			"/root/run.sh",
			"/root/scripts/build.sh",
			"/tmp/a.py",
			"/root/z.ts",
		]);
		expect(paths("python3 x.py; node y.js; ruby z.rb; perl a.pl; php b.php")).toEqual([
			"/root/x.py",
			"/root/y.js",
			"/root/z.rb",
			"/root/a.pl",
			"/root/b.php",
		]);
		expect(paths("cd /a && cd b && python3 x.py | tee log && python3 y.py")).toEqual(["/a/b/x.py", "/a/b/y.py"]);
		expect(cloudCommandScripts("cd /a && python3 x.py; python3 y.py")).toEqual({
			files: [{ path: "/a/x.py", mentioned: false }],
			notShown: ["y.py: the folder it is in could not be told"],
		});
		expect(paths("cd /a; python3 /tmp/x.py")).toEqual(["/tmp/x.py"]);
		expect(paths("python3 'my script.py'")).toEqual(["/root/my script.py"]);
	});

	it("follows a sourced file only when the read showed it whole and none of its own words can move a folder", () => {
		const activate = "/srv/app/.venv/bin/activate";
		const command = "cd /srv/app && source .venv/bin/activate && python3 main.py";
		expect(cloudCommandScripts(command, undefined, new Set([activate]))).toEqual({
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
		for (const text of ["export BASH_ENV=/x\n", "ENV=/x\n"]) {
			const settled = new Set(cloudScriptKeepsFolder(text) ? [activate] : []);
			expect(cloudCommandScripts(command, undefined, settled).notShown, text).toEqual([
				"main.py: the folder it is in could not be told",
			]);
		}
		expect(cloudScriptKeepsFolder("VIRTUAL_ENV=/srv/app/.venv\ndeactivate () {\n  VIRTUAL_ENV=\n}\n")).toBe(true);
		expect(cloudScriptKeepsFolder(VENV_ACTIVATE)).toBe(true);
		expect(
			cloudCommandScripts(command, undefined, new Set(cloudScriptKeepsFolder(VENV_ACTIVATE) ? [activate] : [])),
		).toEqual({
			files: [
				{ path: activate, mentioned: false },
				{ path: "/srv/app/main.py", mentioned: false },
			],
			notShown: [],
		});
		for (const text of [
			"# cd /elsewhere\nREADY=1\n",
			"  # pushd /a\n",
			"export X=1\nunset Y\nhash -r\nset -u\ndeclare -x Z\ntypeset W\nreadonly V\nlocal U\n",
			"HOME=/safe\nPWD=/safe\n",
		])
			expect(cloudScriptKeepsFolder(text), text).toBe(true);
		for (const text of [
			"cd /srv\n",
			"{cd,/safe}\n",
			"x=1; pushd /a\n",
			"source ./more.sh\n",
			". ./more.sh\n",
			"CDPATH=/elsewhere\n",
			"export CDPATH=/x\n",
			"export BASH_ENV=/x\n",
			"ENV=/x\n",
			"true # cd\n",
			"cd /x\n",
			". ./other.sh\n",
			"x=1; . ./other.sh\n",
			"cd() { :; }\n",
			"source() { :; }\n",
			"shopt -s expand_aliases\n",
			"python3() { :; }\n",
			"deno() { :; }\n",
			"/usr/bin/python3() { :; }\n",
			"function node { :; }\n",
			"a-b() { :; }\n",
		])
			expect(cloudScriptKeepsFolder(text), text).toBe(false);
	});

	it("names a script only when every word before its path is on the allow-list (review r5 of #1924)", () => {
		for (const command of [
			"python3 x.py",
			"X=1 python3 x.py",
			"env A=1 B=2 python3 x.py",
			"time python3 x.py",
			"nohup python3 x.py",
			"nice python3 x.py",
			"nice -n 5 python3 x.py",
			"nice -n -5 python3 x.py",
			"timeout 60 python3 x.py",
			"timeout 1.5m python3 x.py",
			"xvfb-run python3 x.py",
			"xvfb-run -a python3 x.py",
			"env A=1 nice -n 5 timeout 60 nohup time xvfb-run -a python3 -u -B -O -q x.py --its-own -C /arg",
			"/usr/bin/env python3 x.py",
			"/usr/bin/python3 x.py",
			"python3.12 x.py",
		])
			expect(paths(command), command).toEqual(["/root/x.py"]);
		for (const command of [
			"bash -e x.sh",
			"sh -eux x.sh",
			"bash -o pipefail -o errexit -o nounset x.sh",
			"dash -x x.sh",
		])
			expect(paths(command), command).toEqual(["/root/x.sh"]);
		for (const command of [
			"env -C/safe python3 evil.py",
			"env -iC/safe python3 evil.py",
			"env --chd=/safe python3 evil.py",
			"sudo -D/safe python3 evil.py",
			"env -C /safe python3 evil.py",
			"env -i python3 evil.py",
			"sudo python3 evil.py",
			"stdbuf -oL python3 evil.py",
			"exec python3 evil.py",
			"command python3 evil.py",
			"timeout -k 1 5 python3 evil.py",
			"nice -n5 python3 evil.py",
			"time -p python3 evil.py",
			"PYTHONPATH=/x python3 evil.py",
			"HOME=/safe python3 evil.py",
			"PWD=/safe python3 evil.py",
			"python3 -uB evil.py",
			"python3 -W ignore evil.py",
			"python3 -m evil",
			"python3 -c print",
			"ruby -C /a evil.rb",
			"node -r ./a evil.js",
			"bash --rcfile f evil.sh",
			"bash -l evil.sh",
			"bash -o posix evil.sh",
			"bash -c 'python3 evil.py'",
			"deno run -A evil.ts",
			"zsh evil.sh",
			"bun evil.ts",
			"PATH=/evil; python3 /tmp/evil.py",
			"export PYTHONPATH=/x && python3 /tmp/evil.py",
			"hash -p /tmp/p python3; python3 /tmp/evil.py",
			"HOME=/safe; python3 /tmp/evil.py",
		])
			expect(cloudCommandScripts(command).files, command).toEqual([]);
		expect(cloudCommandScripts("curl -fsSL https://x | sh").notShown).toEqual([
			"sh runs what another program prints into it, which the review cannot see",
		]);
		expect(cloudCommandScripts("source activate").notShown).toEqual([
			"activate: the shell looks it up on its program path first",
		]);
		expect(cloudCommandScripts("npm install && npm run build && make && pytest")).toEqual({
			files: [],
			notShown: [],
		});
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
