import { createHash } from "node:crypto";
import { CODE_CHECKS_NEWER_RUN } from "./code-site.ts";

export const PREVIEW_WORKSPACES_ROOT_REL = ".qorpera-preview-workspaces";
export const PREVIEW_WORKSPACES_MAX_KEPT = 8;

export type PreviewPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ParsedLeadingPackageInstall {
	readonly manager: PreviewPackageManager;
	readonly installCommand: string;
	readonly buildCommand: string;
}

export function previewWorkspaceKey(areaPath: string, cwd: string): string {
	return createHash("sha256").update(`${areaPath}\0${cwd}`, "utf8").digest("hex").slice(0, 24);
}

export function previewWorkspaceDir(uid: number, key: string): string {
	return `/home/qorpera-${uid}/${PREVIEW_WORKSPACES_ROOT_REL}/${key}`;
}

const SAFE_FLAG_VALUE = /^[A-Za-z0-9._-]+$/;

const NPM_BARE_FLAGS = new Set([
	"--prefer-offline",
	"--offline",
	"--no-audit",
	"--no-fund",
	"--silent",
	"--quiet",
	"-s",
	"-q",
	"--legacy-peer-deps",
	"--ignore-scripts",
	"--production",
	"--force",
	"--no-optional",
	"--no-package-lock",
	"--no-save",
	"--workspaces",
	"--include-workspace-root",
	"--no-progress",
]);

const NPM_KV_FLAGS = new Set(["--loglevel", "--omit", "--include", "--only", "--audit", "--fund", "--progress"]);

const PNPM_BARE_FLAGS = new Set([
	"--frozen-lockfile",
	"--no-frozen-lockfile",
	"--prefer-offline",
	"--offline",
	"--silent",
	"-s",
	"--ignore-scripts",
	"--prod",
	"--production",
	"--dev",
	"--no-optional",
	"--shamefully-hoist",
	"--no-strict-peer-dependencies",
]);

const PNPM_KV_FLAGS = new Set(["--reporter", "--loglevel"]);

const YARN_BARE_FLAGS = new Set([
	"--frozen-lockfile",
	"--immutable",
	"--prefer-offline",
	"--offline",
	"--silent",
	"-s",
	"--ignore-scripts",
	"--check-files",
	"--non-interactive",
	"--production",
	"--prod",
	"--no-progress",
	"--pure-lockfile",
]);

const YARN_KV_FLAGS = new Set(["--network-timeout", "--network-concurrency"]);

const BUN_BARE_FLAGS = new Set([
	"--frozen-lockfile",
	"--no-save",
	"--silent",
	"-s",
	"--ignore-scripts",
	"--production",
	"--no-progress",
	"--yarn",
]);

const BUN_KV_FLAGS = new Set(["--backend"]);

function splitAtFirstTopLevelAnd(command: string): { readonly left: string; readonly right: string } | null {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let parenDepth = 0;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inDouble = false;
			}
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "(") {
			parenDepth += 1;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === 0) return null;
			parenDepth -= 1;
			continue;
		}
		if (parenDepth === 0 && ch === "&" && command[i + 1] === "&") {
			const left = command.slice(0, i).trim();
			const right = command.slice(i + 2).trim();
			if (!left || !right) return null;
			return { left, right };
		}
	}
	return null;
}

