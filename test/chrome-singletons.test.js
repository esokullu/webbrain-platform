import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanStaleChromeSingletons,
  findChromeProcessesForProfile,
} from '../src/droplet/chrome-singletons.js';

async function temporaryProfile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-singletons-'));
  const profileDir = path.join(root, 'chrome');
  await fs.mkdir(profileDir);
  return {
    profileDir,
    async close() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function addSingletons(profileDir, lockTarget = 'old-host-1234') {
  await fs.symlink(lockTarget, path.join(profileDir, 'SingletonLock'));
  await fs.symlink('cookie-token', path.join(profileDir, 'SingletonCookie'));
  await fs.symlink('/tmp/old-chrome/SingletonSocket', path.join(profileDir, 'SingletonSocket'));
}

test('Chrome profile process detection requires the exact user-data directory', async () => {
  const processes = {
    '101': '/opt/chrome-linux64/chrome\0--user-data-dir=/mnt/webbrain-profile/chrome\0',
    '102': '/opt/chrome-linux64/chrome\0--user-data-dir=/mnt/another-profile\0',
    '103': '/bin/bash\0--user-data-dir=/mnt/webbrain-profile/chrome\0',
  };
  const entries = Object.keys(processes).map(name => ({
    name,
    isDirectory: () => true,
  }));

  const matches = await findChromeProcessesForProfile('/mnt/webbrain-profile/chrome', {
    procDir: '/proc',
    readdirImpl: async () => entries,
    readFileImpl: async file => Buffer.from(processes[path.basename(path.dirname(file))]),
  });

  assert.deepEqual(matches, [101]);
});

test('stale Chrome singleton cleanup removes only the three exact entries', async () => {
  const profile = await temporaryProfile();
  try {
    await addSingletons(profile.profileDir);
    await fs.writeFile(path.join(profile.profileDir, 'Preferences'), '{}');

    const result = await cleanStaleChromeSingletons({
      profileDir: profile.profileDir,
      hostname: 'new-host',
      findProfileProcessesImpl: async () => [],
    });

    assert.deepEqual(result.removed, ['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
    assert.deepEqual(await fs.readdir(profile.profileDir), ['Preferences']);
  } finally {
    await profile.close();
  }
});

test('stale Chrome singleton cleanup refuses a profile used by a Chrome process', async () => {
  const profile = await temporaryProfile();
  try {
    await addSingletons(profile.profileDir);

    await assert.rejects(() => cleanStaleChromeSingletons({
      profileDir: profile.profileDir,
      findProfileProcessesImpl: async () => [4321],
    }), error => error.code === 'EBUSY' && /PID 4321/.test(error.message));

    assert.equal((await fs.readdir(profile.profileDir)).length, 3);
  } finally {
    await profile.close();
  }
});

test('stale Chrome singleton cleanup refuses a lock owned by a live local PID', async () => {
  const profile = await temporaryProfile();
  try {
    await addSingletons(profile.profileDir, 'current-host-9876');

    await assert.rejects(() => cleanStaleChromeSingletons({
      profileDir: profile.profileDir,
      hostname: 'current-host',
      findProfileProcessesImpl: async () => [],
      isProcessAliveImpl: pid => pid === 9876,
    }), error => error.code === 'EBUSY' && /live PID 9876/.test(error.message));

    assert.equal((await fs.readdir(profile.profileDir)).length, 3);
  } finally {
    await profile.close();
  }
});
