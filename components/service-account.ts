import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/** What a VM needs to send its logs and metrics to Cloud Logging and Cloud Monitoring. */
export const VM_LOGGING_ROLES = ["roles/logging.logWriter", "roles/monitoring.metricWriter"];

export interface ServiceAccountArgs {
  /** 6-30 characters: lowercase letters, digits and hyphens. */
  accountId: string;
  displayName: string;
  projectId: string;
  /** Project-level roles to grant. */
  roles: string[];
}

/**
 * A dedicated service account for one kind of VM, with only the project roles
 * passed in. Access to individual secrets is granted on the secrets themselves
 * (see ManagedSecret.grantAccess).
 */
export class ServiceAccount extends pulumi.ComponentResource {
  public readonly account: gcp.serviceaccount.Account;
  public readonly email: pulumi.Output<string>;
  /** "serviceAccount:<email>", the form IAM bindings take. */
  public readonly member: pulumi.Output<string>;
  public readonly roleBindings: gcp.projects.IAMMember[];

  constructor(name: string, args: ServiceAccountArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:ServiceAccount", name, {}, opts);

    this.account = new gcp.serviceaccount.Account(
      name,
      {
        accountId: args.accountId,
        displayName: args.displayName,
        project: args.projectId,
      },
      { parent: this },
    );

    this.email = this.account.email;
    this.member = pulumi.interpolate`serviceAccount:${this.account.email}`;

    this.roleBindings = args.roles.map(
      (role) =>
        new gcp.projects.IAMMember(
          `${name}-${role.replace(/^roles\//, "").replace(/\./g, "-")}`,
          {
            project: args.projectId,
            role,
            member: this.member,
          },
          { parent: this },
        ),
    );

    this.registerOutputs({ email: this.email });
  }
}
