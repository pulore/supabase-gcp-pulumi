import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/** Cloud Armor's default rule always has the lowest priority. */
export const DEFAULT_RULE_PRIORITY = 2147483647;

export interface AllowlistPolicyArgs {
  /** Policy name in Google Cloud. */
  policyName: string;
  /** The VPN server's static public IP. */
  vpnIp: pulumi.Input<string>;
  /** Other IPv4 ranges to let through, e.g. an office. At most 10. */
  extraRanges: string[];
}

/**
 * A Cloud Armor policy for the Studio backend: requests from the VPN's IP
 * (and any extra ranges) are allowed, everything else gets a 403.
 *
 * There is no rule for Google's health-check ranges. Health-check probes
 * connect to the instances' internal IPs directly instead of going through the
 * load balancer, so what they need is the VPC firewall rule in
 * services/supabase-studio, not a Cloud Armor rule. Allowing those ranges here
 * would also allow any request that reaches the load balancer from them.
 */
export class AllowlistPolicy extends pulumi.ComponentResource {
  public readonly policy: gcp.compute.SecurityPolicy;

  constructor(name: string, args: AllowlistPolicyArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:AllowlistPolicy", name, {}, opts);

    const rules: gcp.types.input.compute.SecurityPolicyRule[] = [
      {
        priority: 1000,
        action: "allow",
        description: "Outline VPN server",
        match: {
          versionedExpr: "SRC_IPS_V1",
          config: { srcIpRanges: [pulumi.interpolate`${args.vpnIp}/32`] },
        },
      },
    ];

    if (args.extraRanges.length > 0) {
      rules.push({
        priority: 1100,
        action: "allow",
        description: "allowedSourceRanges from the stack config",
        match: {
          versionedExpr: "SRC_IPS_V1",
          config: { srcIpRanges: args.extraRanges },
        },
      });
    }

    // The default rule has to be spelled out: a policy created without rules
    // gets a default rule that allows everything.
    rules.push({
      priority: DEFAULT_RULE_PRIORITY,
      action: "deny(403)",
      description: "Default: deny everything else",
      match: {
        versionedExpr: "SRC_IPS_V1",
        config: { srcIpRanges: ["*"] },
      },
    });

    this.policy = new gcp.compute.SecurityPolicy(
      name,
      {
        name: args.policyName,
        description: "Allow only the VPN (and listed ranges) to reach Supabase Studio",
        type: "CLOUD_ARMOR",
        rules,
      },
      { parent: this },
    );

    this.registerOutputs({ policySelfLink: this.policy.selfLink });
  }
}
