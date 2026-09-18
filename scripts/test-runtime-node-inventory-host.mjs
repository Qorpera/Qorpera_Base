import { spawnSync } from "node:child_process";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { build } from "esbuild";
if(process.argv.length!==2)throw new Error("Usage: node scripts/test-runtime-node-inventory-host.mjs");
const image="node:22.22.1-trixie-slim@sha256:1c9db0fdddfed0421e2f692fd12761bcc24f860f18206c2a8df17d06270d92a2";
const temporary=await mkdtemp(join(tmpdir(),"node-inventory-host-")),probe=join(temporary,"probe.cjs");
try {
	await build({absWorkingDir:resolve(import.meta.dirname,".."),entryPoints:["packages/runner-orchestrator/test/fixtures/node-inventory-host-probe.ts"],outfile:probe,platform:"node",format:"cjs",target:"node22.19",bundle:true,logLevel:"silent"});
	const result=spawnSync("docker",["run","--rm","--pull","never","--platform","linux/amd64","--network","none","--read-only","--memory","256m","--cpus","1","--pids-limit","64","--security-opt","no-new-privileges","--cap-drop","ALL","--cap-add","CHOWN","--cap-add","SETUID","--cap-add","SETGID","--user","0:0",
		"--tmpfs","/fixture:rw,nosuid,nodev,size=16m,mode=0755","--tmpfs","/run:rw,nosuid,nodev,size=1m,mode=0755","--tmpfs","/etc:rw,nosuid,nodev,size=1m,mode=0755","--mount",`type=bind,src=${probe},dst=/probe.cjs,readonly`,image,"node","--jitless","--disable-proto=throw","--disallow-code-generation-from-strings","/probe.cjs"],{stdio:"inherit",timeout:30000});
	if(result.status!==0)throw new Error("Disposable host inventory custody proof failed");
} finally {await rm(temporary,{recursive:true,force:true});}
