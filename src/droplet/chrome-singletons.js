import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SINGLETON_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function busyError(message) {
  return Object.assign(new Error(message), { code: 'EBUSY' });
}

function lockOwner(target) {
  const separator = target.lastIndexOf('-');
  if (separator < 1) return null;
  const pid = Number(target.slice(separator + 1));
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return { hostname: target.slice(0, separator), pid };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function findChromeProcessesForProfile(profileDir, {
  procDir = '/proc',
  readdirImpl = fs.readdir,
  readFileImpl = fs.readFile,
} = {}) {
  const entries = await readdirImpl(procDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const expectedArgument = `--user-data-dir=${profileDir}`;
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    const cmdline = await readFileImpl(path.join(procDir, entry.name, 'cmdline'))
      .catch(error => {
        if (['EACCES', 'ENOENT', 'ESRCH'].includes(error.code)) return null;
        throw error;
      });
    if (!cmdline) continue;
    const args = cmdline.toString().split('\0').filter(Boolean);
    const executable = path.basename(args[0] || '');
    if ((executable === 'chrome' || executable === 'chromium') && args.includes(expectedArgument)) {
      matches.push(Number(entry.name));
    }
  }
  return matches;
}

export async function cleanStaleChromeSingletons({
  profileDir = process.env.WEBBRAIN_PROFILE_DIR || '',
  hostname = os.hostname(),
  findProfileProcessesImpl = findChromeProcessesForProfile,
  isProcessAliveImpl = processIsAlive,
  lstatImpl = fs.lstat,
  readlinkImpl = fs.readlink,
  unlinkImpl = fs.unlink,
} = {}) {
  if (!profileDir || !path.isAbsolute(profileDir)) {
    throw new Error('WEBBRAIN_PROFILE_DIR must be an absolute path before Chrome singleton cleanup.');
  }

  const activePids = await findProfileProcessesImpl(profileDir);
  if (activePids.length) {
    throw busyError(`Refusing to remove Chrome singleton entries while the profile is used by PID ${activePids.join(', ')}.`);
  }

  const singletonPaths = SINGLETON_NAMES.map(name => path.join(profileDir, name));
  const lockPath = singletonPaths[0];
  const lockStat = await lstatImpl(lockPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (lockStat?.isSymbolicLink()) {
    const owner = lockOwner(await readlinkImpl(lockPath));
    if (owner?.hostname === hostname && isProcessAliveImpl(owner.pid)) {
      throw busyError(`Refusing to remove Chrome singleton entries owned by live PID ${owner.pid}.`);
    }
  }

  const removed = [];
  for (let index = 0; index < singletonPaths.length; index += 1) {
    const singletonPath = singletonPaths[index];
    const stat = await lstatImpl(singletonPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isDirectory()) {
      throw new Error(`Refusing to remove unexpected Chrome singleton directory: ${singletonPath}`);
    }
    await unlinkImpl(singletonPath);
    removed.push(SINGLETON_NAMES[index]);
  }

  return { removed };
}
