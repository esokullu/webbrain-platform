import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

async function downloadsBlocker(directory, fallbackMessage, readdir = fs.readdir, readFile = fs.readFile) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  if (!entries.length) return '';
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(`${directory}/${entry}`, 'utf8'));
      if (record?.upload_error?.status) {
        return `A browser download could not sync because shared storage returned ${record.upload_error.status}. Correct the storage quota or upload limit and restart the browser service to retry before pausing.`;
      }
    } catch {}
  }
  return fallbackMessage;
}

export async function prepareDropletForPause({
  profileMount = process.env.WEBBRAIN_PROFILE_MOUNT || '',
  downloadsStagingDir = process.env.WEBBRAIN_DOWNLOADS_STAGING_DIR || '/var/lib/webbrain/download-staging',
  execFileImpl = execFile,
  readdirImpl = fs.readdir,
  readFileImpl = fs.readFile,
} = {}) {
  if (!profileMount) {
    throw Object.assign(new Error('This browser does not have a persistent profile volume.'), { status: 409 });
  }

  const beforeStopBlocker = await downloadsBlocker(
    downloadsStagingDir,
    'Wait for browser downloads to finish syncing before pausing.',
    readdirImpl,
    readFileImpl,
  );
  if (beforeStopBlocker) throw Object.assign(new Error(beforeStopBlocker), { status: 409 });

  await execFileImpl('systemctl', ['stop', 'webbrain-browser.service']);
  try {
    const afterStopBlocker = await downloadsBlocker(
      downloadsStagingDir,
      'A browser download started while pausing. Wait for it to finish syncing and try again.',
      readdirImpl,
      readFileImpl,
    );
    if (afterStopBlocker) throw Object.assign(new Error(afterStopBlocker), { status: 409 });
    await execFileImpl('sync', []);
    const mounted = await execFileImpl('mountpoint', ['-q', profileMount]).then(() => true, () => false);
    if (mounted) await execFileImpl('umount', [profileMount]);
  } catch (error) {
    await execFileImpl('systemctl', ['start', 'webbrain-browser.service']).catch(() => {});
    throw error;
  }

  return { ready_to_detach: true };
}

export async function cancelDropletPause({
  profileMount = process.env.WEBBRAIN_PROFILE_MOUNT || '',
  execFileImpl = execFile,
} = {}) {
  if (!profileMount) {
    throw Object.assign(new Error('This browser does not have a persistent profile volume.'), { status: 409 });
  }
  const mounted = await execFileImpl('mountpoint', ['-q', profileMount]).then(() => true, () => false);
  if (!mounted) await execFileImpl('mount', [profileMount]);
  await execFileImpl('mountpoint', ['-q', profileMount]);
  await execFileImpl('systemctl', ['start', 'webbrain-browser.service']);
  await execFileImpl('systemctl', ['is-active', '--quiet', 'webbrain-browser.service']);
  return { resumed: true };
}
