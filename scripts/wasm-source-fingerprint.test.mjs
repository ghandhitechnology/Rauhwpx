import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./wasm-source-fingerprint.mjs', import.meta.url).pathname;

test('WASM cache fingerprint tracks engine inputs and ignores consumer apps', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-wasm-fingerprint-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const write = (name, contents) => {
    const file = path.join(repo, 'rhwp', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const commit = () => {
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Update fixture');
  };
  const fingerprint = () => execFileSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' }).trim();

  try {
    git('init', '-q');
    git('config', 'user.name', 'Cache test');
    git('config', 'user.email', 'cache-test@example.invalid');
    write('Cargo.toml', '[package]\nname = "rhwp"\n');
    write('Cargo.lock', 'lock 1');
    write('src/lib.rs', 'pub fn engine() {}');
    write('assets/fonts/font.woff2', 'font 1');
    write('rhwp-studio/src/main.ts', 'frontend 1');
    commit();
    const baseline = fingerprint();

    write('rhwp-studio/src/main.ts', 'frontend 2');
    write('rhwp-agent/server.mjs', 'agent 1');
    commit();
    assert.equal(fingerprint(), baseline);

    write('src/lib.rs', 'pub fn engine() { println!("changed"); }');
    commit();
    const source = fingerprint();
    assert.notEqual(source, baseline);

    write('assets/fonts/font.woff2', 'font 2');
    commit();
    const asset = fingerprint();
    assert.notEqual(asset, source);

    write('Cargo.lock', 'lock 2');
    commit();
    const manifest = fingerprint();
    assert.notEqual(manifest, asset);

    write('new-engine-dir/input.bin', 'new input');
    commit();
    const added = fingerprint();
    assert.notEqual(added, manifest);

    fs.rmSync(path.join(repo, 'rhwp/new-engine-dir/input.bin'));
    commit();
    assert.equal(fingerprint(), manifest);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
