import { createHash } from "crypto";

/**
 * Builds one htpasswd line in the salted SHA-1 format ("{SSHA}") that nginx's
 * auth_basic module reads without any extra modules:
 *
 *     user:{SSHA}base64(sha1(password + salt) + salt)
 *
 * The hash is computed here, at deploy time, so the VMs only ever see the hash.
 * Supabase's own Envoy gateway uses the unsalted "{SHA}" form for its
 * dashboard login; the salted form is the same idea with a salt.
 */
export function sshaHtpasswdLine(username: string, password: string, salt: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new Error("htpasswd user names may only use letters, digits, '.', '_' and '-'");
  }
  if (salt.length === 0) {
    throw new Error("htpasswd salt must not be empty");
  }
  const saltBytes = Buffer.from(salt, "utf8");
  const digest = createHash("sha1").update(password, "utf8").update(saltBytes).digest();
  return `${username}:{SSHA}${Buffer.concat([digest, saltBytes]).toString("base64")}`;
}
