import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sshaHtpasswdLine } from "../lib/htpasswd";
import { certSha256Hex, outlineManagerConfig } from "../lib/outline";
import { startupScript } from "../lib/startup-script";
import { TEST_CERT_PEM, TEST_CERT_SHA256 } from "./helpers/mocks";

describe("sshaHtpasswdLine", () => {
  it("matches a hash computed independently with openssl", () => {
    // (printf 'correct-horse-battery-staple'; printf '0123456789abcdef') | openssl sha1 -binary,
    // then the salt appended and the whole thing base64-encoded.
    assert.equal(
      sshaHtpasswdLine("supabase", "correct-horse-battery-staple", "0123456789abcdef"),
      "supabase:{SSHA}jJDPtm3eC9w0HfZAhbCpwak60TAwMTIzNDU2Nzg5YWJjZGVm",
    );
  });

  it("refuses user names that would break the htpasswd line", () => {
    assert.throws(() => sshaHtpasswdLine("admin:x", "password", "salt"));
    assert.throws(() => sshaHtpasswdLine("ad min", "password", "salt"));
    assert.throws(() => sshaHtpasswdLine("admin", "password", ""));
  });
});

describe("Outline Manager config", () => {
  it("formats the certificate fingerprint the way Outline's installer does", () => {
    assert.equal(certSha256Hex(TEST_CERT_PEM), TEST_CERT_SHA256);
  });

  it("is the apiUrl and certSha256 JSON that Outline Manager accepts", () => {
    assert.deepEqual(JSON.parse(outlineManagerConfig("https://203.0.113.10:8443/prefix", TEST_CERT_PEM)), {
      apiUrl: "https://203.0.113.10:8443/prefix",
      certSha256: TEST_CERT_SHA256,
    });
  });
});

describe("startupScript", () => {
  for (const name of ["supabase-studio", "outline-vpn"] as const) {
    it(`builds ${name} as one bash script with the shared helpers first`, () => {
      const script = startupScript(name);
      assert.ok(script.startsWith("#!/bin/bash\n"));
      assert.equal(script.match(/^#!/gm)?.length, 1);
      assert.match(script, /^set -euo pipefail$/m);
      assert.ok(script.indexOf("read_secret()") < script.indexOf("read_secret \""));
    });
  }
});
