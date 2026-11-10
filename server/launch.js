// Runs one service command and writes its output to a log file: node launch.js <log> <folder> <command>
//
// The portal starts this small process detached, so the service keeps running when the portal
// stops. It exists because on Windows a shell started detached loses the output of the programs it
// runs; started from here (not detached) the output reaches the log. Exits with the command's code.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [log, folder, command] = process.argv.slice(2);
const fd = fs.openSync(log, 'a', 0o600);
const child = spawn(command, { cwd: folder, shell: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, FORCE_COLOR: '0' } });
fs.closeSync(fd);
child.on('error', (e) => {
  fs.appendFileSync(log, `${e.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill(sig); });
