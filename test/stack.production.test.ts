/**
 * Runs the whole program under Pulumi's mocks with the production preset and
 * a few overrides, to check that presets and stack config reach the resources.
 */
import * as assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { DEFAULT_RULE_PRIORITY, IAP_SSH_TAG } from "../components";
import { PRESETS } from "../config";
import { TYPES, VPN_IP, ofType, one, settle, setupMocks, valueOf } from "./helpers/mocks";

before(async () => {
  await setupMocks(
    {
      "gcp:project": "test-project",
      "gcp:region": "europe-west2",
      "gcp:zone": "europe-west2-b",
      "supabase-gcp:domain": "studio.example.com",
      "supabase-gcp:preset": "production",
      "supabase-gcp:namePrefix": "acme-prod",
      "supabase-gcp:enableIapSsh": "false",
      "supabase-gcp:allowedSourceRanges": JSON.stringify(["198.51.100.0/24"]),
      "supabase-gcp:database": JSON.stringify({ backupLocation: "europe-west2" }),
      "supabase-gcp:studio": JSON.stringify({ zones: ["europe-west2-a", "europe-west2-b"], organizationName: "Acme" }),
    },
    "prod",
  );
  const program = await import("../index");
  await valueOf(program.outlineManagerConfig);
  await settle();
});

describe("production preset", () => {
  it("runs Cloud SQL on Enterprise Plus with Data Cache and a standby zone", () => {
    const settings = one(TYPES.sqlInstance).inputs.settings;
    const preset = PRESETS.production.database;
    assert.equal(settings.edition, "ENTERPRISE_PLUS");
    assert.equal(settings.tier, preset.tier);
    assert.equal(settings.availabilityType, "REGIONAL");
    assert.deepEqual(settings.dataCacheConfig, { dataCacheEnabled: true });
    assert.equal(settings.ipConfiguration.ipv4Enabled, false);
  });

  it("turns deletion protection on, in Pulumi and in Cloud SQL", () => {
    const sql = one(TYPES.sqlInstance);
    assert.equal(sql.inputs.deletionProtection, true);
    assert.equal(sql.inputs.settings.deletionProtectionEnabled, true);
    assert.equal(sql.inputs.settings.retainBackupsOnDelete, true);
    assert.equal(one(TYPES.serviceNetworkingConnection).inputs.deletionPolicy, "DELETE");
  });

  it("keeps 35 daily backups, with point-in-time recovery, in the configured location", () => {
    const backup = one(TYPES.sqlInstance).inputs.settings.backupConfiguration;
    assert.equal(backup.pointInTimeRecoveryEnabled, true);
    assert.equal(backup.backupRetentionSettings.retainedBackups, 35);
    assert.equal(backup.location, "europe-west2");
  });

  it("autoscales Studio between the preset's bounds across the configured zones", () => {
    const policy = one(TYPES.autoscaler).inputs.autoscalingPolicy;
    assert.equal(policy.minReplicas, PRESETS.production.studio.minReplicas);
    assert.equal(policy.maxReplicas, PRESETS.production.studio.maxReplicas);
    const mig = one(TYPES.mig);
    assert.deepEqual(mig.inputs.distributionPolicyZones, ["europe-west2-a", "europe-west2-b"]);
    // A regional group's fixed surge must be 0 or at least its number of zones.
    assert.equal(mig.inputs.updatePolicy.maxSurgeFixed, 2);
    assert.equal(one(TYPES.instanceTemplate).inputs.machineType, PRESETS.production.studio.machineType);
  });
});

describe("stack config overrides", () => {
  it("adds allowedSourceRanges as a second Cloud Armor allow rule, still denying the rest", () => {
    const rules: any[] = one(TYPES.securityPolicy).inputs.rules;
    const allows = rules.filter((rule) => rule.action === "allow").map((rule) => rule.match.config.srcIpRanges);
    assert.deepEqual(allows, [[`${VPN_IP}/32`], ["198.51.100.0/24"]]);
    const defaultRule = rules.find((rule) => rule.priority === DEFAULT_RULE_PRIORITY);
    assert.equal(defaultRule.action, "deny(403)");
  });

  it("can leave out IAP SSH entirely", () => {
    const ports = ofType(TYPES.firewall).flatMap((rule) => rule.inputs.allows.flatMap((allow: any) => allow.ports));
    assert.ok(!ports.includes("22"));
    assert.ok(!one(TYPES.instance).inputs.tags.includes(IAP_SSH_TAG));
    assert.ok(!one(TYPES.instanceTemplate).inputs.tags.includes(IAP_SSH_TAG));
  });

  it("uses the name prefix for resource names", () => {
    assert.equal(one(TYPES.network).inputs.name, "acme-prod-vpc");
    assert.equal(one(TYPES.mig).inputs.name, "acme-prod-studio");
    assert.equal(one(TYPES.instance).inputs.name, "acme-prod-vpn");
    assert.equal(one(TYPES.sqlInstance).inputs.name, "acme-prod-db");
  });

  it("passes Studio settings to the VMs", () => {
    const metadata = one(TYPES.instanceTemplate).inputs.metadata;
    assert.equal(metadata["studio-organization-name"], "Acme");
    assert.equal(one(TYPES.instance).inputs.zone, "europe-west2-b");
  });
});
