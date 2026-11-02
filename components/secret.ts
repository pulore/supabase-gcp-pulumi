import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

export interface ManagedSecretArgs {
  /** Secret Manager secret ID, e.g. "supabase-dev-db-password". */
  secretId: string;
  /** The value. Stored as one secret version, and encrypted in the Pulumi state. */
  value: pulumi.Input<string>;
  labels?: Record<string, string>;
}

/**
 * One Secret Manager secret holding one value.
 *
 * VMs read the exact version in {@link versionName}, which they get through
 * instance metadata. When the value changes, Pulumi creates a new version and
 * the name in the metadata changes with it: the Studio instance group rolls
 * out new VMs, and the VPN VM picks it up on its next boot.
 *
 * Replication is automatic (Google chooses the locations). If your data must
 * stay in one region, switch `replication` to `userManaged` with that region.
 */
export class ManagedSecret extends pulumi.ComponentResource {
  public readonly secret: gcp.secretmanager.Secret;
  public readonly version: gcp.secretmanager.SecretVersion;
  /** projects/<number>/secrets/<id>/versions/<n> */
  public readonly versionName: pulumi.Output<string>;
  public readonly secretId: pulumi.Output<string>;

  constructor(name: string, args: ManagedSecretArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:ManagedSecret", name, {}, opts);

    this.secret = new gcp.secretmanager.Secret(
      name,
      {
        secretId: args.secretId,
        replication: { auto: {} },
        labels: args.labels,
      },
      { parent: this },
    );

    this.version = new gcp.secretmanager.SecretVersion(
      name,
      {
        secret: this.secret.id,
        secretData: pulumi.secret(args.value),
      },
      { parent: this },
    );

    this.versionName = this.version.name;
    this.secretId = this.secret.secretId;

    this.registerOutputs({ secretId: this.secretId, versionName: this.versionName });
  }

  /** Lets `member` (e.g. "serviceAccount:...") read this secret, and nothing else. */
  public grantAccess(name: string, member: pulumi.Input<string>, parent: pulumi.Resource): gcp.secretmanager.SecretIamMember {
    return new gcp.secretmanager.SecretIamMember(
      name,
      {
        secretId: this.secret.id,
        role: "roles/secretmanager.secretAccessor",
        member,
      },
      { parent },
    );
  }
}
