#!/usr/bin/env node
import { AuthService } from './auth.mjs';
import { parseConfig } from './config.mjs';
import { databasePragmas, openDatabase } from './database.mjs';
import { loadOrCreateServerIdentity } from './identity.mjs';
import { SecretVault } from './secret-vault.mjs';
import { ProviderCliManager, readSecretFromStdin } from './provider-cli.mjs';
import { ProviderManager } from './provider-manager.mjs';
import { BlobStore } from './blob-store.mjs';
import { SessionStore } from './session-store.mjs';

const config = parseConfig();
const database = openDatabase(config.databasePath);
const identity = loadOrCreateServerIdentity(config.dataDirectory);
const auth = new AuthService(database, { retrySecret: identity.privateKey });
const [command, action, ...rest] = process.argv.slice(2);
const vault = new SecretVault(database, { dataDirectory: config.dataDirectory });
const sessionStore = new SessionStore(database, new BlobStore(database, { root: config.blobDirectory }), {
  maxQueuedSessions: config.maxQueuedSessions,
});
const providerManager = new ProviderManager(sessionStore, {
  providerAuthDirectory: config.providerAuthDirectory,
  providerCliDirectory: config.providerCliDirectory,
  vault,
});
const providerCli = new ProviderCliManager(config, providerManager, vault);

try {
  if (command === 'pairing' && action === 'create') {
    const pairing = auth.createPairingCode({ intendedName: rest.join(' ') || null });
    console.log(JSON.stringify({ ...pairing, serverPublicKey: identity.serverPublicKey }));
  } else if (command === 'status') {
    const sessions = database.prepare(`
      SELECT status, COUNT(*) AS count FROM sessions GROUP BY status ORDER BY status
    `).all();
    console.log(JSON.stringify({
      database: databasePragmas(database),
      devices: auth.listDevices().length,
      sessions: Object.fromEntries(sessions.map((row) => [row.status, row.count])),
      serverPublicKey: identity.serverPublicKey,
    }));
  } else if (command === 'provider-secret' && action === 'set') {
    const [provider, name] = rest;
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    value = value.replace(/\r?\n$/, '');
    vault.set(provider, name, value);
    console.log(JSON.stringify({ provider, name, stored: true }));
  } else if (command === 'provider-secret' && action === 'delete') {
    const [provider, name] = rest;
    const deleted = vault.delete(provider, name);
    console.log(JSON.stringify({ provider, name, deleted }));
  } else if (command === 'provider' && action === 'install') {
    console.log(JSON.stringify(await providerCli.install(rest[0])));
  } else if (command === 'provider' && action === 'login') {
    const provider = rest[0];
    const apiKey = rest.includes('--api-key-stdin') ? await readSecretFromStdin() : null;
    console.log(JSON.stringify(await providerCli.login(provider, { apiKey })));
  } else if (command === 'provider' && action === 'seed-session') {
    console.log(JSON.stringify({
      seeded: true,
      providers: await providerCli.seedSession(),
    }));
  } else if (command === 'provider' && action === 'status') {
    console.log(JSON.stringify(await providerCli.status(rest[0])));
  } else if (command === 'doctor') {
    const result = await providerCli.doctor(action && action !== '--json' ? action : null);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error('Usage: cli.mjs pairing create [device-name] | status | doctor | provider install|login|status <provider> [--api-key-stdin] | provider seed-session | provider-secret set|delete <provider> <name>');
    process.exitCode = 2;
  }
} finally {
  database.close();
}
