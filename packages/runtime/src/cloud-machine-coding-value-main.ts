import { runMachineCodingValueCli } from "./cloud-machine-coding-value.ts";

/* save_coding_value's clipboard helper as a program (20260930705000): scripts/package-machine-guest.mjs bundles this
 * entry alone as /opt/qorpera-machine/cloud-machine-coding-value.mjs, and the coding executor runs it on a company
 * machine. Nothing imports it: loading it runs the helper. The target comes on stdin; one JSON line, the box or a
 * refusal code, goes to stdout; a failure prints a fixed word on stderr and exits 1. */
runMachineCodingValueCli({ stdin: process.stdin, stdout: process.stdout }).then(
	(code) => {
		process.exitCode = code;
	},
	() => {
		process.stderr.write("MACHINE_CODING_VALUE_FAILED\n");
		process.exitCode = 1;
	},
);
