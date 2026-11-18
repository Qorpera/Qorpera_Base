import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/cloud-company-folder-client.ts";
import {
	CLOUD_COMMAND_NOT_PLAIN,
	CLOUD_SCRIPT_LATER,
	CLOUD_SCRIPT_SHOWN,
	cloudCommandScripts,
	cloudCommandTokens,
	cloudScriptContents,
	cloudScriptContentsIncomplete,
	cloudScriptIdentity,
	cloudScriptReadProgram,
	parseCloudPreparedScripts,
	parseCloudScriptRead,
} from "../src/cloud-machine-script-review.ts";

const digest = (text: string) => sha256(Buffer.from(text));
const later = (word: string) => `${word}: ${CLOUD_SCRIPT_LATER}`;
const paths = (command: string) => cloudCommandScripts(command).files.map((file) => file.path);

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

describe("a file is named only for the first command after leading cds, in the folder bash is in under every outcome (reviews r4 to r8 of #1924)", () => {
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
				"cd d1 && nice -n 5 timeout 60 nohup @ 2> /dev/null",
				"env A=1 nice timeout 5 @",
				"nice timeout 5 @",
				"cd d1 && @ | tee",
				"cd d1 && @ > /dev/null | cat",
				"cd d1 && @ > out",
				"cd d1 2> err && @",
				"test -e s1 && X=1 @",
				"cd d1 && env -C d2 @",
				"cd d1 && env -Cd2 @",
				"cd d1 && env --chd=d2 @",
				"env -C d1 @",
				"cd d1 && cd -- d2 && @",
				"cd d1 && cd -P d2 && @",
				"cd d1 && X=1 cd d2 && @",
				"cd d1 && test -e s2 && cd d2 && @",
				"cd d1 && @ ; cd d2",
				"cd d1 && cd d2 && @ && cd d3",
				"cd d1 && @ | cd d2",
				"cd d1 && cd d2 ; @",
				"printf -v CDPATH /tmp && cd d1 && @",
				"printf -v PATH /tmp && cd d1 && @",
				"eval cd d2 && cd d1 && @",
				"builtin cd d2 && cd d1 && @",
				"true && cd d1 && @",
			);
			for (const shape of shapes) expect(cloudCommandTokens(shape.replace("@", "pwd")), shape).toBeDefined();
			const named = new Map<string, Array<string | null>>();
			for (const shape of shapes)
				named.set(
					shape,
					trees.map((tree) => {
						const found = cloudCommandScripts(shape.replace("@", "python3 x.py"), tree);
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
			expect(checked).toBeGreaterThan(25);
			const full = trees[2 ** slots - 1] as string;
			const at = (shape: string) => named.get(shape)?.[2 ** slots - 1];
			expect(at("cd d1 && @")).toBe(join(full, "d1"));
			expect(at("cd d1 && cd d2 && @")).toBe(join(full, "d1", "d2"));
			expect(at("cd d1 && cd d2 && cd d3 && @")).toBe(join(full, "d1", "d2", "d3"));
			expect(at("cd d1 && @ | tee")).toBe(join(full, "d1"));
			expect(at("cd d1 && @ 2>&1 | tail -40")).toBe(join(full, "d1"));
			expect(at("cd d1 && @ ; cd d2")).toBe(join(full, "d1"));
			expect(at("cd d1 && cd d2 && @ && cd d3")).toBe(join(full, "d1", "d2"));
			expect(at("cd d1 && nice -n 5 timeout 60 nohup @ 2> /dev/null")).toBe(join(full, "d1"));
			expect(at("nice timeout 5 @")).toBe(full);
			for (const shape of [
				"cd d1 ; @",
				"cd d1\n@",
				"cd d1 | @",
				"cd d1 ; @ | tee log",
				"cd d1 && cd d2 ; @",
				"cd d1 && @ | tee log",
				"cd d1 && @ > out",
				"cd d1 2> err && @",
				"cd d1 && env A=1 @",
				"cd d1 && env A=1 nice -n 5 timeout 60 nohup @ 2> /dev/null",
				"env A=1 nice timeout 5 @",
				"test -e s1 ; @",
				"test -e s1 | @",
				"test -e s1 && X=1 @",
				"cd d1 && test -e s2 | @ | cat",
				"cd d1 && test -e s2 && cd d2 && @",
				"cd d1 && test -e s2 | cat ; @",
				"source ./env.sh && @",
				"cd d1 && source ./env.sh && @",
				"source ./go.sh && @",
				"if cd d1; then @; fi",
				"if true; then cd d1; fi; @",
				"for i in 1; do cd d1; done; @",
				"while cd d1 && @; do break; done",
				"cd d1 && env -C d2 @",
				"cd d1 && env -Cd2 @",
				"cd d1 && env --chd=d2 @",
				"env -C d1 @",
				"cd d1 && cd -- d2 && @",
				"cd d1 && cd -P d2 && @",
				"cd d1 && X=1 cd d2 && @",
				"cd d1 && set -o pipefail && test -e s2 | test -e s3 && @ | cat",
				"printf -v CDPATH /tmp && cd d1 && @",
				"printf -v PATH /tmp && cd d1 && @",
				"eval cd d2 && cd d1 && @",
				"builtin cd d2 && cd d1 && @",
				"true && cd d1 && @",
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
			files: [{ path: "/tmp/eeg/fetch.py" }],
			notShown: [],
		});
		expect(paths("cd /tmp/eeg && timeout 60 nice -n 10 python3 -u fetch.py --all")).toEqual(["/tmp/eeg/fetch.py"]);
		expect(paths("python3 /tmp/sensing-prices/fetch.py 'https://www.axonprofil.dk' > /dev/null 2>&1")).toEqual([
			"/tmp/sensing-prices/fetch.py",
		]);
		expect(cloudCommandScripts("cd /a && python3 x.py 2>&1 | tail -40; echo done")).toEqual({
			files: [{ path: "/a/x.py" }],
			notShown: [],
		});
		expect(paths("./run.sh --all")).toEqual(["/root/run.sh"]);
		expect(paths("cd /a && scripts/build.sh")).toEqual(["/a/scripts/build.sh"]);
		expect(paths("/usr/bin/python3 /tmp/a.py")).toEqual(["/tmp/a.py"]);
		expect(paths("deno run z.ts")).toEqual(["/root/z.ts"]);
		expect(paths("python3 'my script.py'")).toEqual(["/root/my script.py"]);
		for (const [command, file] of [
			["python3 x.py", "/root/x.py"],
			["node y.js", "/root/y.js"],
			["ruby z.rb", "/root/z.rb"],
			["perl a.pl", "/root/a.pl"],
			["php b.php", "/root/b.php"],
		])
			expect(paths(command as string), command).toEqual([file]);
	});

	it("names only the first command's file: a later script, or one after any other command, is not shown (review r8 of #1924)", () => {
		expect(cloudCommandScripts("python3 /a/x.py && python3 /a/y.py")).toEqual({
			files: [{ path: "/a/x.py" }],
			notShown: [later("/a/y.py")],
		});
		expect(cloudCommandScripts("cd /a && cd b && python3 x.py | tail -5 && python3 y.py; ./run.sh | sh")).toEqual({
			files: [{ path: "/a/b/x.py" }],
			notShown: [
				later("y.py"),
				later("./run.sh"),
				"sh runs what another program prints into it, which the review cannot see",
			],
		});
		expect(
			cloudCommandScripts("desktop shot /company/x.png\nnode /tmp/check-storyboard.cjs\nxvfb-run -a node /tmp/b.js"),
		).toEqual({
			files: [],
			notShown: [later("/tmp/check-storyboard.cjs"), later("/tmp/b.js")],
		});
		for (const command of [
			"mkdir -p out && python3 x.py",
			"pip install -r requirements.txt && python3 x.py",
			"cd /a ; python3 x.py",
			"cd /a\npython3 x.py",
			"cd /a | python3 x.py",
		])
			expect(cloudCommandScripts(command), command).toEqual({ files: [], notShown: [later("x.py")] });
		for (const [command, first] of [
			["builtin source /a/env.sh && python3 /a/x.py", "builtin"],
			["command . /a/env.sh && python3 /a/x.py", "command"],
			["eval source /a/env.sh && python3 /a/x.py", "eval"],
			['eval "source /a/env.sh" && python3 /a/x.py', "eval"],
			['eval "hash -p /tmp/e/p python3" && python3 /a/x.py', "eval"],
			["hash -p /tmp/p python3; python3 /a/x.py", "hash"],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [`${first}: the review does not follow what it runs`, later("/a/x.py")],
			});
		for (const command of [
			'eval "x=1 PATH=/tmp/e" && python3 /a/x.py',
			"printf -v PATH /tmp/e && python3 /a/x.py",
			"read PATH && python3 /a/x.py",
			"mapfile -t PATH && python3 /a/x.py",
			"getopts a PATH && python3 /a/x.py",
			"export PYTHONPATH=/x && python3 /a/x.py",
			"PATH=/evil; python3 /a/x.py",
		])
			expect(cloudCommandScripts(command), command).toEqual({ files: [], notShown: [later("/a/x.py")] });
		expect(cloudCommandScripts("printf -v CDPATH /safe && cd sub && python3 x.py")).toEqual({
			files: [],
			notShown: [later("x.py")],
		});
	});

	it("names no file of a command that sets a variable, writes its output to a file or runs beside anything but a reader (review r9 of #1924)", () => {
		const sets = (word: string) => `${word}: it sets a variable for the command, which can change what runs`;
		for (const [command, word] of [
			["PYTHONUSERBASE=/tmp/e python3 /a/x.py", "PYTHONUSERBASE=/tmp/e"],
			["LD_AUDIT=/tmp/e.so python3 /a/x.py", "LD_AUDIT=/tmp/e.so"],
			["RUBYGEMS_GEMDEPS=/tmp/g ruby /a/x.rb", "RUBYGEMS_GEMDEPS=/tmp/g"],
			["PERLLIB=/tmp/e perl /a/x.pl", "PERLLIB=/tmp/e"],
			["PHP_INI_SCAN_DIR=/tmp/e php /a/x.php", "PHP_INI_SCAN_DIR=/tmp/e"],
			["GCONV_PATH=/tmp/e python3 /a/x.py", "GCONV_PATH=/tmp/e"],
			["PYTHONUNBUFFERED=1 python3 /a/x.py", "PYTHONUNBUFFERED=1"],
			["timeout 60 PYTHONUSERBASE=/tmp/e python3 /a/x.py", "PYTHONUSERBASE=/tmp/e"],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [sets(word as string)],
			});
		for (const command of [
			"env PYTHONUSERBASE=/tmp/e python3 /a/x.py",
			"env LD_AUDIT=/tmp/e.so python3 /a/x.py",
			"env RUBYGEMS_GEMDEPS=/tmp/g ruby /a/x.rb",
			"env PERLLIB=/tmp/e perl /a/x.pl",
			"env PHP_INI_SCAN_DIR=/tmp/e php /a/x.php",
			"env GCONV_PATH=/tmp/e python3 /a/x.py",
			"/usr/bin/env python3 /a/x.py",
		])
			expect(cloudCommandScripts(command), command).toEqual({
				files: [],
				notShown: ["env: the review does not follow what it runs"],
			});
		const writes = (redirect: string) =>
			`${redirect}: the command writes its output to a file, which can change the script as it runs`;
		for (const [command, redirect] of [
			["bash /a/x.sh >> /a/x.sh", ">> /a/x.sh"],
			["bash /a/x.sh > /a/x.sh", "> /a/x.sh"],
			["python3 /a/x.py 2> /a/x.py", "2> /a/x.py"],
			["python3 /a/x.py &> /a/x.py", "&> /a/x.py"],
			["python3 /a/x.py 2>> /a/x.py", "2>> /a/x.py"],
			["python3 /a/x.py > /tmp/log 2>&1", "> /tmp/log"],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [writes(redirect as string)],
			});
		const beside = (peer: string) => `${peer}: it runs beside the script, and the review does not follow it`;
		for (const [command, peer] of [
			["bash /a/x.sh | tee -a /a/x.sh", "tee -a /a/x.sh"],
			["bash /a/x.sh | tee /a/x.sh", "tee /a/x.sh"],
			["python3 /a/x.py | cp /tmp/e.py /a/x.py", "cp /tmp/e.py /a/x.py"],
			["python3 /a/x.py | sort -o /a/x.py", "sort -o /a/x.py"],
			["python3 /a/x.py | sort -no /a/x.py", "sort -no /a/x.py"],
			["python3 /a/x.py | sort --output=/a/x.py", "sort --output=/a/x.py"],
			["python3 /a/x.py | sort --compress-program=/tmp/e", "sort --compress-program=/tmp/e"],
			["python3 /a/x.py | uniq - /a/x.py", "uniq - /a/x.py"],
			["python3 /a/x.py | tail -40 > /a/x.py", "tail -40 > /a/x.py"],
			["python3 /a/x.py | /usr/bin/tail -40", "/usr/bin/tail -40"],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [beside(peer as string)],
			});
		expect(cloudCommandScripts("python3 /a/x.py | tail -40 | sh")).toEqual({
			files: [],
			notShown: [beside("sh"), "sh runs what another program prints into it, which the review cannot see"],
		});
		for (const command of [
			"python3 /a/x.py",
			"timeout 60 python3 /a/x.py",
			"python3 /a/x.py 2>&1 | tail -40",
			"python3 /a/x.py > /dev/null 2>&1",
			"python3 /a/x.py 2> /dev/null",
			"python3 /a/x.py &> /dev/null",
			"python3 /a/x.py 2>&1 | grep -v DEBUG | sort -n | uniq -c | wc -l | head -5 | cat | tee -a",
		])
			expect(cloudCommandScripts(command), command).toEqual({ files: [{ path: "/a/x.py" }], notShown: [] });
		expect(cloudCommandScripts("python3 /a/x.py; cp /tmp/e.py /a/x.py")).toEqual({
			files: [{ path: "/a/x.py" }],
			notShown: [],
		});
	});

	it("shows a sourced file as the first command's file, and nothing after it (reviews r7 and r8 of #1924)", () => {
		expect(cloudCommandScripts("cd /srv/app && source .venv/bin/activate && python3 main.py")).toEqual({
			files: [{ path: "/srv/app/.venv/bin/activate" }],
			notShown: [later("main.py")],
		});
		expect(cloudCommandScripts("source ./env.sh; python3 /tmp/x.py; /tmp/run.sh")).toEqual({
			files: [{ path: "/root/env.sh" }],
			notShown: [later("/tmp/x.py"), later("/tmp/run.sh")],
		});
		expect(cloudCommandScripts("python3 /tmp/a.py && . ./env.sh")).toEqual({
			files: [{ path: "/tmp/a.py" }],
			notShown: [later("./env.sh")],
		});
		expect(cloudCommandScripts("source activate && python3 /tmp/x.py").notShown).toEqual([
			"activate: the shell looks it up on its program path first",
			later("/tmp/x.py"),
		]);
		expect(cloudCommandScripts("time source ./env.sh; python3 /tmp/x.py")).toEqual({
			files: [],
			notShown: ["source: the review does not follow what runs it", later("/tmp/x.py")],
		});
	});

	it('names no file whose path, or the folder a leading cd takes it to, goes up through ".." (review r7 of #1924)', () => {
		const climbs = (word: string) => `${word}: its path goes up through "..", which a link can lead elsewhere`;
		for (const [command, word] of [
			["python3 sub/../x.py", "sub/../x.py"],
			["python3 /root/sub/../x.py", "/root/sub/../x.py"],
			["cd /root/sub && python3 ../x.py", "../x.py"],
			["source sub/../env.sh", "sub/../env.sh"],
			["./sub/../run.sh", "./sub/../run.sh"],
			["/usr/bin/../../root/evil/python3 x.py", "/usr/bin/../../root/evil/python3"],
			["python3 ..", ".."],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [climbs(word as string)],
			});
		for (const [command, target] of [
			["cd /root/sub/.. && python3 x.py", "/root/sub/.."],
			["cd .. && python3 x.py", ".."],
			["cd /a && cd ../b && python3 x.py", "../b"],
		])
			expect(cloudCommandScripts(command as string), command).toEqual({
				files: [],
				notShown: [climbs(target as string), later("x.py")],
			});
		expect(paths("python3 a..b.py ./c.py .../d.py")).toEqual(["/root/a..b.py"]);
		expect(paths("python3 /tmp/..x.py")).toEqual(["/tmp/..x.py"]);
	});

	it("names a script only when every word before its path is on the allow-list (review r5 of #1924)", () => {
		for (const command of [
			"python3 x.py",
			"time python3 x.py",
			"nohup python3 x.py",
			"nice python3 x.py",
			"nice -n 5 python3 x.py",
			"nice -n -5 python3 x.py",
			"timeout 60 python3 x.py",
			"timeout 1.5m python3 x.py",
			"xvfb-run python3 x.py",
			"xvfb-run -a python3 x.py",
			"nice -n 5 timeout 60 nohup time xvfb-run -a python3 -u -B -O -q x.py --its-own -C /arg A=1",
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
			"X=1 python3 evil.py",
			"env A=1 B=2 python3 evil.py",
			"/usr/bin/env python3 evil.py",
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
	const files = (...names: string[]) => names.map((path) => ({ path }));

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

	it("tells the reviewer what is shown and what is not, and counts a part as incomplete", () => {
		const script = "print(1)\n";
		const texts = new Map([[digest(script), script]]);
		const shown = {
			files: [{ path: "/tmp/a.py", sha256: digest(script), bytes: 9 }],
			notShown: [later("/tmp/b.py")],
		};
		const contents = cloudScriptContents(shown, texts);
		expect(contents).toEqual({
			shown: CLOUD_SCRIPT_SHOWN,
			files: [{ path: "/tmp/a.py", bytes: 9, sha256: digest(script), text: script }],
			notShown: [later("/tmp/b.py")],
		});
		expect(cloudScriptContentsIncomplete(contents)).toBe(true);
		const missing = { files: [{ path: "/tmp/x.sh", notShown: "it is not on the machine now" }], notShown: [] };
		expect(cloudScriptContents(missing, texts)).toEqual({
			shown: CLOUD_SCRIPT_SHOWN,
			files: [{ path: "/tmp/x.sh", notShown: "it is not on the machine now" }],
			notShown: ["/tmp/x.sh: it is not on the machine now"],
		});
		const whole = cloudScriptContents({ files: shown.files, notShown: [] }, texts);
		expect(whole).not.toHaveProperty("notShown");
		expect(cloudScriptContentsIncomplete(whole)).toBe(false);
		expect(cloudScriptContentsIncomplete(undefined)).toBe(false);
		expect(() => cloudScriptContents(shown, new Map())).toThrow("Reviewed file is gone");
		expect(parseCloudPreparedScripts(shown as never)).toEqual(shown);
		expect(parseCloudPreparedScripts(missing as never)).toEqual(missing);
		expect(() => parseCloudPreparedScripts({ files: [{ path: "x" }], notShown: [] })).toThrow();
		expect(() =>
			parseCloudPreparedScripts({ files: [...shown.files, ...missing.files], notShown: [] } as never),
		).toThrow();
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
			const files = [script, missing, dir].map((path) => ({ path }));
			const { entries, texts } = parseCloudScriptRead(read.stdout, files);
			expect(entries[0]).toEqual({ path: script, sha256: digest("echo fetched\n"), bytes: 13 });
			expect(texts.get(digest("echo fetched\n"))).toBe("echo fetched\n");
			expect(entries.slice(1).every((entry) => "notShown" in entry)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('refuses the ".." decoys of a real symlinked folder, and reads what runs through a link without ".."', () => {
		const dir = mkdtempSync(join(tmpdir(), "qorpera-script-link-"));
		try {
			mkdirSync(join(dir, "safe", "dir"), { recursive: true });
			writeFileSync(join(dir, "x.py"), "harmless\n");
			writeFileSync(join(dir, "safe", "x.py"), "decoy\n");
			writeFileSync(join(dir, "safe", "dir", "y.py"), "through the link\n");
			symlinkSync(join(dir, "safe", "dir"), join(dir, "sub"));
			const runs = (command: string) => shell(`cd ${dir} && ${command}`).stdout;
			for (const command of [
				"python3 sub/../x.py",
				`python3 ${dir}/sub/../x.py`,
				`cd ${dir}/sub && python3 ../x.py`,
			]) {
				expect(runs(command.replace("python3", "cat")), command).toBe("decoy\n");
				expect(readFileSync(join(dir, "x.py"), "utf8")).toBe("harmless\n");
				const found = cloudCommandScripts(command, dir);
				expect(found.files, command).toEqual([]);
				expect(found.notShown.join(), command).toContain('".."');
			}
			for (const command of ["python3 sub/y.py", `cd ${dir}/sub && python3 y.py`]) {
				const found = cloudCommandScripts(command, dir);
				expect(
					found.files.map((file) => file.path),
					command,
				).toEqual([join(dir, "sub", "y.py")]);
				const read = shell(cloudScriptReadProgram(found.files.map((file) => file.path)));
				const { texts } = parseCloudScriptRead(read.stdout, found.files);
				expect([...texts.values()], command).toEqual([runs(command.replace("python3", "cat"))]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
