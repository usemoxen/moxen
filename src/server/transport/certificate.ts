/**
 * The remote listener's TLS identity: a P-256 key and a self-signed
 * certificate over it, built here with `node:crypto` and a few lines of DER
 * rather than a dependency.
 *
 * Nothing about it is meant to be trusted through a CA. A client pins the
 * *public key's* fingerprint when it pairs and from then on accepts that key
 * and no other. Pinning the key rather than the certificate is what lets
 * the certificate be rebuilt from the key on every start: the key lives in
 * the OS keychain and nothing at all is written to disk. The subject, the
 * validity window and the absent extensions only need to be well-formed
 * enough for TLS stacks to load the certificate.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

export interface TlsIdentity {
  /** PEM certificate: public, rebuilt from the key whenever it is needed. */
  readonly cert: string;
  /** PEM PKCS#8 private key: a credential, kept only in the keychain. */
  readonly key: string;
  /** The pin clients compare against (`keyFingerprint`). */
  readonly fingerprint: string;
}

const VALIDITY_YEARS = 20;

/** `ecdsa-with-SHA256`, `id-ecPublicKey`'s signature partner. */
const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";

/** A new P-256 private key, PEM PKCS#8. */
export function createTlsKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

/** The identity for `key`: the key, a fresh self-signed certificate over it, and its pin. */
export function tlsIdentity(key: string, commonName = "moxen", now = new Date()): TlsIdentity {
  const privateKey = createPrivateKey(key);
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  // Back-dated a day, so a client whose clock runs slow still loads it.
  const notBefore = new Date(now.getTime() - 86_400_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  // Positive and non-zero: clear the top bit, set the next one.
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;

  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const name = sequence(set(sequence(oid(COMMON_NAME), tlv(0x0c, Buffer.from(commonName, "utf8")))));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem("CERTIFICATE", der), key, fingerprint: spkiFingerprint(spki) };
}

/**
 * The pin: SHA-256 of the public key (SubjectPublicKeyInfo DER) inside a
 * certificate, PEM or raw DER — what a client checks the server's
 * certificate against. Colon-separated upper-case hex, so a user can compare
 * it by eye.
 */
export function keyFingerprint(cert: string | Buffer): string {
  const publicKey: KeyObject = new X509Certificate(cert).publicKey;
  return spkiFingerprint(publicKey.export({ type: "spki", format: "der" }));
}

function spkiFingerprint(spki: Buffer): string {
  return createHash("sha256")
    .update(spki)
    .digest("hex")
    .toUpperCase()
    .replace(/(..)(?!$)/g, "$1:");
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function tlv(tag: number, value: Buffer): Buffer {
  const length = value.length;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, value]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

/** An unsigned big-endian integer; a leading zero keeps it positive. */
function integer(value: Buffer): Buffer {
  return tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift(0x80 | (value & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime through 2049 and GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}
