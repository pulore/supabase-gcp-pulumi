import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";

import { VpnConfig } from "../config";
import { outlineManagerConfig } from "../lib/outline";
import { startupScript } from "../lib/startup-script";
import { ManagedSecret } from "./secret";
import { ServiceAccount, VM_LOGGING_ROLES } from "./service-account";
import { BASE_METADATA, COS_IMAGE, SHIELDED_VM } from "./vm";

/** Network tag on the VPN VM. */
export const VPN_TAG = "outline-vpn";

// The data disk shows up on the VM as /dev/disk/by-id/google-<device name>.
const DATA_DISK_DEVICE = "outline-data";

export interface OutlineVpnArgs {
  namePrefix: string;
  projectId: string;
  region: string;
  network: gcp.compute.Network;
  subnet: gcp.compute.Subnetwork;
  settings: VpnConfig;
  image: string;
  /** Extra network tags, e.g. the IAP SSH tag. */
  extraTags: string[];
  labels: Record<string, string>;
}

/**
 * An Outline VPN server on a Container-Optimized OS VM.
 *
 * Team members connect with the Outline client, and their traffic leaves
 * through this VM's static IP, which is the address Cloud Armor allows. The
 * Outline state (access keys, settings) lives on a separate persistent disk.
 *
 * The management API's TLS certificate and secret URL prefix are generated
 * here and stored in Secret Manager, which also gives you the Outline Manager
 * config as a stack output instead of something to copy off the VM.
 */
export class OutlineVpn extends pulumi.ComponentResource {
  public readonly serviceAccount: ServiceAccount;
  public readonly address: gcp.compute.Address;
  public readonly dataDisk: gcp.compute.Disk;
  public readonly instance: gcp.compute.Instance;
  public readonly accessKeyFirewall: gcp.compute.Firewall;
  public readonly managementFirewall: gcp.compute.Firewall;
  public readonly tlsKeySecret: ManagedSecret;
  public readonly tlsCertSecret: ManagedSecret;
  public readonly apiPrefixSecret: ManagedSecret;
  /** The VPN's static public IP. */
  public readonly publicIp: pulumi.Output<string>;
  /** JSON for Outline Manager's "Set up Outline anywhere" step. Secret. */
  public readonly managerConfig: pulumi.Output<string>;

