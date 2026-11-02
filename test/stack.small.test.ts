/**
 * Runs the whole program (index.ts) under Pulumi's mocks with the default
 * preset, then checks what it would create. Nothing is sent to Google Cloud.
 */
import * as assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { BASE_METADATA, COS_IMAGE, DEFAULT_RULE_PRIORITY, IAP_SSH_TAG, IAP_TCP_FORWARDING_RANGE, VPN_TAG } from "../components";
import { PRESETS } from "../config";
import { GOOGLE_LB_SOURCE_RANGES, HEALTH_CHECK_PATH, STUDIO_HTTP_PORT, STUDIO_TAG } from "../services/supabase-studio";
import {
  DB_PRIVATE_IP,
  LB_IP,
  MOCK_PRIVATE_KEY,
  RecordedResource,
  TEST_CERT_SHA256,
  TYPES,
  VPN_IP,
  mockSecretValue,
  ofType,
  one,
  settle,
  setupMocks,
  valueOf,
} from "./helpers/mocks";

// Ports that must never be reachable from the internet: Postgres, Studio,
// postgres-meta and the Studio proxy.
const PROTECTED_PORTS = [5432, 3000, 8080, STUDIO_HTTP_PORT];
const WORLD = ["0.0.0.0/0", "::/0"];

let program: typeof import("../index");

before(async () => {
  await setupMocks({
    "gcp:project": "test-project",
    "gcp:region": "europe-west2",
    "gcp:zone": "europe-west2-a",
    "supabase-gcp:domain": "studio.example.com",
  });
  program = await import("../index");
  await valueOf(program.outlineManagerConfig);
  await settle();
});

describe("Cloud SQL", () => {
  it("has no public IP and gets its private IP on the stack's VPC", () => {
    const sql = one(TYPES.sqlInstance);
    const vpc = one(TYPES.network);
    const ip = sql.inputs.settings.ipConfiguration;
    assert.equal(ip.ipv4Enabled, false);
    assert.equal(ip.privateNetwork, vpc.id);
    assert.equal(ip.authorizedNetworks, undefined);
  });

  it("keeps automated backups and point-in-time recovery on", () => {
    const backup = one(TYPES.sqlInstance).inputs.settings.backupConfiguration;
    assert.equal(backup.enabled, true);
    assert.equal(backup.pointInTimeRecoveryEnabled, true);
    assert.equal(backup.transactionLogRetentionDays, PRESETS.small.database.transactionLogRetentionDays);
    assert.deepEqual(backup.backupRetentionSettings, {
      retainedBackups: PRESETS.small.database.retainedBackups,
      retentionUnit: "COUNT",
    });
  });

  it("takes edition, size, availability and deletion protection from the small preset", () => {
    const sql = one(TYPES.sqlInstance);
    const preset = PRESETS.small.database;
    assert.equal(sql.inputs.settings.edition, preset.edition);
    assert.equal(sql.inputs.settings.tier, preset.tier);
    assert.equal(sql.inputs.settings.availabilityType, preset.availabilityType);
    assert.equal(sql.inputs.settings.diskSize, preset.diskSizeGb);
    assert.equal(sql.inputs.settings.diskAutoresize, true);
    assert.equal(sql.inputs.deletionProtection, false);
    assert.equal(sql.inputs.settings.deletionProtectionEnabled, false);
    assert.equal(sql.inputs.settings.dataCacheConfig, undefined);
  });

  it("uses a private services connection that can be torn down", () => {
    const connection = one(TYPES.serviceNetworkingConnection);
    assert.equal(connection.inputs.service, "servicenetworking.googleapis.com");
    assert.equal(connection.inputs.deletionPolicy, "REMOVE_PEERING");
  });
});

