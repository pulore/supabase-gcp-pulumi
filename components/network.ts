import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/** Network tag for VMs that accept SSH through Identity-Aware Proxy. */
export const IAP_SSH_TAG = "iap-ssh";

/** Source range of IAP TCP forwarding (`gcloud compute ssh --tunnel-through-iap`). */
export const IAP_TCP_FORWARDING_RANGE = "35.235.240.0/20";

export interface NetworkArgs {
  namePrefix: string;
  region: string;
  subnetCidr: string;
  /** Prefix length of the range reserved for Cloud SQL's private IP. */
  privateServicesPrefixLength: number;
  privateServicesDeletionPolicy: "DELETE" | "REMOVE_PEERING";
  enableIapSsh: boolean;
}

/**
 * The VPC everything runs in:
 *
 * - a custom-mode VPC with one subnet (Private Google Access on, so VMs without
 *   external IPs can reach Google APIs such as Secret Manager);
 * - private services access: a reserved range and a peering connection to
 *   Google's service networking, which is how Cloud SQL gets a private IP;
 * - Cloud Router and Cloud NAT, so the Studio VMs can pull container images
 *   without external IPs;
 * - optionally, a firewall rule that allows SSH from IAP only.
 *
 * Other firewall rules live with the components they open ports for.
 */
export class Network extends pulumi.ComponentResource {
  public readonly vpc: gcp.compute.Network;
  public readonly subnet: gcp.compute.Subnetwork;
  public readonly privateServicesRange: gcp.compute.GlobalAddress;
  public readonly privateServicesConnection: gcp.servicenetworking.Connection;
  public readonly router: gcp.compute.Router;
  public readonly nat: gcp.compute.RouterNat;
  public readonly iapSshFirewall?: gcp.compute.Firewall;

  constructor(name: string, args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:Network", name, {}, opts);

    const prefix = args.namePrefix;

    this.vpc = new gcp.compute.Network(
      `${name}-vpc`,
      {
        name: `${prefix}-vpc`,
        autoCreateSubnetworks: false,
      },
      { parent: this },
    );

    this.subnet = new gcp.compute.Subnetwork(
      `${name}-subnet`,
      {
        name: `${prefix}-subnet`,
        region: args.region,
        network: this.vpc.id,
        ipCidrRange: args.subnetCidr,
        privateIpGoogleAccess: true,
      },
      { parent: this },
    );

    // Private services access. Google picks a free range of this size; Cloud
    // SQL instances get their private IPs from it.
    this.privateServicesRange = new gcp.compute.GlobalAddress(
      `${name}-private-services-range`,
      {
        name: `${prefix}-private-services`,
        purpose: "VPC_PEERING",
        addressType: "INTERNAL",
        prefixLength: args.privateServicesPrefixLength,
        network: this.vpc.id,
      },
      { parent: this },
    );

    // Takes several minutes to create. Cloud SQL must wait for it (see Database).
    this.privateServicesConnection = new gcp.servicenetworking.Connection(
      `${name}-private-services-connection`,
      {
        network: this.vpc.id,
        service: "servicenetworking.googleapis.com",
        reservedPeeringRanges: [this.privateServicesRange.name],
        deletionPolicy: args.privateServicesDeletionPolicy,
      },
      { parent: this },
    );

    this.router = new gcp.compute.Router(
      `${name}-router`,
      {
        name: `${prefix}-router`,
        region: args.region,
        network: this.vpc.id,
      },
      { parent: this },
    );

    this.nat = new gcp.compute.RouterNat(
      `${name}-nat`,
      {
        name: `${prefix}-nat`,
        router: this.router.name,
        region: args.region,
        natIpAllocateOption: "AUTO_ONLY",
        sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
        logConfig: { enable: true, filter: "ERRORS_ONLY" },
      },
      { parent: this },
    );

    if (args.enableIapSsh) {
      this.iapSshFirewall = new gcp.compute.Firewall(
        `${name}-allow-iap-ssh`,
        {
          name: `${prefix}-allow-iap-ssh`,
          network: this.vpc.id,
          direction: "INGRESS",
          description: "SSH through Identity-Aware Proxy only.",
          allows: [{ protocol: "tcp", ports: ["22"] }],
          sourceRanges: [IAP_TCP_FORWARDING_RANGE],
          targetTags: [IAP_SSH_TAG],
        },
        { parent: this },
      );
    }

    this.registerOutputs({
      vpcId: this.vpc.id,
      subnetId: this.subnet.id,
    });
  }
}
