/**
 * Supabase Studio on Google Cloud: Cloud SQL on a private IP, an Outline VPN,
 * and Studio + postgres-meta on an autoscaled managed instance group behind
 * an HTTPS load balancer that Cloud Armor restricts to the VPN's IP.
 *
 * This file only wires the pieces together. The details are in components/
 * and services/; the settings are in config/.
 */
import { Database, IAP_SSH_TAG, Network, OutlineVpn } from "./components";
import { loadConfig } from "./config";
import { SupabaseStudio } from "./services";

const config = loadConfig();
const sshTags = config.enableIapSsh ? [IAP_SSH_TAG] : [];

// VPC, subnet, private services access for Cloud SQL, Cloud Router and NAT.
const network = new Network("network", {
  namePrefix: config.namePrefix,
  region: config.region,
  subnetCidr: config.subnetCidr,
  privateServicesPrefixLength: config.privateServicesPrefixLength,
  privateServicesDeletionPolicy: config.network.privateServicesDeletionPolicy,
  enableIapSsh: config.enableIapSsh,
});

// Cloud SQL for PostgreSQL, private IP only, with backups and point-in-time recovery.
const database = new Database("database", {
  namePrefix: config.namePrefix,
  region: config.region,
  network: network.vpc,
  privateServicesConnection: network.privateServicesConnection,
  settings: config.database,
  labels: config.labels,
});

// Outline VPN server with a static IP: the address Studio's allowlist is built on.
const vpn = new OutlineVpn("vpn", {
  namePrefix: config.namePrefix,
  projectId: config.projectId,
  region: config.region,
  network: network.vpc,
  subnet: network.subnet,
  settings: config.vpn,
  image: config.images.outline,
  extraTags: sshTags,
  labels: config.labels,
});

// Studio and postgres-meta behind the HTTPS load balancer and Cloud Armor.
const studio = new SupabaseStudio("studio", {
  namePrefix: config.namePrefix,
  projectId: config.projectId,
  region: config.region,
  domain: config.domain,
  network,
  database,
  vpnIp: vpn.publicIp,
  allowedSourceRanges: config.allowedSourceRanges,
  settings: config.studio,
  images: config.images,
  extraTags: sshTags,
  labels: config.labels,
});

/** Open this while connected to the VPN. */
export const studioUrl = studio.url;
/** Point the domain's A record at this address. */
export const studioIpAddress = studio.loadBalancer.ipAddress;
export const studioUsername = studio.username;
/** Show it with `pulumi stack output studioPassword --show-secrets`. */
export const studioPassword = studio.password;
export const studioPasswordSecret = studio.passwordSecret.secretId;

export const vpnIpAddress = vpn.publicIp;
/** Paste into Outline Manager: `pulumi stack output outlineManagerConfig --show-secrets`. */
export const outlineManagerConfig = vpn.managerConfig;

export const databaseInstanceName = database.instance.name;
export const databaseConnectionName = database.instance.connectionName;
export const databasePrivateIp = database.privateIp;
export const databasePasswordSecret = database.passwordSecret.secretId;