describe("Cloud Armor", () => {
  it("denies everything by default", () => {
    const rules: any[] = one(TYPES.securityPolicy).inputs.rules;
    const defaultRule = rules.find((rule) => rule.priority === DEFAULT_RULE_PRIORITY);
    assert.ok(defaultRule, "no default rule");
    assert.equal(defaultRule.action, "deny(403)");
    assert.deepEqual(defaultRule.match.config.srcIpRanges, ["*"]);
  });

  it("allows only the VPN's static IP", () => {
    const rules: any[] = one(TYPES.securityPolicy).inputs.rules;
    const allowed = rules.filter((rule) => rule.action === "allow").flatMap((rule) => rule.match.config.srcIpRanges);
    assert.deepEqual(allowed, [`${VPN_IP}/32`]);
  });

  it("is attached to Studio's backend service", () => {
    const policy = one(TYPES.securityPolicy);
    const backend = one(TYPES.backendService);
    assert.ok(backend.inputs.securityPolicy.endsWith(`/${policy.name}`));
  });
});

describe("Firewall rules", () => {
  const firewalls = (): RecordedResource[] => ofType(TYPES.firewall);

  it("never open Postgres, Studio or postgres-meta to the internet", () => {
    for (const rule of firewalls()) {
      const fromWorld = (rule.inputs.sourceRanges ?? []).some((range: string) => WORLD.includes(range));
      if (!fromWorld) {
        continue;
      }
      for (const allow of rule.inputs.allows ?? []) {
        assert.ok(allow.ports?.length > 0, `${rule.inputs.name} opens all ${allow.protocol} ports to the internet`);
        for (const ports of allow.ports) {
          for (const port of PROTECTED_PORTS) {
            assert.ok(!portsInclude(ports, port), `${rule.inputs.name} opens port ${port} to the internet`);
          }
        }
      }
    }
  });

  it("open nothing to the internet except the VPN VM", () => {
    const worldRules = firewalls().filter((rule) => (rule.inputs.sourceRanges ?? []).some((range: string) => WORLD.includes(range)));
    assert.ok(worldRules.length > 0);
    for (const rule of worldRules) {
      assert.deepEqual(rule.inputs.targetTags, [VPN_TAG], `${rule.inputs.name} targets more than the VPN`);
    }
  });

  it("let only Google's load balancer and health-check ranges reach the Studio VMs", () => {
    const studioRules = firewalls().filter((rule) => (rule.inputs.targetTags ?? []).includes(STUDIO_TAG));
    assert.equal(studioRules.length, 1);
    const [rule] = studioRules;
    assert.deepEqual([...rule.inputs.sourceRanges].sort(), [...GOOGLE_LB_SOURCE_RANGES].sort());
    assert.deepEqual(rule.inputs.allows, [{ protocol: "tcp", ports: [String(STUDIO_HTTP_PORT)] }]);
  });

  it("allow SSH only from Identity-Aware Proxy", () => {
    const sshRules = firewalls().filter((rule) => (rule.inputs.allows ?? []).some((allow: any) => (allow.ports ?? []).some((ports: string) => portsInclude(ports, 22))));
    assert.equal(sshRules.length, 1);
    assert.deepEqual(sshRules[0].inputs.sourceRanges, [IAP_TCP_FORWARDING_RANGE]);
    assert.deepEqual(sshRules[0].inputs.targetTags, [IAP_SSH_TAG]);
  });

  it("open the VPN VM on its two ports only", () => {
    const vpnRules = firewalls().filter((rule) => (rule.inputs.targetTags ?? []).includes(VPN_TAG));
    const opened = vpnRules.flatMap((rule) => rule.inputs.allows.map((allow: any) => `${allow.protocol}:${allow.ports.join(",")}`)).sort();
    assert.deepEqual(opened, ["tcp:443", "tcp:8443", "udp:443"]);
  });
});

