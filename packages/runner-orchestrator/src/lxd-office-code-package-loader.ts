/** Fixed provider-owned loader. The selected bundle is measured from a held
 * descriptor BEFORE compilation. No guest module, path or environment can
 * supply executable loader text. Both processes verify the same pin. */
export const OFFICE_CODE_PACKAGE_LOADER = String.raw`(function run() {
  const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
  const { spawnSync } = require('node:child_process'), Module = require('node:module');
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0 || process.getgid() !== 0 || process.geteuid() !== 0)
      throw Error('root');
    const [purpose, id, sha, count, ...rest] = process.argv.slice(1);
    if (!['bootstrap','measure'].includes(purpose) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha) || !/^[1-9][0-9]{0,7}$/.test(count)) throw Error('arguments');
    const size = Number(count); if (size > 16*1024*1024) throw Error('size');
    const root='/run/qorpera-office-preparation', stage=root+'/code-package-'+id;
    const tool=stage+'/'+purpose+'.cjs';
    const keys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
    const same=(a,b)=>keys.every(k=>a[k]===b[k]);
    function local(fd) {
      const ids=[...fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8').matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
      const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(l=>l.split(' ',1)[0]===ids[0]?.[1]);
      if(ids.length!==1 || mounts.length!==1 || !['ext4','xfs','btrfs','zfs','overlay','tmpfs'].includes(mounts[0].split(' - ')[1]?.split(' ')[0])) throw Error('nonlocal');
    }
    function parents(p) {
      for (let q=p;;q=path.dirname(q)) {
        const s=fs.lstatSync(q);
        if (!s.isDirectory() || s.uid!==0 || s.gid!==0 || (s.mode&0o6022)!==0 || fs.realpathSync(q)!==q) throw Error('parent');
        if ((q===root || q===stage) && (s.mode&0o7777)!==0o700) throw Error('private');
        if (q==='/') break;
      }
    }
    parents(stage);
    const fd=fs.openSync(tool,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    let bytes;
    try {
      local(fd);
      const a=fs.fstatSync(fd,{bigint:true});
      if (!a.isFile() || a.uid!==0n || a.gid!==0n || a.nlink!==1n || (a.mode&0o7777n)!==0o400n || a.size!==BigInt(size)) throw Error('tool');
      bytes=Buffer.alloc(size+1); let n=0;
      while(n<bytes.length){const r=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!r)break;n+=r;}
      if(n!==size || !same(a,fs.fstatSync(fd,{bigint:true})) || !same(a,fs.lstatSync(tool,{bigint:true})) || crypto.createHash('sha256').update(bytes.subarray(0,n)).digest('hex')!==sha) throw Error('pin');
      bytes=bytes.subarray(0,n); parents(stage);
    } finally {fs.closeSync(fd);}
    if(rest[0]!=='--locked') {
      const lockPath=root+'/control.lock';
      const lock=fs.openSync(lockPath,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try {
        local(lock);
        const s=fs.fstatSync(lock,{bigint:true});
        if(!s.isFile() || s.uid!==0n || s.gid!==0n || s.nlink!==1n || s.size!==0n || (s.mode&0o7777n)!==0o600n || !same(s,fs.lstatSync(lockPath,{bigint:true}))) throw Error('lock');
        for(const exe of ['/usr/bin/node','/usr/bin/flock']) {
          parents(path.dirname(exe)); const x=fs.lstatSync(exe);
          if(!x.isFile() || x.uid!==0 || x.gid!==0 || x.nlink!==1 || (x.mode&0o6022)!==0 || fs.realpathSync(exe)!==exe) throw Error('executable');
        }
        const child=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','--no-fork','/proc/self/fd/3','/usr/bin/node','-e','('+run.toString()+')()',purpose,id,sha,count,'--locked',...rest],{cwd:'/',env:{},stdio:['ignore','inherit','inherit',lock],timeout:120000,killSignal:'SIGKILL'});
        if(child.error || child.status!==0) throw Error('child');
      } finally {fs.closeSync(lock);}
    } else {
      local(3);
      const held=fs.fstatSync(3,{bigint:true}), named=fs.lstatSync(root+'/control.lock',{bigint:true});
      if(!held.isFile() || held.uid!==0n || held.gid!==0n || held.nlink!==1n || held.size!==0n || (held.mode&0o7777n)!==0o600n || !same(held,named)) throw Error('inherited lock');
      const major=((held.dev>>8n)&0xfffn)|((held.dev>>32n)&0xfffff000n), minor=(held.dev&0xffn)|((held.dev>>12n)&0xffffff00n);
      const locks=fs.readFileSync('/proc/locks','utf8').split('\n').filter(line=>{
        const m=/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
        return m && Number(m[1])===process.pid && BigInt('0x'+m[2])===major && BigInt('0x'+m[3])===minor && BigInt(m[4])===held.ino;
      });
      if(locks.length!==1) throw Error('kernel flock');
      const compiled=new Module(tool); compiled.filename=tool; compiled.paths=[];
      compiled._compile(new TextDecoder('utf8',{fatal:true}).decode(bytes),tool);
      if(typeof compiled.exports.runOfficeCodePackageTool!=='function') throw Error('entry');
      Promise.resolve(compiled.exports.runOfficeCodePackageTool(purpose,id,rest.slice(1))).catch(()=>{process.stderr.write('OFFICE_CODE_PACKAGE_UNCONFIRMED\n');process.exitCode=1;});
    }
  } catch (_) {process.stderr.write('OFFICE_CODE_PACKAGE_LOADER_UNCONFIRMED\n');process.exitCode=1;}
})();`;

export const officeCodePackageStage = (provisionId: string): string => {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(provisionId))
		throw new Error("INVALID_CODE_PACKAGE_ID");
	return `/run/qorpera-office-preparation/code-package-${provisionId}`;
};
