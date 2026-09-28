import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,join,resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {build} from "esbuild";
import {SYSTEMD_CONTAINER_SECURITY,systemdContainerBoot} from "./fixtures/systemd-container.mjs";
const repository=resolve(import.meta.dirname,".."),image=process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE;
const laterBoot=process.argv.length===3&&process.argv[2]==="--later-boot";
if((process.argv.length!==2&&!laterBoot)||!image||!/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image))throw new Error("Select digest-pinned local QORPERA_OFFICE_SYSTEMD_TEST_IMAGE; optional --later-boot");
// Package as a root build would: Ubuntu's default user umask 0002 leaves files group-writable,
// and the installers refuse those as unprotected. Docker Desktop shows every mounted file as root 0644.
process.umask(0o022);
const temporary=await mkdtemp(join(tmpdir(),"qorpera-boot-service-start-systemd-")),name=basename(temporary),volume=name+"-workbench";
const command=(file,args)=>{const r=spawnSync(file,args,{cwd:repository,encoding:"utf8",timeout:120000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
let container;
try{
	const pkg=join(temporary,"package");command(process.execPath,["scripts/package-company-computer.mjs","--out",pkg]);
	for(const [file,entry] of [["data",`packages/runtime/test/fixtures/company-computer-${laterBoot?"later-":""}boot-service-start.ts`],["mount","packages/runtime/src/cloud-identity-recovery-filesystems.ts"]])await build({absWorkingDir:repository,entryPoints:[entry],outfile:join(temporary,file+".mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19",logLevel:"silent"});
	const args=["run","-d","--name",name,"--pull","never","--network","none","--cgroupns","private","--cap-drop","ALL"];
	for(const cap of ["SYS_ADMIN","SYS_PTRACE","SYS_RESOURCE","SYS_CHROOT","CHOWN","DAC_OVERRIDE","FOWNER","FSETID","KILL","SETGID","SETUID","SETPCAP","AUDIT_WRITE"])args.push("--cap-add",cap);
	args.push(...SYSTEMD_CONTAINER_SECURITY,"--cpus","2","--memory","1g","--pids-limit","2048","--tmpfs","/run:rw,nosuid,nodev,size=192m,mode=755","--tmpfs","/tmp:rw,nosuid,nodev,size=128m,mode=1777","--tmpfs","/var/log/journal:rw,nosuid,nodev,size=16m,mode=755","--tmpfs","/etc/systemd/system:rw,nosuid,nodev,size=16m,mode=755","--env","container=docker","--mount",`type=volume,source=${volume},target=/fixture/workbench`);
	for(const [source,target] of [[pkg,"/fixture/package"],[join(temporary,"data.mjs"),"/fixture/data.mjs"],[join(temporary,"mount.mjs"),"/fixture/mount.mjs"],[join(repository,"scripts/fixtures/office-boot-service-start-systemd.mjs"),"/fixture/check.mjs"]])args.push("--mount",`type=bind,src=${source},dst=${target},readonly`);
	args.push(image,"/bin/bash","-c",systemdContainerBoot());container=command("docker",args);
	let ready=false;for(let i=0;i<40;i++){const state=spawnSync("docker",["exec",container,"systemctl","is-system-running"],{encoding:"utf8",timeout:10000}).stdout?.trim();if(["running","degraded"].includes(state)){ready=true;break;}await delay(500);}assert(ready,"Disposable systemd manager did not start");
	await new Promise((resolve,reject)=>{const child=spawn("docker",["exec",container,"node","/fixture/check.mjs"],{stdio:"inherit",timeout:600000});child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error("Retained boot actual-systemd proof failed")));});
}finally{
	if(container)spawnSync("docker",["rm","-f",container],{stdio:"ignore",timeout:10000});
	spawnSync("docker",["volume","rm",volume],{stdio:"ignore",timeout:10000});
	await rm(temporary,{recursive:true,force:true});
}
