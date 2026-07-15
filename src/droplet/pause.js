import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

async function directoryHasEntries(directory, readdir = fs.readdir) {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareDropletForPause({
  profileMount = process.env.WEBBRAIN_PROFILE_MOUNT || '',
  downloadsStagingDir = process.env.WEBBRAIN_DOWNLOADS_STAGING_DIR || '/var/lib/webbrain/download-staging',
  execFileImpl = execFile,
  readdirImpl = fs.readdir,
} = {}) {
  if (!profileMount) {
    throw Object.assign(new Error('This browser does not have a persistent profile volume.'), { status: 409 });
  }

  if (await directoryHasEntries(downloadsStagingDir, readdirImpl)) {
    throw Object.assign(new Error('Wait for browser downloads to finish syncing before pausing.'), { status: 409 });
  }

  await execFileImpl('systemctl', ['stop', 'webbrain-browser.service']);
  try {
    if (await directoryHasEntries(downloadsStagingDir, readdirImpl)) {
      throw Object.assign(new Error('A browser download started while pausing. Wait for it to finish syncing and try again.'), { status: 409 });
    }
    await execFileImpl('sync', []);
    const mounted = await execFileImpl('mountpoint', ['-q', profileMount]).then(() => true, () => false);
    if (mounted) await execFileImpl('umount', [profileMount]);
  } catch (error) {
    await execFileImpl('systemctl', ['start', 'webbrain-browser.service']).catch(() => {});
    throw error;
  }

  return { ready_to_detach: true };
}

export async function cancelDropletPause({ execFileImpl = execFile } = {}) {
  await execFileImpl('systemctl', ['start', 'webbrain-browser.service']);
  return { resumed: true };
}
