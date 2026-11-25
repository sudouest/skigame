import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HttpsCertConfig {
  readonly key: Buffer;
  readonly cert: Buffer;
}

export interface ResolveDevHttpsOptions {
  readonly certDir?: string;
  readonly keyPath?: string;
  readonly certPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

interface CertMetadata {
  readonly sans?: unknown;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_CERT_DIR_NAME = '.certs';
const KEY_FILENAME = 'dev-key.pem';
const CERT_FILENAME = 'dev-cert.pem';
const META_FILENAME = 'dev-cert-meta.json';
const EXPIRY_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Collects Subject Alternative Names (SANs) for local loopback and all active
 * non-internal IPv4 LAN addresses so phones and tablets on local Wi-Fi match
 * the TLS certificate cleanly.
 */
export function collectLocalSans(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const baseSans = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1'];
  const lanIps = new Set<string>();

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (!info || info.internal) continue;
      const family = info.family as string | number;
      if ((family === 'IPv4' || family === 4) && info.address) {
        lanIps.add(`IP:${info.address}`);
      }
    }
  }

  return [...baseSans, ...Array.from(lanIps).sort()];
}

function sansEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readExistingCertIfValid(
  keyPath: string,
  certPath: string,
  metaPath: string,
  expectedSans: readonly string[],
): HttpsCertConfig | null {
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath) || !fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as CertMetadata;

    if (!Array.isArray(meta.sans) || !meta.sans.every((entry) => typeof entry === 'string')) {
      return null;
    }
    if (!sansEqual(meta.sans, expectedSans)) {
      return null;
    }

    const keyStat = fs.statSync(keyPath);
    if ((keyStat.mode & 0o077) !== 0) {
      fs.chmodSync(keyPath, 0o600);
    }

    const x509 = new X509Certificate(cert);
    const privateKey = createPrivateKey(key);
    if (!x509.checkPrivateKey(privateKey)) {
      return null;
    }

    const validFromMs = Date.parse(x509.validFrom);
    const validToMs = Date.parse(x509.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) {
      return null;
    }
    if (validFromMs > now || validToMs <= now + EXPIRY_SAFETY_MARGIN_MS) {
      return null;
    }

    return { key, cert };
  } catch {
    return null;
  }
}

/**
 * Resolves TLS certificate and private key buffers for Vite's local dev/preview HTTPS server.
 *
 * Resolution order:
 * 1. Explicit `HTTPS_KEY` + `HTTPS_CERT` paths (e.g., from `mkcert`).
 * 2. Cached 90-day ECDSA P-256 self-signed cert in `<certDir>` (default `<repo>/.certs`)
 *    regenerated automatically when missing, invalid, near expiry, or when LAN IPs change.
 */
export function resolveDevHttpsConfig(options: ResolveDevHttpsOptions = {}): HttpsCertConfig {
  const env = options.env ?? process.env;
  const customKeyPath = options.keyPath ?? env.HTTPS_KEY;
  const customCertPath = options.certPath ?? env.HTTPS_CERT;

  if (Boolean(customKeyPath) !== Boolean(customCertPath)) {
    throw new Error(
      'Both HTTPS_KEY and HTTPS_CERT must be set together when providing a custom TLS certificate.',
    );
  }

  if (customKeyPath && customCertPath) {
    if (!fs.existsSync(customKeyPath)) {
      throw new Error(`HTTPS_KEY file does not exist: ${customKeyPath}`);
    }
    if (!fs.existsSync(customCertPath)) {
      throw new Error(`HTTPS_CERT file does not exist: ${customCertPath}`);
    }
    return {
      key: fs.readFileSync(customKeyPath),
      cert: fs.readFileSync(customCertPath),
    };
  }

  const certDir = options.certDir ?? path.resolve(REPO_ROOT, DEFAULT_CERT_DIR_NAME);
  const keyPath = path.join(certDir, KEY_FILENAME);
  const certPath = path.join(certDir, CERT_FILENAME);
  const metaPath = path.join(certDir, META_FILENAME);
  const sans = collectLocalSans(options.interfaces);

  const cached = readExistingCertIfValid(keyPath, certPath, metaPath, sans);
  if (cached) {
    return cached;
  }

  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(certDir, 0o700);

  try {
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
        '90',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=skigame-dev',
        '-addext',
        `subjectAltName=${sans.join(',')}`,
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature',
        '-addext',
        'extendedKeyUsage=serverAuth',
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to generate local HTTPS certificate via openssl (${detail}). ` +
        'Install openssl, provide custom mkcert files via HTTPS_KEY and HTTPS_CERT, ' +
        'or set DISABLE_HTTPS=1 to opt out of HTTPS.',
    );
  }

  fs.chmodSync(keyPath, 0o600);
  fs.writeFileSync(metaPath, `${JSON.stringify({ sans }, null, 2)}\n`, 'utf8');

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}
