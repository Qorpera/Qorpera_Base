#!/usr/bin/env node
import { captureLxdOfficeHostNamespace } from "./lxd-office-host-namespace.ts";

if (process.argv.length !== 2) {
	console.error("OFFICE_HOST_NAMESPACE_ARGUMENTS_INVALID");
	process.exitCode = 2;
} else {
	void captureLxdOfficeHostNamespace().catch(() => {
		console.error("OFFICE_HOST_NAMESPACE_CAPTURE_FAILED");
		process.exitCode = 1;
	});
}
