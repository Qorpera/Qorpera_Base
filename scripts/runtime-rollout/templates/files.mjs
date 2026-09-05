import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, need } from './contract.mjs';

export function readTrusted(path, maximum = 4 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), entry = lstatSync(path);
    need(stat.isFile() && !entry.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
      && !(stat.mode & 0o022) && stat.size > 0 && stat.size <= maximum && stat.dev === entry.dev && stat.ino === entry.ino, 'FILE_REJECTED');
    const bytes = readFileSync(fd), after = fstatSync(fd), latest = lstatSync(path);
    need(bytes.length === stat.size && [after, latest].every(item => ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => item[key] === stat[key])), 'FILE_CHANGED');
    return bytes;
  } finally { closeSync(fd); }
}
export function assertDirectory(path) {
  const stat = lstatSync(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700 && realpathSync(path) === path, 'DIRECTORY_REJECTED');
}
export function assertAbsent(path) {
  try { lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return; throw Error('PATH_UNAVAILABLE'); }
  throw Error('PRIOR_ARTIFACT_EXISTS');
}
export function writeExclusive(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  need(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'WRITE_SIZE_REJECTED');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { let offset = 0; while (offset < bytes.length) { const wrote = writeSync(fd, bytes, offset); need(wrote > 0, 'WRITE_UNCONFIRMED'); offset += wrote; } fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  need(hash(readTrusted(path)) === hash(bytes), 'PRESERVATION_UNCONFIRMED');
  return { bytes: bytes.length, sha256: hash(bytes) };
}
