import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { AllowlistPolicy } from "../../components/cloud-armor";
import { Database } from "../../components/database";
import { HttpsLoadBalancer, LOAD_BALANCING_SCHEME } from "../../components/load-balancer";
import { Network } from "../../components/network";
import { ManagedSecret } from "../../components/secret";
import { ServiceAccount, VM_LOGGING_ROLES } from "../../components/service-account";
import { BASE_METADATA, COS_IMAGE, SHIELDED_VM } from "../../components/vm";
import { ImageSettings, StudioConfig } from "../../config";
import { sshaHtpasswdLine } from "../../lib/htpasswd";
import { startupScript } from "../../lib/startup-script";

/** Network tag on the Studio VMs. */
export const STUDIO_TAG = "supabase-studio";

/** Port of the basic-auth proxy on each VM; the only port the VMs serve. */
export const STUDIO_HTTP_PORT = 8000;

/** Served by the proxy without credentials; see scripts/supabase-studio.sh. */
export const HEALTH_CHECK_PATH = "/healthz";

/**
 * Where a global external Application Load Balancer's traffic to the
 * backends comes from: Google Front Ends (130.211.0.0/22 and 35.191.0.0/16)
 * and the health-check probes (35.191.0.0/16).
 * https://cloud.google.com/load-balancing/docs/https#firewall-rules
 */
export const GOOGLE_LB_SOURCE_RANGES = ["35.191.0.0/16", "130.211.0.0/22"];

export interface SupabaseStudioArgs {
  namePrefix: string;
  projectId: string;
  region: string;
  /** Hostname Studio is served on. */
  domain: string;
  network: Network;
  database: Database;
  /** The VPN's static IP: the only client address Cloud Armor allows by default. */
  vpnIp: pulumi.Input<string>;
  /** Extra ranges Cloud Armor allows. */
  allowedSourceRanges: string[];
  settings: StudioConfig;
  images: Pick<ImageSettings, "studio" | "pgMeta" | "proxy">;
  /** Extra network tags, e.g. the IAP SSH tag. */
  extraTags: string[];
  labels: Record<string, string>;
}

/**
 * Supabase Studio and postgres-meta on a regional managed instance group,
 * behind a global external HTTPS load balancer.
 *
 * Each VM runs Container-Optimized OS with three containers (see
 * scripts/supabase-studio.sh): nginx with basic auth on port 8000, Studio and
 * postgres-meta. Self-hosted Studio has no login of its own and its API runs
 * SQL as the database user, so it is protected twice: Cloud Armor only lets
 * the VPN's IP reach the load balancer, and nginx asks for a password.
 */
export class SupabaseStudio extends pulumi.ComponentResource {
  public readonly serviceAccount: ServiceAccount;
  public readonly username: string;
  public readonly password: pulumi.Output<string>;
  public readonly passwordSecret: ManagedSecret;
  public readonly htpasswdSecret: ManagedSecret;
  public readonly cryptoKeySecret: ManagedSecret;
  public readonly securityPolicy: AllowlistPolicy;
  public readonly healthCheck: gcp.compute.HealthCheck;
  public readonly instanceTemplate: gcp.compute.InstanceTemplate;
  public readonly instanceGroupManager: gcp.compute.RegionInstanceGroupManager;
  public readonly autoscaler: gcp.compute.RegionAutoscaler;
  public readonly backendService: gcp.compute.BackendService;
  public readonly loadBalancer: HttpsLoadBalancer;
  public readonly firewall: gcp.compute.Firewall;
  public readonly url: string;

