/** Download a run's logs (zip) and print the health-check output lines. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNER = 'sachin5678';
const REPO = 'new-age-algos-market-intelligence';
const runId = process.argv[2];

const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true,
  timeout: 20000,
});
const kv = {};
for (const line of out.split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
}
const auth = `Basic ${Buffer.from(`${kv.username}:${kv.password}`).toString('base64')}`;

const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/logs`, {
  headers: { authorization: auth, accept: 'application/vnd.github+json', 'user-agent': 'setup' },
  redirect: 'manual',
});
let url = res.headers.get('location');
if (!url) {
  const buf = Buffer.from(await res.arrayBuffer());
  url = null;
  fs.writeFileSync(path.join(os.tmpdir(), 'runlogs.zip'), buf);
}
const file = path.join(os.tmpdir(), 'runlogs.zip');
if (url) {
  const r2 = await fetch(url);
  fs.writeFileSync(file, Buffer.from(await r2.arrayBuffer()));
}
console.log('downloaded', fs.statSync(file).size, 'bytes');

// PowerShell unzip
const ps = `$z='${file}'; $d=Join-Path $env:TEMP 'runlogs'; if(Test-Path $d){Remove-Item $d -Recurse -Force}; Expand-Archive $z $d; Get-ChildItem -Recurse -File $d | ForEach-Object { $_.FullName }`;
const files = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
console.log(files);

for (const f of files.split(/\r?\n/).filter(Boolean)) {
  const txt = fs.readFileSync(f, 'utf8');
  if (/telegram|delivery|health|error|fail/i.test(txt)) {
    console.log('==== ' + path.basename(f));
    for (const line of txt.split(/\r?\n/)) {
      if (/telegram|delivery|health|error|fail|healthy|bot/i.test(line)) console.log('   ' + line.slice(0, 300));
    }
  }
}