  constructor(name: string, args: OutlineVpnArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:OutlineVpn", name, {}, opts);

    const prefix = args.namePrefix;
    const s = args.settings;

    this.serviceAccount = new ServiceAccount(
      `${name}-sa`,
      {
        accountId: `${prefix}-vpn`,
        displayName: "Outline VPN server",
        projectId: args.projectId,
        roles: VM_LOGGING_ROLES,
      },
      { parent: this },
    );

    // Static, so the Cloud Armor rule that allows it stays valid when the VM
    // is restarted or recreated.
    this.address = new gcp.compute.Address(
      `${name}-ip`,
      {
        name: `${prefix}-vpn-ip`,
        region: args.region,
        addressType: "EXTERNAL",
        labels: args.labels,
      },
      { parent: this },
    );
    this.publicIp = this.address.address;

    const hostname: pulumi.Output<string> = s.hostname !== undefined ? pulumi.output(s.hostname) : this.address.address;

    this.dataDisk = new gcp.compute.Disk(
      `${name}-data`,
      {
        name: `${prefix}-vpn-data`,
        zone: s.zone,
        size: s.dataDiskSizeGb,
        type: "pd-balanced",
        labels: args.labels,
      },
      { parent: this },
    );

    // Self-signed, as Outline's installer does it: Outline Manager pins the
    // certificate by its SHA-256 fingerprint rather than trusting a CA. Same
    // 100-year lifetime as the installer, so it never needs renewing.
    const tlsKey = new tls.PrivateKey(`${name}-tls-key`, { algorithm: "RSA", rsaBits: 4096 }, { parent: this });
    const tlsCert = new tls.SelfSignedCert(
      `${name}-tls-cert`,
      {
        privateKeyPem: tlsKey.privateKeyPem,
        subject: { commonName: hostname },
        validityPeriodHours: 100 * 365 * 24,
        allowedUses: ["key_encipherment", "digital_signature", "server_auth"],
      },
      { parent: this },
    );

    // The management API lives under a random path; together with the
    // certificate it is what Outline Manager uses to connect.
    const apiPrefix = new random.RandomPassword(`${name}-api-prefix`, { length: 24, special: false }, { parent: this });

    this.tlsKeySecret = new ManagedSecret(
      `${name}-tls-key`,
      { secretId: `${prefix}-outline-tls-key`, value: tlsKey.privateKeyPem, labels: args.labels },
      { parent: this },
    );
    this.tlsCertSecret = new ManagedSecret(
      `${name}-tls-cert`,
      { secretId: `${prefix}-outline-tls-cert`, value: tlsCert.certPem, labels: args.labels },
      { parent: this },
    );
    this.apiPrefixSecret = new ManagedSecret(
      `${name}-api-prefix`,
      { secretId: `${prefix}-outline-api-prefix`, value: apiPrefix.result, labels: args.labels },
      { parent: this },
    );

    const member = this.serviceAccount.member;
    const secretAccess = [
      this.tlsKeySecret.grantAccess(`${name}-tls-key-access`, member, this),
      this.tlsCertSecret.grantAccess(`${name}-tls-cert-access`, member, this),
      this.apiPrefixSecret.grantAccess(`${name}-api-prefix-access`, member, this),
    ];

    this.managerConfig = pulumi.secret(
      pulumi
        .all([hostname, apiPrefix.result, tlsCert.certPem])
        .apply(([host, path, certPem]) => outlineManagerConfig(`https://${host}:${s.apiPort}/${path}`, certPem)),
    );

    this.accessKeyFirewall = new gcp.compute.Firewall(
      `${name}-allow-access-keys`,
      {
        name: `${prefix}-allow-outline-access-keys`,
        network: args.network.id,
        direction: "INGRESS",
        description: "Outline clients connect from anywhere, on the access-key port only.",
        allows: [
          { protocol: "tcp", ports: [String(s.accessKeyPort)] },
          { protocol: "udp", ports: [String(s.accessKeyPort)] },
        ],
        sourceRanges: ["0.0.0.0/0"],
        targetTags: [VPN_TAG],
      },
      { parent: this },
    );

    this.managementFirewall = new gcp.compute.Firewall(
      `${name}-allow-management`,
      {
        name: `${prefix}-allow-outline-management`,
        network: args.network.id,
        direction: "INGRESS",
        description: "Outline Manager reaches the Outline server's management API.",
        allows: [{ protocol: "tcp", ports: [String(s.apiPort)] }],
        sourceRanges: s.managementSourceRanges,
        targetTags: [VPN_TAG],
      },
      { parent: this },
    );

    this.instance = new gcp.compute.Instance(
      `${name}-vm`,
      {
        name: `${prefix}-vpn`,
        zone: s.zone,
        machineType: s.machineType,
        tags: [VPN_TAG, ...args.extraTags],
        labels: args.labels,
        bootDisk: {
          autoDelete: true,
          initializeParams: {
            image: COS_IMAGE,
            size: s.bootDiskSizeGb,
            type: "pd-balanced",
          },
        },
        attachedDisks: [{ source: this.dataDisk.selfLink, deviceName: DATA_DISK_DEVICE }],
        networkInterfaces: [
          {
            network: args.network.id,
            subnetwork: args.subnet.id,
            accessConfigs: [{ natIp: this.address.address }],
          },
        ],
        serviceAccount: {
          email: this.serviceAccount.email,
          scopes: ["cloud-platform"],
        },
        shieldedInstanceConfig: SHIELDED_VM,
        // Settings for scripts/outline-vpn.sh. Only secret *names* go into
        // metadata; the VM reads the values from Secret Manager at boot.
        // Changing metadata doesn't restart the VM: reset it to apply.
        metadata: {
          ...BASE_METADATA,
          "startup-script": startupScript("outline-vpn"),
          "outline-image": args.image,
          "outline-api-port": String(s.apiPort),
          "outline-access-key-port": String(s.accessKeyPort),
          "outline-hostname": hostname,
          "outline-data-disk-device": DATA_DISK_DEVICE,
          "outline-tls-cert-secret": this.tlsCertSecret.versionName,
          "outline-tls-key-secret": this.tlsKeySecret.versionName,
          "outline-api-prefix-secret": this.apiPrefixSecret.versionName,
        },
        // Lets Pulumi stop the VM to change its machine type.
        allowStoppingForUpdate: true,
      },
      {
        parent: this,
        dependsOn: [...secretAccess, ...this.serviceAccount.roleBindings],
        // If a change forces a new VM, the old one has to go first: the
        // replacement needs its name, and the data disk can only be attached
        // to one VM at a time.
        deleteBeforeReplace: true,
      },
    );

    this.registerOutputs({ publicIp: this.publicIp });
  }
}
