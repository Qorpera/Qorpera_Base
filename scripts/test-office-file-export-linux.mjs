import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
const root=dirname(dirname(fileURLToPath(import.meta.url))), directory=await mkdtemp(join(tmpdir(),'office-file-export-'));
const image='node:22.22.1-trixie-slim@sha256:1c9db0fdddfed0421e2f692fd12761bcc24f860f18206c2a8df17d06270d92a2';
const container = `qorpera-file-export-${randomUUID()}`;
try {
	await build({absWorkingDir:root,entryPoints:['packages/runtime/test/fixtures/company-computer-file-reader-probe.ts'],outfile:join(directory,'probe.mjs'),bundle:true,format:'esm',platform:'node',target:'node22.19'});
	const code=await new Promise((resolve,reject)=>{
		const child=spawn('docker',['run','--name',container,'--rm','--pull','never','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000',
			'--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','256m','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777',
			'--mount',`type=bind,src=${directory},dst=/probe,readonly`,image,'node','/probe/probe.mjs'],{stdio:'inherit'});
		const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
		child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});
	}); assert.equal(code,0,'Linux workbench export read failed');
} finally {
	const cleanup = spawnSync('docker',['rm','--force',container],{encoding:'utf8',timeout:15000});
	await rm(directory,{recursive:true,force:true});
	if (cleanup.error) throw cleanup.error;
	if (cleanup.status !== 0 && !cleanup.stderr.includes('No such container')) throw new Error('OFFICE_FILE_EXPORT_PROBE_CLEANUP_FAILED');
}
