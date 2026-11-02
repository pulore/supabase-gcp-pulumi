import { X509Certificate } from "crypto";

/**
 * SHA-256 fingerprint of a PEM certificate as uppercase hex without colons,
 * the form Outline's installer writes as `certSha256`.
 */
export function certSha256Hex(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toUpperCase();
}

/**
 * The JSON that Outline Manager asks for when you add a server you installed
 * yourself ("Set up Outline anywhere"). It's the same JSON Outline's
 * install_server.sh prints at the end.
 */
export function outlineManagerConfig(apiUrl: string, certPem: string): string {
  return JSON.stringify({ apiUrl, certSha256: certSha256Hex(certPem) });
}