describe("Studio instance group", () => {
  it("auto-heals with the HTTP health check", () => {
    const mig = one(TYPES.mig);
    const healthCheck = one(TYPES.healthCheck);
    assert.equal(mig.inputs.autoHealingPolicies.healthCheck, healthCheck.id);
    assert.equal(mig.inputs.autoHealingPolicies.initialDelaySec, 300);
    assert.equal(healthCheck.inputs.httpHealthCheck.port, STUDIO_HTTP_PORT);
    assert.equal(healthCheck.inputs.httpHealthCheck.requestPath, HEALTH_CHECK_PATH);
  });

  it("scales between the preset's minimum and maximum", () => {
    const mig = one(TYPES.mig);
    const autoscaler = one(TYPES.autoscaler);
    assert.equal(autoscaler.inputs.target, mig.id);
    assert.equal(autoscaler.inputs.autoscalingPolicy.minReplicas, PRESETS.small.studio.minReplicas);
    assert.equal(autoscaler.inputs.autoscalingPolicy.maxReplicas, PRESETS.small.studio.maxReplicas);
    assert.equal(autoscaler.inputs.autoscalingPolicy.cpuUtilization.target, PRESETS.small.studio.cpuTarget);
    // The autoscaler owns the size; a fixed target size would fight it.
    assert.equal(mig.inputs.targetSize, undefined);
  });

  it("brings new VMs up before taking old ones down", () => {
    const update = one(TYPES.mig).inputs.updatePolicy;
    assert.equal(update.type, "PROACTIVE");
    assert.equal(update.minimalAction, "REPLACE");
    assert.equal(update.maxUnavailableFixed, 0);
    assert.ok(update.maxSurgeFixed >= 3);
  });

  it("is the load balancer's only backend, behind the same health check", () => {
    const backend = one(TYPES.backendService);
    const mig = one(TYPES.mig);
    assert.equal(backend.inputs.loadBalancingScheme, "EXTERNAL_MANAGED");
    assert.equal(backend.inputs.healthChecks, one(TYPES.healthCheck).id);
    assert.equal(backend.inputs.backends.length, 1);
    assert.ok(backend.inputs.backends[0].group.endsWith(`/instanceGroups/${mig.inputs.name}`));
    assert.deepEqual(mig.inputs.namedPorts, [{ name: "http", port: STUDIO_HTTP_PORT }]);
  });
});

