import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedHost, isPrivateIPv6, normalizeHost } from './private-network.js';

test('IPv4-mapped IPv6 is blocked in hex and dotted forms', () => {
  for (const host of [
    '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:10.0.0.5', '::ffff:a00:5',
    '::ffff:172.16.0.1', '::ffff:ac10:1',
    '::ffff:192.168.0.9', '::ffff:c0a8:9',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
  ]) {
    assert.equal(isPrivateIPv6(host), true, `${host} must be blocked`);
  }
  // 공용 IPv4 로의 매핑은 통과해야 한다
  assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateIPv6('::ffff:808:808'), false);
});

test('NAT64 64:ff9b::/96 follows embedded IPv4 rules', () => {
  assert.equal(isPrivateIPv6('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateIPv6('64:ff9b::c0a8:1'), true);
  assert.equal(isPrivateIPv6('64:ff9b::808:808'), false);
});

test('link-local, unique-local, discard-only, multicast and loopback are blocked', () => {
  for (const host of ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', '100::1', '100::2:1', 'ff02::1']) {
    assert.equal(isPrivateIPv6(host), true, `${host} must be blocked`);
  }
  for (const host of ['2001:db8::1', '2606:4700::6810:85e5', 'fec0::1', 'fb00::1']) {
    assert.equal(isPrivateIPv6(host), false, `${host} must not be blocked`);
  }
});

test('malformed IPv6 literals fail closed', () => {
  assert.equal(isPrivateIPv6('zz::bad'), true);
  assert.equal(isPrivateIPv6('1:2:3:4:5:6:7:8:9'), true);
});

test('isBlockedHost covers suffixes, single labels and URL hostnames', () => {
  assert.equal(isBlockedHost(new URL('http://[::ffff:127.0.0.1]/x').hostname), true);
  assert.equal(isBlockedHost(new URL('http://[64:ff9b::7f00:1]/x').hostname), true);
  assert.equal(isBlockedHost(new URL('http://[2606:4700::6810:85e5]/x').hostname), false);
  assert.equal(isBlockedHost('10.0.0.1'), true);
  assert.equal(isBlockedHost('192.168.1.1'), true);
  assert.equal(isBlockedHost('172.20.1.1'), true);
  assert.equal(isBlockedHost('169.254.1.1'), true);
  assert.equal(isBlockedHost('docs.example.com'), false);
  assert.equal(isBlockedHost('intranet'), true);
  assert.equal(isBlockedHost('foo.corp', { blockedSuffixes: ['.corp'] }), true);
});

test('normalizeHost strips brackets, trailing dots and case', () => {
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('EXAMPLE.com.'), 'example.com');
});
