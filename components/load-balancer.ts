import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/**
 * Global external Application Load Balancer. The backend service passed in
 * must use the same scheme.
 */
export const LOAD_BALANCING_SCHEME = "EXTERNAL_MANAGED";

export interface HttpsLoadBalancerArgs {
  /** Prefix for the resource names, e.g. "supabase-dev-studio". */
  resourceName: string;
  /** Hostname for the Google-managed certificate. */
  domain: string;
  backendService: gcp.compute.BackendService;
  labels: Record<string, string>;
}

/**
 * A global external HTTPS load balancer in front of one backend service:
 *
 * - a reserved global IPv4 address (point the domain's A record at it);
 * - a Google-managed certificate for the domain, which Google issues once the
 *   A record resolves to the address;
 * - an SSL policy that requires TLS 1.2 or later;
 * - HTTPS on 443, and HTTP on 80 that only redirects to HTTPS.
 *
 * Cloud Armor is attached to the backend service, not here, so the HTTP
 * redirect answers anyone; it reveals nothing beyond the hostname.
 */
export class HttpsLoadBalancer extends pulumi.ComponentResource {
  public readonly address: gcp.compute.GlobalAddress;
  public readonly certificate: gcp.compute.ManagedSslCertificate;
  public readonly sslPolicy: gcp.compute.SSLPolicy;
  public readonly urlMap: gcp.compute.URLMap;
  public readonly httpsProxy: gcp.compute.TargetHttpsProxy;
  public readonly httpsForwardingRule: gcp.compute.GlobalForwardingRule;
  public readonly redirectUrlMap: gcp.compute.URLMap;
  public readonly httpProxy: gcp.compute.TargetHttpProxy;
  public readonly httpForwardingRule: gcp.compute.GlobalForwardingRule;
  public readonly ipAddress: pulumi.Output<string>;

  constructor(name: string, args: HttpsLoadBalancerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:HttpsLoadBalancer", name, {}, opts);

    const resourceName = args.resourceName;

    this.address = new gcp.compute.GlobalAddress(
      `${name}-ip`,
      {
        name: `${resourceName}-ip`,
        ipVersion: "IPV4",
        labels: args.labels,
      },
      { parent: this },
    );
    this.ipAddress = this.address.address;

    // No fixed `name`: if the domain changes, Pulumi creates the new
    // certificate first, moves the proxy to it, then deletes the old one.
    this.certificate = new gcp.compute.ManagedSslCertificate(
      `${resourceName}-cert`,
      {
        managed: { domains: [args.domain] },
      },
      { parent: this },
    );

    this.sslPolicy = new gcp.compute.SSLPolicy(
      `${name}-ssl-policy`,
      {
        name: `${resourceName}-ssl-policy`,
        profile: "MODERN",
        minTlsVersion: "TLS_1_2",
      },
      { parent: this },
    );

    this.urlMap = new gcp.compute.URLMap(
      `${name}-url-map`,
      {
        name: `${resourceName}-https`,
        defaultService: args.backendService.id,
      },
      { parent: this },
    );

    this.httpsProxy = new gcp.compute.TargetHttpsProxy(
      `${name}-https-proxy`,
      {
        name: `${resourceName}-https`,
        urlMap: this.urlMap.id,
        sslCertificates: [this.certificate.id],
        sslPolicy: this.sslPolicy.id,
      },
      { parent: this },
    );

    this.httpsForwardingRule = new gcp.compute.GlobalForwardingRule(
      `${name}-https-rule`,
      {
        name: `${resourceName}-https`,
        target: this.httpsProxy.id,
        ipAddress: this.address.id,
        ipProtocol: "TCP",
        portRange: "443",
        loadBalancingScheme: LOAD_BALANCING_SCHEME,
        labels: args.labels,
      },
      { parent: this },
    );

    this.redirectUrlMap = new gcp.compute.URLMap(
      `${name}-redirect-url-map`,
      {
        name: `${resourceName}-http-redirect`,
        defaultUrlRedirect: {
          httpsRedirect: true,
          redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
          stripQuery: false,
        },
      },
      { parent: this },
    );

    this.httpProxy = new gcp.compute.TargetHttpProxy(
      `${name}-http-proxy`,
      {
        name: `${resourceName}-http-redirect`,
        urlMap: this.redirectUrlMap.id,
      },
      { parent: this },
    );

    this.httpForwardingRule = new gcp.compute.GlobalForwardingRule(
      `${name}-http-rule`,
      {
        name: `${resourceName}-http-redirect`,
        target: this.httpProxy.id,
        ipAddress: this.address.id,
        ipProtocol: "TCP",
        portRange: "80",
        loadBalancingScheme: LOAD_BALANCING_SCHEME,
        labels: args.labels,
      },
      { parent: this },
    );

    this.registerOutputs({ ipAddress: this.ipAddress });
  }
}