describe("VMs", () => {
  it("give the Studio VMs no external IP", () => {
    const template = one(TYPES.instanceTemplate);
    for (const nic of template.inputs.networkInterfaces) {
      assert.ok(nic.accessConfigs === undefined || nic.accessConfigs.length === 0);
    }
  });

  it("run Container-Optimized OS with Secure Boot", () => {
    const template = one(TYPES.instanceTemplate);
    const vpn = one(TYPES.instance);
    assert.equal(COS_IMAGE, "projects/cos-cloud/global/images/family/cos-stable");
    assert.equal(template.inputs.disks[0].sourceImage, COS_IMAGE);
    assert.equal(vpn.inputs.bootDisk.initializeParams.image, COS_IMAGE);
    for (const vm of [template, vpn]) {
      assert.equal(vm.inputs.shieldedInstanceConfig.enableSecureBoot, true);
      assert.equal(vm.inputs.metadata["enable-oslogin"], "TRUE");
    }
  });

  it("never put secret values in instance metadata", () => {
    const metadata = JSON.stringify([one(TYPES.instanceTemplate).inputs.metadata, one(TYPES.instance).inputs.metadata]);
    const secrets = ofType("random:index/randomPassword:RandomPassword").map((resource) => mockSecretValue(resource.name));
    assert.ok(secrets.length >= 4);
    for (const secret of [...secrets, MOCK_PRIVATE_KEY.split("\n")[1], "{SSHA}"]) {
      assert.ok(!metadata.includes(secret), `instance metadata contains ${secret}`);
    }
  });

  it("point the Studio VMs at the database's private IP and at secret versions", () => {
    const metadata = one(TYPES.instanceTemplate).inputs.metadata;
    assert.equal(metadata["db-host"], DB_PRIVATE_IP);
    assert.equal(metadata["db-user"], "postgres");
    assert.equal(metadata["db-name"], "postgres");
    for (const key of ["db-password-secret", "pg-meta-crypto-key-secret", "studio-htpasswd-secret"]) {
      assert.match(metadata[key], /^projects\/[^/]+\/secrets\/[^/]+\/versions\/\d+$/, key);
    }
  });

  it("set every metadata attribute the startup scripts read, and no unused ones", () => {
    const standard = ["startup-script", ...Object.keys(BASE_METADATA)];
    for (const vm of [one(TYPES.instanceTemplate), one(TYPES.instance)]) {
      const metadata: Record<string, string> = vm.inputs.metadata;
      const script = metadata["startup-script"];
      const read = new Set([...script.matchAll(/\b(?:attr|write_secret_file) "?([a-z][a-z0-9-]+)/g)].map((match) => match[1]));
      const set = new Set(Object.keys(metadata).filter((key) => !standard.includes(key)));
      assert.deepEqual([...read].sort(), [...set].sort());
    }
  });

  it("keep Outline's state on a separate persistent disk and use the static IP", () => {
    const vpn = one(TYPES.instance);
    assert.equal(vpn.inputs.networkInterfaces[0].accessConfigs[0].natIp, VPN_IP);
    assert.equal(vpn.inputs.attachedDisks.length, 1);
    assert.equal(vpn.inputs.attachedDisks[0].deviceName, vpn.inputs.metadata["outline-data-disk-device"]);
    assert.equal(vpn.inputs.zone, "europe-west2-a");
  });
});

describe("Secrets", () => {
  it("are all in Secret Manager", () => {
    const ids = ofType(TYPES.secret).map((secret) => secret.inputs.secretId).sort();
    assert.deepEqual(ids, [
      "supabase-dev-db-password",
      "supabase-dev-outline-api-prefix",
      "supabase-dev-outline-tls-cert",
      "supabase-dev-outline-tls-key",
      "supabase-dev-pg-meta-crypto-key",
      "supabase-dev-studio-htpasswd",
      "supabase-dev-studio-password",
    ]);
  });

  it("can each be read only by the VM that needs them", () => {
    const secretIdById = new Map(ofType(TYPES.secret).map((secret) => [secret.id, secret.inputs.secretId as string]));
    const readable = new Map<string, string[]>();
    for (const binding of ofType(TYPES.secretIam)) {
      assert.equal(binding.inputs.role, "roles/secretmanager.secretAccessor");
      const list = readable.get(binding.inputs.member) ?? [];
      list.push(secretIdById.get(binding.inputs.secretId) ?? `unknown ${binding.inputs.secretId}`);
      readable.set(binding.inputs.member, list);
    }
    assert.deepEqual(Object.fromEntries([...readable].map(([member, ids]) => [member, ids.sort()])), {
      "serviceAccount:supabase-dev-studio@test-project.iam.gserviceaccount.com": [
        "supabase-dev-db-password",
        "supabase-dev-pg-meta-crypto-key",
        "supabase-dev-studio-htpasswd",
      ],
      "serviceAccount:supabase-dev-vpn@test-project.iam.gserviceaccount.com": [
        "supabase-dev-outline-api-prefix",
        "supabase-dev-outline-tls-cert",
        "supabase-dev-outline-tls-key",
      ],
    });
  });
});

describe("Load balancer", () => {
  it("serves the configured domain with a Google-managed certificate", () => {
    assert.deepEqual(one(TYPES.managedCertificate).inputs.managed.domains, ["studio.example.com"]);
  });

  it("listens on 443, and on 80 only to redirect", () => {
    const rules = ofType(TYPES.forwardingRule);
    assert.deepEqual(rules.map((rule) => rule.inputs.portRange).sort(), ["443", "80"]);
    for (const rule of rules) {
      assert.equal(rule.inputs.loadBalancingScheme, "EXTERNAL_MANAGED");
    }
  });
});

describe("Stack outputs", () => {
  it("give the Studio URL and the address for the DNS record", async () => {
    assert.equal(program.studioUrl, "https://studio.example.com");
    assert.equal(await valueOf(program.studioIpAddress), LB_IP);
    assert.equal(await valueOf(program.databasePrivateIp), DB_PRIVATE_IP);
  });

  it("give the Outline Manager config for the VPN", async () => {
    const config = JSON.parse(await valueOf(program.outlineManagerConfig));
    assert.deepEqual(config, {
      apiUrl: `https://${VPN_IP}:8443/${mockSecretValue("vpn-api-prefix")}`,
      certSha256: TEST_CERT_SHA256,
    });
  });
});

/** True if a firewall port spec ("5432" or "1024-65535") covers `port`. */
function portsInclude(spec: string, port: number): boolean {
  const [low, high = low] = spec.split("-").map(Number);
  return port >= low && port <= high;
}
