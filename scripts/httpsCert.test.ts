import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { collectLocalSans, resolveDevHttpsConfig } from './httpsCert';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skigame-https-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('httpsCert local TLS certificate helper', () => {
  it('collects loopback and sorted non-internal IPv4 LAN SANs', () => {
    const sans = collectLocalSans({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      wlan0: [
        {
          address: '192.168.1.42',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.1.42/24',
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 2,
        },
      ],
      eth0: [
        {
          address: '10.0.0.15',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:66',
          internal: false,
          cidr: '10.0.0.15/24',
        },
      ],
    });

    expect(sans).toEqual([
      'DNS:localhost',
      'IP:127.0.0.1',
      'IP:::1',
      'IP:10.0.0.15',
      'IP:192.168.1.42',
    ]);
  });

  it('generates, caches, and regenerates ECDSA SAN certificates when LAN IPs change', () => {
    const certDir = makeTempDir();
    const interfacesA = {
      wlan0: [
        {
          address: '192.168.1.42',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.1.42/24',
        },
      ],
    };

    const first = resolveDevHttpsConfig({ certDir, interfaces: interfacesA, env: {} });
    const x509First = new X509Certificate(first.cert);
    expect(x509First.subjectAltName).toContain('DNS:localhost');
    expect(x509First.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(x509First.subjectAltName).toContain('IP Address:192.168.1.42');
    expect(fs.statSync(path.join(certDir, 'dev-key.pem')).mode & 0o777).toBe(0o600);

    // Second call with identical SANs reuses the cached cert
    const second = resolveDevHttpsConfig({ certDir, interfaces: interfacesA, env: {} });
    const x509Second = new X509Certificate(second.cert);
    expect(x509Second.serialNumber).toBe(x509First.serialNumber);

    // Changing LAN IP triggers regeneration with updated SAN
    const interfacesB = {
      wlan0: [
        {
          address: '192.168.1.99',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.1.99/24',
        },
      ],
    };
    const third = resolveDevHttpsConfig({ certDir, interfaces: interfacesB, env: {} });
    const x509Third = new X509Certificate(third.cert);
    expect(x509Third.serialNumber).not.toBe(x509First.serialNumber);
    expect(x509Third.subjectAltName).toContain('IP Address:192.168.1.99');
  });

  it('supports custom HTTPS_KEY and HTTPS_CERT env overrides and validates pairing', () => {
    const certDir = makeTempDir();
    const generated = resolveDevHttpsConfig({ certDir, interfaces: {}, env: {} });
    const keyPath = path.join(certDir, 'dev-key.pem');
    const certPath = path.join(certDir, 'dev-cert.pem');

    const loaded = resolveDevHttpsConfig({
      certDir: path.join(certDir, 'unused'),
      env: { HTTPS_KEY: keyPath, HTTPS_CERT: certPath },
    });
    expect(loaded.key.equals(generated.key)).toBe(true);
    expect(loaded.cert.equals(generated.cert)).toBe(true);

    expect(() =>
      resolveDevHttpsConfig({ env: { HTTPS_KEY: keyPath } }),
    ).toThrow(/HTTPS_KEY.*HTTPS_CERT/);
  });

  it('regenerates near-expiry, corrupt metadata, and mismatched key/cert caches', () => {
    const certDir = makeTempDir();
    const initial = resolveDevHttpsConfig({ certDir, interfaces: {}, env: {} });
    const initialSerial = new X509Certificate(initial.cert).serialNumber;

    // 1. Corrupt metadata forces regeneration
    fs.writeFileSync(path.join(certDir, 'dev-cert-meta.json'), '{bad-json', 'utf8');
    const afterBadMeta = resolveDevHttpsConfig({ certDir, interfaces: {}, env: {} });
    const serialAfterMeta = new X509Certificate(afterBadMeta.cert).serialNumber;
    expect(serialAfterMeta).not.toBe(initialSerial);

    // 2. Mismatched private key (different keypair) forces regeneration
    const otherDir = makeTempDir();
    const other = resolveDevHttpsConfig({ certDir: otherDir, interfaces: {}, env: {} });
    fs.writeFileSync(path.join(certDir, 'dev-key.pem'), other.key);
    const afterMismatch = resolveDevHttpsConfig({ certDir, interfaces: {}, env: {} });
    const serialAfterMismatch = new X509Certificate(afterMismatch.cert).serialNumber;
    expect(serialAfterMismatch).not.toBe(serialAfterMeta);

    // 3. Near-expiry cert (< 24h remaining, e.g. 1-day cert) triggers regeneration
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-sha256',
        '-days',
        '1',
        '-nodes',
        '-keyout',
        path.join(certDir, 'dev-key.pem'),
        '-out',
        path.join(certDir, 'dev-cert.pem'),
        '-subj',
        '/CN=expiring-soon',
      ],
      { stdio: 'pipe' },
    );
    const expiringSerial = new X509Certificate(
      fs.readFileSync(path.join(certDir, 'dev-cert.pem')),
    ).serialNumber;
    const renewed = resolveDevHttpsConfig({ certDir, interfaces: {}, env: {} });
    expect(new X509Certificate(renewed.cert).serialNumber).not.toBe(expiringSerial);
  });

  it('keeps vite.config.ts build and vitest/DISABLE_HTTPS modes free of HTTPS cert side effects', async () => {
    const configFn = viteConfig as (env: { command: 'build' | 'serve'; mode: string }) => Record<string, unknown>;
    const buildCfg = await Promise.resolve(configFn({ command: 'build', mode: 'production' }));
    expect(buildCfg.server).toBeUndefined();
    expect(buildCfg.preview).toBeUndefined();

    const prevDisable = process.env.DISABLE_HTTPS;
    process.env.DISABLE_HTTPS = '1';
    try {
      const disabledServeCfg = await Promise.resolve(configFn({ command: 'serve', mode: 'development' }));
      expect(disabledServeCfg.server).toBeUndefined();
      expect(disabledServeCfg.preview).toBeUndefined();
    } finally {
      if (prevDisable === undefined) delete process.env.DISABLE_HTTPS;
      else process.env.DISABLE_HTTPS = prevDisable;
    }
  });
});
