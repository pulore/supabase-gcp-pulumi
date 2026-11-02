import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PRESETS, PRESET_NAMES, RawConfig, resolveConfig } from "../config";

const BASE: RawConfig = {
  stack: "dev",
  projectId: "test-project",
  region: "europe-west2",
  zone: "europe-west2-a",
  domain: "studio.example.com",
};

describe("resolveConfig", () => {
  it("defaults to the small preset and a prefix built from the stack name", () => {
    const config = resolveConfig(BASE);
    assert.equal(config.presetName, "small");
    assert.equal(config.namePrefix, "supabase-dev");
    for (const [key, value] of Object.entries(PRESETS.small.database)) {
      assert.deepEqual(config.database[key as keyof typeof config.database], value, `database.${key}`);
    }
    for (const [key, value] of Object.entries(PRESETS.small.studio)) {
      assert.deepEqual(config.studio[key as keyof typeof config.studio], value, `studio.${key}`);
    }
    assert.equal(config.database.databaseName, "postgres");
    assert.equal(config.database.databaseVersion, "POSTGRES_18");
    assert.equal(config.vpn.zone, "europe-west2-a");
    assert.equal(config.enableIapSsh, true);
  });

  it("resolves every preset as written, without overrides", () => {
    for (const name of PRESET_NAMES) {
      const config = resolveConfig({ ...BASE, preset: name });
      assert.equal(config.presetName, name);
      assert.deepEqual(config.network, PRESETS[name].network, `${name}: network`);
      for (const section of ["database", "studio", "vpn"] as const) {
        const resolved: Record<string, unknown> = { ...config[section] };
        for (const [key, value] of Object.entries(PRESETS[name][section])) {
          assert.deepEqual(resolved[key], value, `${name}: ${section}.${key}`);
        }
      }
    }
  });

  it("makes production-4vcpu the production preset with a 4-vCPU, 32 GB database", () => {
    const config = resolveConfig({ ...BASE, preset: "production-4vcpu" });
    const production = resolveConfig({ ...BASE, preset: "production" });
    assert.equal(config.database.edition, "ENTERPRISE_PLUS");
    assert.equal(config.database.tier, "db-perf-optimized-N-4");
    // Everything else matches production: the standby zone, Data Cache,
    // backups, deletion protection, disk, Studio VMs and VPN.
    assert.deepEqual({ ...config.database, tier: production.database.tier }, production.database);
    assert.deepEqual(config.network, production.network);
    assert.deepEqual(config.studio, production.studio);
    assert.deepEqual(config.vpn, production.vpn);
  });

  it("lets stack config override single fields and keeps the rest of the preset", () => {
    const config = resolveConfig({
      ...BASE,
      preset: "production",
      database: { tier: "db-perf-optimized-N-16" },
      studio: { minReplicas: 3, maxReplicas: 6 },
      vpn: { zone: "europe-west2-c", accessKeyPort: 4443 },
    });
    assert.equal(config.database.tier, "db-perf-optimized-N-16");
    assert.equal(config.database.availabilityType, "REGIONAL");
    assert.equal(config.database.deletionProtection, true);
    assert.equal(config.studio.minReplicas, 3);
    assert.equal(config.studio.maxReplicas, 6);
    assert.equal(config.studio.machineType, PRESETS.production.studio.machineType);
    assert.equal(config.vpn.zone, "europe-west2-c");
    assert.equal(config.vpn.accessKeyPort, 4443);
  });

  it("shortens long stack names to a valid prefix", () => {
    const config = resolveConfig({ ...BASE, stack: "Feature_Branch-With-A-Long-Name" });
    assert.equal(config.namePrefix, "supabase-feature-bra");
  });

  it("lets the teardown behaviour of the Cloud SQL peering be overridden", () => {
    const config = resolveConfig({ ...BASE, preset: "production", network: { privateServicesDeletionPolicy: "REMOVE_PEERING" } });
    assert.equal(config.network.privateServicesDeletionPolicy, "REMOVE_PEERING");
    assert.throws(() => resolveConfig({ ...BASE, network: { privateServicesDeletionPolicy: "ABANDON" } }), /DELETE or REMOVE_PEERING/);
  });

  it("rejects preset names it doesn't know, and lists the ones it does", () => {
    assert.throws(
      () => resolveConfig({ ...BASE, preset: "production-4" }),
      /preset must be one of small, production-4vcpu, production, got "production-4"/,
    );
  });

  it("rejects unknown keys instead of ignoring them", () => {
    assert.throws(() => resolveConfig({ ...BASE, studio: { minReplica: 2 } }), /unknown key "studio\.minReplica"/);
  });

  it("checks value types", () => {
    assert.throws(() => resolveConfig({ ...BASE, database: { diskSizeGb: "100" } }), /database\.diskSizeGb must be a number/);
  });

  it("requires the project, region, zone and domain", () => {
    assert.throws(() => resolveConfig({ ...BASE, projectId: undefined }), /gcp:project is required/);
    assert.throws(() => resolveConfig({ ...BASE, region: undefined }), /gcp:region is required/);
    assert.throws(() => resolveConfig({ ...BASE, zone: undefined }), /gcp:zone is required/);
    assert.throws(() => resolveConfig({ ...BASE, domain: undefined }), /domain is required/);
    assert.throws(() => resolveConfig({ ...BASE, domain: "https://studio.example.com" }), /domain must be a hostname/);
  });

  it("keeps edition-specific settings consistent", () => {
    assert.throws(() => resolveConfig({ ...BASE, database: { dataCacheEnabled: true } }), /dataCacheEnabled needs database\.edition ENTERPRISE_PLUS/);
    assert.throws(() => resolveConfig({ ...BASE, database: { tier: "db-perf-optimized-N-2" } }), /needs database\.edition ENTERPRISE_PLUS/);
    assert.throws(() => resolveConfig({ ...BASE, preset: "production", database: { tier: "db-custom-2-7680" } }), /isn't an Enterprise Plus tier/);
    assert.throws(() => resolveConfig({ ...BASE, database: { transactionLogRetentionDays: 14 } }), /transactionLogRetentionDays must be an integer from 1 to 7/);
    assert.doesNotThrow(() => resolveConfig({ ...BASE, preset: "production", database: { transactionLogRetentionDays: 14 } }));
  });

  it("rejects Cloud SQL machine series that need Hyperdisk, since the instance uses SSD storage", () => {
    assert.throws(() => resolveConfig({ ...BASE, preset: "production", database: { tier: "db-perf-optimized-C4-4" } }), /needs Hyperdisk storage/);
    assert.throws(() => resolveConfig({ ...BASE, preset: "production", database: { tier: "db-c4a-highmem-4" } }), /needs Hyperdisk storage/);
    assert.throws(() => resolveConfig({ ...BASE, database: { tier: "db-custom-N4-4-16384" } }), /needs Hyperdisk storage/);
    assert.doesNotThrow(() => resolveConfig({ ...BASE, preset: "production", database: { tier: "db-perf-optimized-N-2" } }));
    assert.doesNotThrow(() => resolveConfig({ ...BASE, database: { tier: "db-custom-4-16384" } }));
  });

  it("rejects instance group bounds that don't make sense", () => {
    assert.throws(() => resolveConfig({ ...BASE, studio: { minReplicas: 3, maxReplicas: 2 } }), /studio\.maxReplicas must be an integer from 3/);
    assert.throws(() => resolveConfig({ ...BASE, studio: { minReplicas: 0 } }), /studio\.minReplicas/);
    assert.throws(() => resolveConfig({ ...BASE, studio: { zones: ["us-central1-a"] } }), /isn't in region europe-west2/);
  });

  it("rejects VPN settings that would break the server or its firewall", () => {
    assert.throws(() => resolveConfig({ ...BASE, zone: "us-central1-a" }), /isn't in region europe-west2/);
    assert.throws(() => resolveConfig({ ...BASE, vpn: { apiPort: 443 } }), /must be different/);
    assert.throws(() => resolveConfig({ ...BASE, vpn: { accessKeyPort: 22 } }), /can't be 22/);
    assert.throws(() => resolveConfig({ ...BASE, vpn: { apiPort: 9091 } }), /9090-9099/);
    assert.throws(() => resolveConfig({ ...BASE, vpn: { managementSourceRanges: ["not-a-range"] } }), /isn't an IPv4 range/);
  });

  it("rejects allowlist entries that would open Studio to everyone", () => {
    assert.throws(() => resolveConfig({ ...BASE, allowedSourceRanges: ["0.0.0.0/0"] }), /other than 0\.0\.0\.0\/0/);
    assert.throws(() => resolveConfig({ ...BASE, allowedSourceRanges: ["2001:db8::/32"] }), /must be an IPv4 range/);
    assert.equal(resolveConfig({ ...BASE, allowedSourceRanges: ["198.51.100.0/24"] }).allowedSourceRanges.length, 1);
  });

  it("rejects name prefixes that would be too long for service account IDs", () => {
    assert.throws(() => resolveConfig({ ...BASE, namePrefix: "a-much-too-long-name-prefix" }), /namePrefix must be 2-20 characters/);
    assert.throws(() => resolveConfig({ ...BASE, namePrefix: "a" }), /namePrefix must be 2-20 characters/);
    assert.throws(() => resolveConfig({ ...BASE, namePrefix: "Supabase" }), /namePrefix/);
  });
});
