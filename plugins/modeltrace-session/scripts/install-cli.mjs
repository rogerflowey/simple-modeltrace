import { chmod, mkdir, readlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../bin/modeltrace', import.meta.url));
const directory = process.argv[2] || path.join(os.homedir(), '.local/bin');
const target = path.join(directory, 'modeltrace');
try {
  await mkdir(directory, { recursive: true });
  await chmod(source, 0o755);
  try { await symlink(source, target); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readlink(target).catch(() => null) !== source) throw error;
  }
  console.log(`Installed ${target}\nInside Codex: !modeltrace status`);
} catch (error) {
  console.error(`Cannot install modeltrace: ${error.message}`);
  process.exitCode = 1;
}
