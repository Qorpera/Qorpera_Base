import { runMachineScreenCli } from "./cloud-machine-screen.ts";

/* machine_screen's helper as a program (20260930708000): scripts/package-machine-guest.mjs bundles this entry alone as
 * /opt/qorpera-machine/cloud-machine-screen.mjs, and the coding executor runs it on a company machine. Nothing imports
 * it: loading it runs the helper. The request comes on stdin; one header line (JSON) and the screenshot's PNG, or a
 * refusal's line, go to stdout; an action already taken on this boot exits 96 with nothing printed. A failure prints a
 * fixed word on stderr and exits 1. */
runMachineScreenCli({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout }).then(
	(code) => {
		process.exitCode = code;
	},
	() => {
		process.stderr.write("MACHINE_SCREEN_FAILED\n");
		process.exitCode = 1;
	},
);
