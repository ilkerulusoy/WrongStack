import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core';

export interface ClipboardImage {
  base64: string;
  mediaType: 'image/png';
  bytes: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const platform = process.platform;
  if (platform === 'win32') return readWindows();
  if (platform === 'darwin') return readDarwin();
  if (platform === 'linux') return readLinux();
  return null;
}

async function readWindows(): Promise<ClipboardImage | null> {
  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { Write-Output "NO_IMAGE"; exit 0 }',
    `$img.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output "OK"',
  ].join('; ');
  const out = await runCmd('powershell', ['-NoProfile', '-Command', ps]);
  if (!out || out.trim() === 'NO_IMAGE') return null;
  if (!out.includes('OK')) return null;
  return readPngFile(tmp);
}

async function readDarwin(): Promise<ClipboardImage | null> {
  // Guard: only attempt the PNG coercion when the clipboard actually holds an
  // image. Coercing a text/empty clipboard via `as «class PNGf»` raises an
  // AppleScript error and can perturb the Apple Events / pasteboard subsystem
  // (observed restarting Finder). `clipboard info` is side-effect free.
  const info = await runCmd('osascript', ['-e', 'clipboard info']);
  if (!info || !info.includes('PNGf')) return null;

  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const script = [
    'try',
    `  set the_file to (open for access POSIX file "${tmp}" with write permission)`,
    '  write (the clipboard as «class PNGf») to the_file',
    '  close access the_file',
    'on error',
    '  try',
    '    close access POSIX file "' + tmp + '"',
    '  end try',
    '  return "NO_IMAGE"',
    'end try',
    'return "OK"',
  ].join('\n');
  const out = await runCmd('osascript', ['-e', script]);
  if (!out || out.trim() !== 'OK') return null;
  return readPngFile(tmp);
}

async function readLinux(): Promise<ClipboardImage | null> {
  const tmp = path.join(os.tmpdir(), `wstack-clip-${Date.now()}.png`);
  const tries: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  for (const [cmd, args] of tries) {
    const ok = await runCmdToFile(cmd, args, tmp).catch(() => false);
    if (ok) return readPngFile(tmp);
  }
  return null;
}

async function readPngFile(p: string): Promise<ClipboardImage | null> {
  try {
    const buf = await fs.readFile(p);
    if (buf.length === 0) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      await fs.unlink(p).catch(() => undefined);
      throw new Error(`Clipboard image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
    }
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    await fs.unlink(p).catch(() => undefined);
    return { base64: buf.toString('base64'), mediaType: 'image/png', bytes: buf.length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Hard ceiling for a clipboard subprocess. Reading the clipboard must never
 * hang the TUI: on a headless/loaded CI runner the PowerShell/xclip/wl-paste
 * read can stall indefinitely (no display, slow shell start). After this we
 * kill the child and resolve the safe default.
 */
const CLIPBOARD_CMD_TIMEOUT_MS = 5_000;

function runCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, CLIPBOARD_CMD_TIMEOUT_MS);
    child.stdout.on('data', (c) => {
      out += String(c);
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code === 0 ? out : null));
  });
}

function runCmdToFile(cmd: string, args: string[], outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, CLIPBOARD_CMD_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => finish(false));
    child.on('exit', async (code) => {
      if (code !== 0 || chunks.length === 0) return finish(false);
      try {
        await fs.writeFile(outPath, Buffer.concat(chunks));
        finish(true);
      } catch {
        finish(false);
      }
    });
  });
}