  constructor(name: string, args: SupabaseStudioArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:services:SupabaseStudio", name, {}, opts);

    const s = args.settings;
    const resourceName = `${args.namePrefix}-studio`;
    this.username = s.username;
    this.url = `https://${args.domain}`;

    this.serviceAccount = new ServiceAccount(
      `${name}-sa`,
      {
        accountId: resourceName,
        displayName: "Supabase Studio VMs",
        projectId: args.projectId,
        roles: VM_LOGGING_ROLES,
      },
      { parent: this },
    );

    // Secrets. The basic-auth password is for people (stack output and Secret
    // Manager); the VMs only get its salted hash.
    const password = new random.RandomPassword(`${name}-password`, { length: 32, special: false }, { parent: this });
    this.password = password.result;
    const htpasswdSalt = new random.RandomString(`${name}-htpasswd-salt`, { length: 16, special: false }, { parent: this });
    // Encrypts the connection string Studio sends to postgres-meta.
    const cryptoKey = new random.RandomPassword(`${name}-pg-meta-crypto-key`, { length: 32, special: false }, { parent: this });

    this.passwordSecret = new ManagedSecret(
      `${name}-password`,
      { secretId: `${resourceName}-password`, value: password.result, labels: args.labels },
      { parent: this },
    );
    this.htpasswdSecret = new ManagedSecret(
      `${name}-htpasswd`,
      {
        secretId: `${resourceName}-htpasswd`,
        value: pulumi
          .all([password.result, htpasswdSalt.result])
          .apply(([plain, salt]) => sshaHtpasswdLine(s.username, plain, salt)),
        labels: args.labels,
      },
      { parent: this },
    );
    this.cryptoKeySecret = new ManagedSecret(
      `${name}-pg-meta-crypto-key`,
      { secretId: `${args.namePrefix}-pg-meta-crypto-key`, value: cryptoKey.result, labels: args.labels },
      { parent: this },
    );

    const member = this.serviceAccount.member;
    const secretAccess = [
      args.database.passwordSecret.grantAccess(`${name}-db-password-access`, member, this),
      this.htpasswdSecret.grantAccess(`${name}-htpasswd-access`, member, this),
      this.cryptoKeySecret.grantAccess(`${name}-pg-meta-crypto-key-access`, member, this),
    ];

    this.securityPolicy = new AllowlistPolicy(
      `${name}-armor`,
      {
        policyName: `${resourceName}-allowlist`,
        vpnIp: args.vpnIp,
        extraRanges: args.allowedSourceRanges,
      },
      { parent: this },
    );

    // One health check for the load balancer and for auto-healing. It goes
    // through nginx to Studio, so a VM whose proxy or Studio is down fails it.
    this.healthCheck = new gcp.compute.HealthCheck(
      `${name}-health-check`,
      {
        name: `${resourceName}-hc`,
        checkIntervalSec: 10,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
        httpHealthCheck: {
          port: STUDIO_HTTP_PORT,
          requestPath: HEALTH_CHECK_PATH,
        },
      },
      { parent: this },
    );

    this.instanceTemplate = new gcp.compute.InstanceTemplate(
      `${name}-template`,
      {
        // Templates can't be changed in place. With a name prefix, Pulumi
        // creates the new template before the old one is deleted, and the
        // instance group rolls the VMs over to it.
        namePrefix: `${resourceName}-`,
        machineType: s.machineType,
        tags: [STUDIO_TAG, ...args.extraTags],
        labels: args.labels,
        disks: [
          {
            sourceImage: COS_IMAGE,
            boot: true,
            autoDelete: true,
            diskSizeGb: s.bootDiskSizeGb,
            diskType: s.bootDiskType,
          },
        ],
        // No access config: the VMs have no external IP. They reach the
        // internet through Cloud NAT and Google APIs through Private Google
        // Access, and are reached only through the load balancer.
        networkInterfaces: [
          {
            network: args.network.vpc.id,
            subnetwork: args.network.subnet.id,
          },
        ],
        serviceAccount: {
          email: this.serviceAccount.email,
          scopes: ["cloud-platform"],
        },
        shieldedInstanceConfig: SHIELDED_VM,
        // Settings for scripts/supabase-studio.sh. Secrets are referenced by
        // version name only; the values are read from Secret Manager at boot.
        metadata: {
          ...BASE_METADATA,
          "startup-script": startupScript("supabase-studio"),
          "studio-image": args.images.studio,
          "pg-meta-image": args.images.pgMeta,
          "proxy-image": args.images.proxy,
          "proxy-port": String(STUDIO_HTTP_PORT),
          "db-host": args.database.privateIp,
          "db-port": String(args.database.port),
          "db-name": args.database.databaseName,
          "db-user": args.database.user,
          "studio-organization-name": s.organizationName,
          "studio-project-name": s.projectName,
          "db-password-secret": args.database.passwordSecret.versionName,
          "pg-meta-crypto-key-secret": this.cryptoKeySecret.versionName,
          "studio-htpasswd-secret": this.htpasswdSecret.versionName,
        },
      },
      { parent: this, dependsOn: [...secretAccess, ...this.serviceAccount.roleBindings] },
    );

    // Regional managed instance groups take a fixed surge of 0 or at least the
    // number of zones they use. Without explicit zones Google Cloud picks them,
    // so use 4, the most zones any region has (us-central1).
    const maxSurge = s.zones !== undefined && s.zones.length > 0 ? s.zones.length : 4;

    this.instanceGroupManager = new gcp.compute.RegionInstanceGroupManager(
      `${name}-mig`,
      {
        name: resourceName,
        region: args.region,
        baseInstanceName: resourceName,
        distributionPolicyZones: s.zones,
        versions: [{ name: "studio", instanceTemplate: this.instanceTemplate.selfLinkUnique }],
        namedPorts: [{ name: "http", port: STUDIO_HTTP_PORT }],
        // No targetSize: the autoscaler below owns the group's size.
        autoHealingPolicies: {
          healthCheck: this.healthCheck.id,
          // Time for the first boot: image pulls plus Studio starting.
          initialDelaySec: 300,
        },
        // New VMs come up before old ones go away.
        updatePolicy: {
          type: "PROACTIVE",
          minimalAction: "REPLACE",
          replacementMethod: "SUBSTITUTE",
          maxSurgeFixed: maxSurge,
          maxUnavailableFixed: 0,
        },
      },
      { parent: this },
    );

    this.autoscaler = new gcp.compute.RegionAutoscaler(
      `${name}-autoscaler`,
      {
        name: resourceName,
        region: args.region,
        target: this.instanceGroupManager.id,
        autoscalingPolicy: {
          minReplicas: s.minReplicas,
          maxReplicas: s.maxReplicas,
          // Ignore a new VM's CPU while it pulls images and starts up.
          cooldownPeriod: 180,
          cpuUtilization: { target: s.cpuTarget },
        },
      },
      { parent: this },
    );

    this.backendService = new gcp.compute.BackendService(
      `${name}-backend`,
      {
        name: resourceName,
        protocol: "HTTP",
        portName: "http",
        loadBalancingScheme: LOAD_BALANCING_SCHEME,
        // Longer than postgres-meta's default query timeout (55 s), so a slow
        // query ends with postgres-meta's timeout error, not a load balancer 504.
        timeoutSec: 120,
        connectionDrainingTimeoutSec: 30,
        healthChecks: this.healthCheck.id,
        securityPolicy: this.securityPolicy.policy.selfLink,
        // Studio saves SQL snippets on the VM it runs on, so keep each browser
        // on one VM.
        sessionAffinity: "GENERATED_COOKIE",
        backends: [
          {
            group: this.instanceGroupManager.instanceGroup,
            balancingMode: "UTILIZATION",
            capacityScaler: 1,
          },
        ],
        logConfig: { enable: true, sampleRate: 1 },
      },
      { parent: this },
    );

    this.loadBalancer = new HttpsLoadBalancer(
      `${name}-lb`,
      {
        resourceName,
        domain: args.domain,
        backendService: this.backendService,
        labels: args.labels,
      },
      { parent: this },
    );

    // The only way into the Studio VMs (besides IAP SSH, if enabled).
    this.firewall = new gcp.compute.Firewall(
      `${name}-allow-lb`,
      {
        name: `${resourceName}-allow-lb`,
        network: args.network.vpc.id,
        direction: "INGRESS",
        description: "Load balancer and health checks to the Studio proxy.",
        allows: [{ protocol: "tcp", ports: [String(STUDIO_HTTP_PORT)] }],
        sourceRanges: GOOGLE_LB_SOURCE_RANGES,
        targetTags: [STUDIO_TAG],
      },
      { parent: this },
    );

    this.registerOutputs({
      url: this.url,
      ipAddress: this.loadBalancer.ipAddress,
    });
  }
}