function tokenizeSimpleShellCommand(segment: string): string[] | null {
	if (/[\r\n;|&<>()`$]/.test(segment)) return null;
	const tokens: string[] = [];
	let current = "";
	let hasToken = false;
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i]!;
		if (escaped) {
			current += ch;
			hasToken = true;
			escaped = false;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else current += ch;
			hasToken = true;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inDouble = false;
			else current += ch;
			hasToken = true;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			hasToken = true;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			hasToken = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			hasToken = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}
		current += ch;
		hasToken = true;
	}
	if (inSingle || inDouble || escaped) return null;
	if (hasToken) tokens.push(current);
	return tokens.length > 0 ? tokens : null;
}

function validateInstallFlags(
	args: readonly string[],
	bareFlags: ReadonlySet<string>,
	kvFlags: ReadonlySet<string>,
): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (bareFlags.has(arg)) continue;
		const eq = arg.indexOf("=");
		if (eq > 0) {
			const flag = arg.slice(0, eq);
			const value = arg.slice(eq + 1);
			if (kvFlags.has(flag) && SAFE_FLAG_VALUE.test(value)) continue;
			return false;
		}
		if (kvFlags.has(arg)) {
			const next = args[i + 1];
			if (next !== undefined && SAFE_FLAG_VALUE.test(next)) {
				i += 1;
				continue;
			}
			return false;
		}
		return false;
	}
	return true;
}

function hasUnsafeTopLevelRemainder(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let parenDepth = 0;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inDouble = false;
			}
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "(") {
			parenDepth += 1;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === 0) return true;
			parenDepth -= 1;
			continue;
		}
		if (parenDepth !== 0) continue;
		if (ch === "\n" || ch === "\r" || ch === ";") return true;
		if (ch === "|" && command[i + 1] === "|") return true;
		if (ch === "&") {
			if (command[i + 1] === "&") {
				i += 1;
				continue;
			}
			const prev = i > 0 ? command[i - 1] : "";
			const next = i + 1 < command.length ? command[i + 1] : "";
			if (prev !== ">" && next !== ">" && prev !== "<" && next !== "<") return true;
		}
	}
	return inSingle || inDouble || escaped || parenDepth !== 0;
}

export function parseLeadingPackageInstall(run: string): ParsedLeadingPackageInstall | null {
	const split = splitAtFirstTopLevelAnd(run);
	if (!split) return null;
	if (hasUnsafeTopLevelRemainder(split.right)) return null;
	const tokens = tokenizeSimpleShellCommand(split.left);
	if (!tokens || tokens.length === 0) return null;
	const bin = tokens[0]!;
	if (bin === "npm") {
		const sub = tokens[1];
		if (sub !== "ci" && sub !== "install" && sub !== "i") return null;
		if (!validateInstallFlags(tokens.slice(2), NPM_BARE_FLAGS, NPM_KV_FLAGS)) return null;
		return { manager: "npm", installCommand: split.left, buildCommand: split.right };
	}
	if (bin === "pnpm") {
		const sub = tokens[1];
		if (sub !== "install" && sub !== "i") return null;
		if (!validateInstallFlags(tokens.slice(2), PNPM_BARE_FLAGS, PNPM_KV_FLAGS)) return null;
		return { manager: "pnpm", installCommand: split.left, buildCommand: split.right };
	}
	if (bin === "yarn") {
		const rest = tokens[1] === "install" ? tokens.slice(2) : tokens.slice(1);
		if (!validateInstallFlags(rest, YARN_BARE_FLAGS, YARN_KV_FLAGS)) return null;
		return { manager: "yarn", installCommand: split.left, buildCommand: split.right };
	}
	if (bin === "bun") {
		const sub = tokens[1];
		if (sub !== "install" && sub !== "i") return null;
		if (!validateInstallFlags(tokens.slice(2), BUN_BARE_FLAGS, BUN_KV_FLAGS)) return null;
		return { manager: "bun", installCommand: split.left, buildCommand: split.right };
	}
	return null;
}

const PREVIEW_WORKSPACE_SYNC_PY = String.raw`import hashlib,json,os,re,shutil,stat,subprocess,sys,threading,time
E=os.environ
ws_root=E["QORPERA_PREVIEW_WORKSPACES_ROOT"]
ws_key=E["QORPERA_PREVIEW_WORKSPACE_KEY"]
repo=E["QORPERA_CHECKS_REPOSITORY"]
commit=E["QORPERA_CHECKS_COMMIT"]
out_folder=E.get("QORPERA_PREVIEW_OUTPUT_FOLDER","")
max_kept=int(E.get("QORPERA_PREVIEW_WORKSPACES_MAX","8"))
if not re.fullmatch(r"[0-9a-f]{16,64}",ws_key):
	sys.exit(2)
if os.path.islink(ws_root) or (os.path.exists(ws_root) and not os.path.isdir(ws_root)):
	os.unlink(ws_root)
os.makedirs(ws_root,mode=0o755,exist_ok=True)
ws_dir=os.path.join(ws_root,ws_key)
if os.path.islink(ws_dir) or (os.path.exists(ws_dir) and not os.path.isdir(ws_dir)):
	os.unlink(ws_dir)
os.makedirs(ws_dir,mode=0o755,exist_ok=True)
last_used=os.path.join(ws_dir,".last-used")
try:
	if os.path.islink(last_used):
		os.unlink(last_used)
	open(last_used,"wb").close()
	os.utime(last_used,None)
except OSError:
	pass
try:
	entries=[]
	for name in os.listdir(ws_root):
		if name==ws_key:
			continue
		ep=os.path.join(ws_root,name)
		try:
			st=os.lstat(ep)
		except OSError:
			continue
		if os.path.islink(ep) or not stat.S_ISDIR(st.st_mode):
			continue
		lu=os.path.join(ep,".last-used")
		try:
			mt=os.lstat(lu).st_mtime if os.path.isfile(lu) and not os.path.islink(lu) else st.st_mtime
		except OSError:
			mt=0.0
		entries.append((mt,ep))
	entries.sort(key=lambda item:item[0],reverse=True)
	for _,ep in entries[max(0,max_kept-1):]:
		shutil.rmtree(ep,ignore_errors=True)
except OSError:
	pass
src_dir=os.path.join(ws_dir,"src")
if os.path.islink(src_dir) or (os.path.exists(src_dir) and not os.path.isdir(src_dir)):
	os.unlink(src_dir)
os.makedirs(src_dir,mode=0o755,exist_ok=True)
git_env={"PATH":E.get("PATH","/usr/bin:/bin"),"LC_ALL":"C","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_TERMINAL_PROMPT":"0"}
def safe_rel(p):
	if not p or p=="." or p.startswith("/") or p.endswith("/") or "\\" in p or "\0" in p:
		return False
	parts=p.split("/")
	return all(part not in ("",".","..") and part.lower()!=".git" for part in parts)
def unlink_safe(root,rel):
	parts=rel.split("/")
	cur=root
	for part in parts[:-1]:
		cur=os.path.join(cur,part)
		if os.path.islink(cur) or not os.path.isdir(cur):
			return
	dst=os.path.join(cur,parts[-1])
	try:
		st=os.lstat(dst)
		if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
			shutil.rmtree(dst,ignore_errors=True)
		else:
			os.unlink(dst)
	except OSError:
		return
	cur_dir=cur
	while cur_dir!=root:
		try:
			os.rmdir(cur_dir)
		except OSError:
			break
		cur_dir=os.path.dirname(cur_dir)
def ensure_parent_dir(root,rel):
	parts=rel.split("/")[:-1]
	cur=root
	for part in parts:
		cur=os.path.join(cur,part)
		try:
			st=os.lstat(cur)
			if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
				os.unlink(cur)
				os.mkdir(cur,0o755)
		except FileNotFoundError:
			os.mkdir(cur,0o755)
	return cur
git_dir=os.path.join(src_dir,".git")
if os.path.islink(git_dir) or (os.path.exists(git_dir) and not os.path.isdir(git_dir)):
	os.unlink(git_dir)
if not os.path.isfile(os.path.join(git_dir,"HEAD")):
	r_init=subprocess.run(["git","init","--quiet",src_dir],env=git_env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
	if r_init.returncode!=0:
		sys.exit(4)
alt_dir=os.path.join(git_dir,"objects","info")
os.makedirs(alt_dir,mode=0o755,exist_ok=True)
alt_path=os.path.join(alt_dir,"alternates")
expected_alt=os.path.join(repo,"objects")+"\n"
try:
	cur_alt=open(alt_path,"r",encoding="utf-8").read() if os.path.isfile(alt_path) else ""
except OSError:
	cur_alt=""
if cur_alt!=expected_alt:
	with open(alt_path,"w",encoding="utf-8") as f:
		f.write(expected_alt)
r_head=subprocess.run(["git","--git-dir",git_dir,"update-ref","--no-deref","HEAD",commit],env=git_env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
if r_head.returncode!=0:
	sys.exit(4)
r_tree=subprocess.run(["git","--git-dir",repo,"-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","ls-tree","-r","-z",commit],env=git_env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=False)
if r_tree.returncode!=0:
	sys.exit(4)
new_entries={}
for raw in r_tree.stdout.split(b"\0"):
	if not raw:
		continue
	tab=raw.find(b"\t")
	if tab<0:
		continue
	meta=raw[:tab].decode("ascii",errors="strict").split(" ")
	if len(meta)!=3:
		continue
	mode,obj_type,sha=meta
	rel=raw[tab+1:].decode("utf-8",errors="strict")
	if not safe_rel(rel):
		continue
	new_entries[rel]=(mode,obj_type,sha)
tracked_path=os.path.join(ws_dir,"tracked.json")
prev_files={}
try:
	if os.path.isfile(tracked_path) and not os.path.islink(tracked_path):
		doc=json.loads(open(tracked_path,"r",encoding="utf-8").read())
		if isinstance(doc,dict) and doc.get("version")==1 and isinstance(doc.get("files"),dict):
			prev_files=doc["files"]
except Exception:
	prev_files={}
for old_rel in list(prev_files.keys()):
	if old_rel not in new_entries:
		if safe_rel(old_rel):
			unlink_safe(src_dir,old_rel)
next_files={}
to_write=[]
for rel,(mode,obj_type,sha) in sorted(new_entries.items()):
	if obj_type!="blob":
		if mode=="160000":
			parent=ensure_parent_dir(src_dir,rel)
			dst=os.path.join(parent,rel.split("/")[-1])
			if os.path.islink(dst) or (os.path.exists(dst) and not os.path.isdir(dst)):
				os.unlink(dst)
			os.makedirs(dst,mode=0o755,exist_ok=True)
		continue
	prev=prev_files.get(rel)
	if isinstance(prev,list) and len(prev)==4 and prev[0]==mode and prev[1]==sha:
		dst=os.path.join(src_dir,rel)
		try:
			st=os.lstat(dst)
			is_ok=(stat.S_ISLNK(st.st_mode) if mode=="120000" else stat.S_ISREG(st.st_mode))
			if is_ok and st.st_size==prev[2] and st.st_mtime_ns==prev[3]:
				next_files[rel]=prev
				continue
		except OSError:
			pass
	to_write.append((rel,mode,sha))
if to_write:
	proc=subprocess.Popen(["git","--git-dir",repo,"-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","cat-file","--batch"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=git_env)
	def feed():
		try:
			for _,_,s in to_write:
				proc.stdin.write((s+"\n").encode("ascii"))
			proc.stdin.close()
		except Exception:
			pass
	writer=threading.Thread(target=feed,daemon=True)
	writer.start()
	for rel,mode,sha in to_write:
		header=proc.stdout.readline()
		if not header:
			proc.kill()
			sys.exit(4)
		parts=header.decode("ascii",errors="strict").strip().split(" ")
		if len(parts)!=3 or parts[1]!="blob":
			proc.kill()
			sys.exit(4)
		size=int(parts[2])
		data=proc.stdout.read(size)
		if len(data)!=size:
			proc.kill()
			sys.exit(4)
		nl=proc.stdout.read(1)
		if nl!=b"\n":
			proc.kill()
			sys.exit(4)
		parent=ensure_parent_dir(src_dir,rel)
		dst=os.path.join(parent,rel.split("/")[-1])
		try:
			st_old=os.lstat(dst)
			if stat.S_ISDIR(st_old.st_mode) and not stat.S_ISLNK(st_old.st_mode):
				shutil.rmtree(dst)
			elif stat.S_ISLNK(st_old.st_mode):
				os.unlink(dst)
		except FileNotFoundError:
			pass
		if mode=="120000":
			if not data or data.startswith(b"/") or b"\0" in data:
				continue
			tgt=data.decode("utf-8",errors="strict")
			norm=os.path.normpath(os.path.join(os.path.dirname(rel),tgt))
			if norm==".." or norm.startswith("../") or norm.startswith("/"):
				continue
			if os.path.lexists(dst):
				os.unlink(dst)
			os.symlink(tgt,dst)
		else:
			tmp=dst+".qorpera-sync-tmp"
			try:
				if os.path.lexists(tmp):
					os.unlink(tmp)
			except OSError:
				pass
			fmode=0o755 if mode=="100755" else 0o644
			fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,fmode)
			try:
				with os.fdopen(fd,"wb") as fout:
					fout.write(data)
				os.chmod(tmp,fmode)
				os.replace(tmp,dst)
			except Exception:
				try:
					os.unlink(tmp)
				except OSError:
					pass
				raise
		st=os.lstat(dst)
		next_files[rel]=[mode,sha,st.st_size,st.st_mtime_ns]
	writer.join()
	if proc.wait()!=0:
		sys.exit(4)
if out_folder and out_folder!="." and safe_rel(out_folder):
	cur=src_dir
	ok=True
	for part in out_folder.split("/"):
		cur=os.path.join(cur,part)
		if os.path.islink(cur):
			ok=False
			break
	if ok and os.path.isdir(cur):
		for dirpath,dirnames,filenames in os.walk(cur,topdown=False,followlinks=False):
			rel_dir=os.path.relpath(dirpath,src_dir).replace(os.sep,"/")
			for fn in filenames:
				if rel_dir+"/"+fn not in new_entries:
					fp=os.path.join(dirpath,fn)
					try:
						os.unlink(fp)
					except PermissionError:
						try:
							os.chmod(dirpath,0o755)
							os.unlink(fp)
						except OSError:
							pass
					except OSError:
						pass
			for dn in dirnames:
				dp=os.path.join(dirpath,dn)
				rel_dn=rel_dir+"/"+dn
				if os.path.islink(dp):
					if rel_dn not in new_entries:
						try:
							os.unlink(dp)
						except OSError:
							pass
				elif rel_dn not in new_entries:
					try:
						os.rmdir(dp)
					except OSError:
						pass
		try:
			os.rmdir(cur)
		except OSError:
			pass
tmp_tracked=tracked_path+".tmp"
with open(tmp_tracked,"w",encoding="utf-8") as f:
	json.dump({"version":1,"files":next_files},f,separators=(",",":"))
os.replace(tmp_tracked,tracked_path)
def restore_blessed_caches():
	cache_root=E.get("QORPERA_CHECKS_CACHE_ROOT","")
	blessed_branch=E.get("QORPERA_CHECKS_BLESSED_CACHES_BRANCH","")
	if not cache_root or not blessed_branch or os.path.islink(cache_root) or not os.path.isdir(cache_root):
		return
	r=subprocess.run(["git","--git-dir",repo,"-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","show","refs/heads/"+blessed_branch+":.qorpera/checks.json"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=git_env,check=False)
	if r.returncode!=0 or not r.stdout or len(r.stdout)>65536:
		return
	text=r.stdout.decode("utf-8",errors="strict")
	if text.startswith("\ufeff"):
		text=text[1:]
	doc=json.loads(text)
	if not isinstance(doc,dict) or not isinstance(doc.get("caches"),list):
		return
	tok_re=re.compile(r"\$\{hash\('([^']*)'\)\}|hash\('([^']*)'\)")
	key_re=re.compile(r"[A-Za-z0-9._:-]{1,200}")
	def safe_cp(p):
		return isinstance(p,str) and safe_rel(p) and not any(ord(c)<32 or ord(c)==127 for c in p) and p.split("/")[0].lower()!=".qorpera"
	specs=[]
	for raw in doc["caches"][:8]:
		if not isinstance(raw,dict):
			continue
		k=raw.get("key");ps=raw.get("paths");rks=raw.get("restoreKeys")
		if not isinstance(k,str) or not (1<=len(k)<=200) or not isinstance(ps,list) or not (1<=len(ps)<=16):
			continue
		if not all(safe_cp(p) for p in ps):
			continue
		if rks is not None and (not isinstance(rks,list) or len(rks)>8 or not all(isinstance(x,str) and 1<=len(x)<=200 for x in rks)):
			continue
		specs.append((k,ps,rks or []))
	if not specs:
		return
	def no_link(root,rel):
		cur=root
		for part in rel.split("/"):
			cur=os.path.join(cur,part)
			if os.path.islink(cur):
				return None
		return cur
	def parent_ok(root,rel):
		cur=root
		for part in rel.split("/")[:-1]:
			cur=os.path.join(cur,part)
			if os.path.islink(cur) or (os.path.lexists(cur) and not os.path.isdir(cur)):
				return False
		return True
	def open_rel(src_fd,rel):
		parts=rel.split("/")
		cur=os.dup(src_fd)
		try:
			for part in parts[:-1]:
				nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=cur)
				os.close(cur);cur=nxt
			return os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|getattr(os,"O_NONBLOCK",0),dir_fd=cur)
		except OSError:
			return -1
		finally:
			os.close(cur)
	def eval_key(tpl,src_fd):
		def rep(m):
			rel=m.group(1) if m.group(1) is not None else m.group(2)
			if not safe_rel(rel) or any(ord(c)<32 or ord(c)==127 for c in rel):
				raise ValueError("bad")
			fd=open_rel(src_fd,rel)
			if fd<0:
				return "missing"
			h=hashlib.sha256();rem=16*1024*1024
			with os.fdopen(fd,"rb") as f:
				if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
					return "missing"
				while rem>0:
					c=f.read(min(65536,rem))
					if not c:
						break
					h.update(c);rem-=len(c)
			return h.hexdigest()[:16]
		out=tok_re.sub(rep,tpl)
		return out if key_re.fullmatch(out) and not out.startswith(".") else None
	def valid_entry(ed):
		m=os.path.join(ed,".complete")
		return not os.path.islink(ed) and os.path.isdir(ed) and os.path.isfile(m) and not os.path.islink(m)
	def used_t(ed):
		lu=os.path.join(ed,".last-used")
		try:
			return os.lstat(lu).st_mtime if os.path.isfile(lu) and not os.path.islink(lu) else os.lstat(ed).st_mtime
		except OSError:
			return 0.0
	src_fd=os.open(src_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
	try:
		for k_tpl,paths,rks in specs:
			missing=[rel for rel in paths if (lambda dp: dp and not os.path.lexists(dp))(no_link(src_dir,rel))]
			if not missing:
				continue
			key=eval_key(k_tpl,src_fd)
			if not key:
				continue
			hit=os.path.join(cache_root,key)
			if not valid_entry(hit):
				hit=None
				try:
					names=os.listdir(cache_root)
				except OSError:
					names=[]
				for rk in rks:
					pref=eval_key(rk,src_fd)
					if not pref:
						continue
					ms=[os.path.join(cache_root,n) for n in names if n.startswith(pref) and valid_entry(os.path.join(cache_root,n))]
					if ms:
						ms.sort(key=used_t,reverse=True);hit=ms[0];break
			if not hit:
				continue
			for rel in missing:
				if rel in new_entries or any(p.startswith(rel+"/") for p in new_entries):
					continue
				sp=no_link(os.path.join(hit,"data"),rel)
				if not sp or not os.path.lexists(sp):
					continue
				dp=no_link(src_dir,rel)
				if not dp or os.path.lexists(dp) or not parent_ok(src_dir,rel):
					continue
				os.makedirs(os.path.dirname(dp),exist_ok=True)
				subprocess.run(["cp","-R","-P","--preserve=mode,timestamps","--reflink=auto","--",sp,dp],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
	finally:
		os.close(src_fd)
try:
	restore_blessed_caches()
except Exception:
	pass`;

export const PREVIEW_WORKSPACE_SYNC = [
	"set -eu",
	'r="$QORPERA_CHECKS_ROOT"',
	'n="$QORPERA_CHECKS_NAME"',
	'd="$r/$n"',
	'ws="$QORPERA_PREVIEW_WORKSPACES_ROOT/$QORPERA_PREVIEW_WORKSPACE_KEY"',
	'if [ -L "$r" ] || { [ -e "$r" ] && [ ! -d "$r" ]; }; then rm -f -- "$r"; fi',
	'mkdir -p -- "$r"',
	...CODE_CHECKS_NEWER_RUN,
	'if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then rm -f -- "$d"; fi',
	'mkdir -p -- "$d"',
	"(",
	"\tLC_ALL=C",
	"\tfor t in 1 2 3 4 5; do",
	"\t\tk=0",
	"\t\twhile IFS= read -r -d '' h && IFS= read -r -d '' c; do",
	`\t\t\tc="\${c% (deleted)}"`,
	'\t\t\tcase "$c" in',
	'\t\t\t\t"$r"/*)',
	`\t\t\t\t\tm="\${c#"$r"/}"; m="\${m%%/*}"`,
	"\t\t\t\t\tif [[ $m =~ ^[0-9]{10}-[0-9]{4}$ && $m < $n ]]; then",
	`\t\t\t\t\t\tkill -KILL "\${h#/proc/}" 2>/dev/null || true; k=1`,
	"\t\t\t\t\tfi",
	"\t\t\t\t\t;;",
	'\t\t\t\t"$ws"/src|"$ws"/src/*)',
	`\t\t\t\t\tkill -KILL "\${h#/proc/}" 2>/dev/null || true; k=1`,
	"\t\t\t\t\t;;",
	"\t\t\tesac",
	"\t\tdone < <(find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%h\\0%l\\0' 2>/dev/null)",
	'\t\t[ "$k" -eq 1 ] || break',
	"\t\tsleep 0.2",
	"\tdone",
	")",
	"(",
	"\tLC_ALL=C",
	'\tfor e in "$r"/*; do',
	'\t\tm="$(basename -- "$e")"',
	'\t\tif [[ $m =~ ^[0-9]{10}-[0-9]{4}$ && $m < $n ]]; then rm -rf -- "$e" || true; fi',
	"\tdone",
	")",
	'find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
	'mkdir -p -- "$d/out"',
	"b=(0.1 0.2 0.5 1 2)",
	"i=0",
	'until git -C "$QORPERA_CHECKS_REPOSITORY" cat-file -e "$QORPERA_CHECKS_COMMIT^{commit}" 2>/dev/null; do',
	'\t[ "$i" -lt 33 ] || exit 90',
	`\tif [ "$i" -lt 5 ]; then sleep "\${b[$i]}"; else sleep 2; fi`,
	"\ti=$((i + 1))",
	"done",
	"python3 -I - <<'QORPERA_PREVIEW_SYNC_EOF'",
	PREVIEW_WORKSPACE_SYNC_PY,
	"QORPERA_PREVIEW_SYNC_EOF",
].join("\n");

const PREVIEW_DEPS_FINGERPRINT_PY = String.raw`import glob,hashlib,json,os,platform,subprocess,sys
ws_dir=os.environ["QORPERA_PREVIEW_WORKSPACE_DIR"]
src_root=os.path.join(ws_dir,"src")
cwd_dir=os.getcwd()
manager=os.environ["QORPERA_PREVIEW_INSTALL_MANAGER"]
install_cmd=os.environ["QORPERA_PREVIEW_INSTALL_CMD"]
rel_cwd=os.environ.get("QORPERA_CHECK_CWD",".")
LOCK_FILES=("package-lock.json","npm-shrinkwrap.json","pnpm-lock.yaml","pnpm-workspace.yaml","yarn.lock",".yarnrc.yml",".yarnrc","bun.lock","bun.lockb",".npmrc")
DEP_KEYS=("dependencies","devDependencies","optionalDependencies","peerDependencies","peerDependenciesMeta","overrides","resolutions","workspaces","packageManager","engines","bundledDependencies","bundleDependencies")
SCRIPT_KEYS=("preinstall","install","postinstall","prepare")
def has_local_dep(doc):
	for key in ("dependencies","devDependencies","optionalDependencies","peerDependencies"):
		block=doc.get(key)
		if isinstance(block,dict):
			for val in block.values():
				if isinstance(val,str) and (val.startswith("file:") or val.startswith("link:")):
					return True
	return False
def dir_non_empty(path):
	try:
		if os.path.islink(path) or not os.path.isdir(path):
			return False
		with os.scandir(path) as it:
			return next(it,None) is not None
	except OSError:
		return False
h=hashlib.sha256()
h.update(f"v1\0{manager}\0{install_cmd}\0{rel_cwd}\0{platform.machine()}\0".encode("utf-8"))
try:
	nv=subprocess.run(["node","-v"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,check=False)
	h.update(nv.stdout.strip()+b"\0")
except Exception:
	h.update(b"unknown-node\0")
dirs=[]
for candidate in (src_root,cwd_dir):
	real=os.path.realpath(candidate)
	if real not in dirs:
		dirs.append(real)
force_install=False
for base in dirs:
	tag="root" if base==os.path.realpath(src_root) else "cwd"
	for name in LOCK_FILES:
		fp=os.path.join(base,name)
		if os.path.isfile(fp) and not os.path.islink(fp):
			h.update(f"lock:{tag}:{name}\0".encode("utf-8"))
			with open(fp,"rb") as f:
				while True:
					chunk=f.read(65536)
					if not chunk:
						break
					h.update(chunk)
			h.update(b"\0")
	pkg=os.path.join(base,"package.json")
	if os.path.isfile(pkg) and not os.path.islink(pkg):
		try:
			doc=json.loads(open(pkg,"r",encoding="utf-8").read())
		except Exception:
			force_install=True
			doc={}
		if isinstance(doc,dict):
			if has_local_dep(doc):
				force_install=True
			subset={k:doc.get(k) for k in DEP_KEYS if k in doc}
			scripts=doc.get("scripts")
			if isinstance(scripts,dict):
				sub_scripts={k:scripts[k] for k in SCRIPT_KEYS if k in scripts}
				if sub_scripts:
					subset["scripts"]=sub_scripts
			h.update(f"pkg:{tag}\0".encode("utf-8"))
			h.update(json.dumps(subset,sort_keys=True,separators=(",",":")).encode("utf-8"))
			h.update(b"\0")
			ws_cfg=doc.get("workspaces")
			patterns=ws_cfg if isinstance(ws_cfg,list) else (ws_cfg.get("packages") if isinstance(ws_cfg,dict) and isinstance(ws_cfg.get("packages"),list) else [])
			if patterns and base==os.path.realpath(src_root):
				ws_pkgs=set()
				for pat in patterns[:32]:
					if not isinstance(pat,str) or pat.startswith("!") or ".." in pat or pat.startswith("/"):
						continue
					for match in glob.glob(os.path.join(base,pat,"package.json")):
						if os.path.isfile(match) and not os.path.islink(match):
							ws_pkgs.add(os.path.relpath(match,base))
				for rel_pkg in sorted(ws_pkgs)[:128]:
					try:
						wdoc=json.loads(open(os.path.join(base,rel_pkg),"r",encoding="utf-8").read())
					except Exception:
						force_install=True
						continue
					if isinstance(wdoc,dict):
						if has_local_dep(wdoc):
							force_install=True
						wsub={k:wdoc.get(k) for k in DEP_KEYS if k in wdoc}
						wscripts=wdoc.get("scripts")
						if isinstance(wscripts,dict):
							ws_sub={k:wscripts[k] for k in SCRIPT_KEYS if k in wscripts}
							if ws_sub:
								wsub["scripts"]=ws_sub
						h.update(f"ws:{rel_pkg}\0".encode("utf-8"))
						h.update(json.dumps(wsub,sort_keys=True,separators=(",",":")).encode("utf-8"))
						h.update(b"\0")
digest=h.hexdigest()
stamp_path=os.path.join(ws_dir,".qorpera-deps-hash")
if sys.argv[1]=="write":
	if force_install:
		try:
			os.unlink(stamp_path)
		except OSError:
			pass
		sys.exit(0)
	present=[]
	if dir_non_empty(os.path.join(cwd_dir,"node_modules")):
		present.append("cwd")
	if os.path.realpath(cwd_dir)!=os.path.realpath(src_root) and dir_non_empty(os.path.join(src_root,"node_modules")):
		present.append("root")
	if present:
		tmp=stamp_path+".tmp"
		with open(tmp,"w",encoding="utf-8") as f:
			json.dump({"hash":digest,"present":present},f)
		os.replace(tmp,stamp_path)
	else:
		try:
			os.unlink(stamp_path)
		except OSError:
			pass
	sys.exit(0)
if force_install:
	print("INSTALL "+digest)
	sys.exit(0)
matched=False
try:
	if os.path.isfile(stamp_path) and not os.path.islink(stamp_path):
		saved=json.loads(open(stamp_path,"r",encoding="utf-8").read())
		if isinstance(saved,dict) and saved.get("hash")==digest and isinstance(saved.get("present"),list) and saved["present"]:
			ok=True
			for slot in saved["present"]:
				nm=os.path.join(cwd_dir if slot=="cwd" else src_root,"node_modules")
				if not dir_non_empty(nm):
					ok=False
					break
			matched=ok
except Exception:
	matched=False
print(("SKIP " if matched else "INSTALL ")+digest)`;

export const PREVIEW_WORKSPACE_CHECK = [
	...CODE_CHECKS_NEWER_RUN,
	'cd -- "$QORPERA_CHECK_CWD" || exit 2',
	`if [ -z "\${QORPERA_PREVIEW_INSTALL_CMD:-}" ]; then`,
	'\tbash --noprofile --norc -c "$QORPERA_CHECK_RUN" </dev/null 2>&1 | tee -- "$QORPERA_CHECK_LOG"',
	`\texit "\${PIPESTATUS[0]}"`,
	"fi",
	"_qorpera_deps() {",
	"python3 -I - \"$1\" <<'QORPERA_DEPS_HASH_EOF'",
	PREVIEW_DEPS_FINGERPRINT_PY,
	"QORPERA_DEPS_HASH_EOF",
	"}",
	'decision="$(_qorpera_deps check)" || decision="INSTALL"',
	'case "$decision" in',
	"\tSKIP\\ *)",
	'\t\tbash --noprofile --norc -c "$QORPERA_PREVIEW_BUILD_CMD" </dev/null 2>&1 | tee -- "$QORPERA_CHECK_LOG"',
	`\t\trc="\${PIPESTATUS[0]}"`,
	'\t\tif [ "$rc" -eq 0 ]; then exit 0; fi',
	'\t\tif [ "$rc" -eq 127 ] || grep -Eiq "Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find package|command not found|node_modules/.+ENOENT" "$QORPERA_CHECK_LOG"; then',
	'\t\t\trm -f -- "$QORPERA_PREVIEW_WORKSPACE_DIR/.qorpera-deps-hash"',
	'\t\t\tbash --noprofile --norc -c "$QORPERA_PREVIEW_INSTALL_CMD" </dev/null 2>&1 | tee -a -- "$QORPERA_CHECK_LOG"',
	`\t\t\tirc="\${PIPESTATUS[0]}"`,
	'\t\t\tif [ "$irc" -ne 0 ]; then exit "$irc"; fi',
	"\t\t\t_qorpera_deps write || true",
	'\t\t\tbash --noprofile --norc -c "$QORPERA_PREVIEW_BUILD_CMD" </dev/null 2>&1 | tee -a -- "$QORPERA_CHECK_LOG"',
	`\t\t\texit "\${PIPESTATUS[0]}"`,
	"\t\tfi",
	'\t\texit "$rc"',
	"\t\t;;",
	"\t*)",
	'\t\trm -f -- "$QORPERA_PREVIEW_WORKSPACE_DIR/.qorpera-deps-hash"',
	'\t\tbash --noprofile --norc -c "$QORPERA_PREVIEW_INSTALL_CMD" </dev/null 2>&1 | tee -- "$QORPERA_CHECK_LOG"',
	`\t\tirc="\${PIPESTATUS[0]}"`,
	'\t\tif [ "$irc" -ne 0 ]; then exit "$irc"; fi',
	"\t\t_qorpera_deps write || true",
	'\t\tbash --noprofile --norc -c "$QORPERA_PREVIEW_BUILD_CMD" </dev/null 2>&1 | tee -a -- "$QORPERA_CHECK_LOG"',
	`\t\texit "\${PIPESTATUS[0]}"`,
	"\t\t;;",
	"esac",
].join("\n");
