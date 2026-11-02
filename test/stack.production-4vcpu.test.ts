/**
 * Runs the whole program under Pulumi's mocks with the production-4vcpu
 * preset, to check that the preset reaches the resources.
 */
import * as assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { PRESETS } from "../config";
import { TYPES, one, settle, setupMocks, valueOf } from "./helpers/mocks";

const preset = PRESETS["production-4vcpu"];

before(async () => {
  await setupMocks(
    {
      "gcp:project": "test-project",
      "gcp:region": "europe-west2",
      "gcp:zone": "europe-west2-a",
      "supabase-gcp:domain": "studio.example.com",
      "supabase-gcp:preset": "production-4vcpu",
    },
    "prod",
  );
  const program = await import("../index");
  await valueOf(program.outlineManagerConfig);
  await settle();
});

describe("production-4vcpu preset", () => {
  it("runs Cloud SQL on the 4-vCPU Enterprise Plus tier, with Data Cache and a standby zone", () => {
    const settings = one(TYPES.sqlInstance).inputs.settings;
    assert.equal(settings.edition, "ENTERPRISE_PLUS");
    assert.equal(settings.tier, "db-perf-optimized-N-4");
    assert.equal(settings.availabilityType, "REGIONAL");
    assert.deepEqual(settings.dataCacheConfig, { dataCacheEnabled: true });
    assert.equal(settings.diskSize, preset.database.diskSizeGb);
    assert.equal(settings.ipConfiguration.ipv4Enabled, false);
  });

  it("keeps production's deletion protection, retained backups and point-in-time recovery", () => {
    const sql = one(TYPES.sqlInstance);
    assert.equal(sql.inputs.deletionProtection, true);
    assert.equal(sql.inputs.settings.deletionProtectionEnabled, true);
    assert.equal(sql.inputs.settings.retainBackupsOnDelete, true);
    const backup = sql.inputs.settings.backupConfiguration;
    assert.equal(backup.pointInTimeRecoveryEnabled, true);
    assert.equal(backup.backupRetentionSettings.retainedBackups, 35);
    assert.equal(one(TYPES.serviceNetworkingConnection).inputs.deletionPolicy, "DELETE");
  });

  it("runs two to four Studio VMs, and the VPN, on the preset's machine types", () => {
    const policy = one(TYPES.autoscaler).inputs.autoscalingPolicy;
    assert.equal(policy.minReplicas, 2);
    assert.equal(policy.maxReplicas, 4);
    assert.equal(one(TYPES.instanceTemplate).inputs.machineType, preset.studio.machineType);
    assert.equal(one(TYPES.instance).inputs.machineType, preset.vpn.machineType);
  });
});
