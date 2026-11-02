import * as pulumi from "@pulumi/pulumi";

import { DEFAULT_IMAGES, ImageSettings } from "./images";
import {
  DatabaseSettings,
  NetworkSettings,
  PRESETS,
  PRESET_NAMES,
  PresetName,
  StudioSettings,
  VpnSettings,
} from "./presets";

export * from "./images";
export * from "./presets";

export interface DatabaseConfig extends DatabaseSettings {
  /** Cloud SQL version, e.g. POSTGRES_18. */
  databaseVersion: string;
  /** Database that Studio and postgres-meta open. Cloud SQL creates `postgres` itself. */
  databaseName: string;
  /** Start of the daily backup window, HH:MM in UTC. */
  backupStartTime: string;
  /** Where backups are stored, e.g. "europe-west2". Unset: Cloud SQL's default, the multi-region nearest the instance. */
  backupLocation?: string;
  /** Maintenance window: day 1 (Monday) to 7 (Sunday), hour 0-23, UTC. */
  maintenanceDay: number;
  maintenanceHour: number;
}

export interface StudioConfig extends StudioSettings {
  /** Basic-auth user name. The password is generated. */
  username: string;
  /** Names shown in Studio's sidebar. */
  organizationName: string;
  projectName: string;
  /** Zones for the instance group, e.g. ["europe-west2-a", "europe-west2-b"]. Unset: Google Cloud picks. */
  zones?: string[];
}

export interface VpnConfig extends VpnSettings {
  /** Zone for the VPN VM and its disk. Defaults to `gcp:zone`. */
  zone: string;
  /** Port of Outline's management API, used by Outline Manager. */
  apiPort: number;
  /** Port VPN clients connect to, TCP and UDP. */
  accessKeyPort: number;
  /** Source ranges allowed to reach the management API port. */
  managementSourceRanges: string[];
  /** Hostname put into access keys and the API URL. Defaults to the VPN's static IP. */
  hostname?: string;
}

/** Fully resolved settings for one stack. Built by {@link resolveConfig}. */
export interface StackConfig {
  projectId: string;
  region: string;
  stack: string;
  presetName: PresetName;
  /** Prefix for resource names, e.g. "supabase-dev". */
  namePrefix: string;
  /** Hostname Studio is served on. */
  domain: string;
  subnetCidr: string;
  /** Size of the range reserved for Cloud SQL's private IP (private services access). */
  privateServicesPrefixLength: number;
  /** Allow SSH to the VMs through Identity-Aware Proxy. */
  enableIapSsh: boolean;
  /** Extra IPv4 ranges Cloud Armor lets through to Studio, besides the VPN. */
  allowedSourceRanges: string[];
  labels: Record<string, string>;
  network: NetworkSettings;
  database: DatabaseConfig;
  studio: StudioConfig;
  vpn: VpnConfig;
  images: ImageSettings;
}

/** Stack config as read from Pulumi, before defaults and validation. */
export interface RawConfig {
  stack: string;
  projectId?: string;
  region?: string;
  zone?: string;
  domain?: string;
  preset?: string;
  namePrefix?: string;
  subnetCidr?: string;
  privateServicesPrefixLength?: number;
  enableIapSsh?: boolean;
  allowedSourceRanges?: unknown;
  network?: unknown;
  database?: unknown;
  studio?: unknown;
  vpn?: unknown;
  images?: unknown;
}

const DATABASE_DEFAULTS = {
  databaseVersion: "POSTGRES_18",
  databaseName: "postgres",
  backupStartTime: "03:00",
  maintenanceDay: 7,
  maintenanceHour: 4,
};

const STUDIO_DEFAULTS = {
  username: "supabase",
  organizationName: "Default Organization",
  projectName: "Default Project",
};

const VPN_DEFAULTS = {
  apiPort: 8443,
  // 443 is the port most networks let through, which matters for a VPN people use while travelling.
  accessKeyPort: 443,
  managementSourceRanges: ["0.0.0.0/0"],
};

type FieldKind = "string" | "number" | "boolean" | "string[]";

// Every overridable field, with its type. Unknown keys are rejected so that a
// typo in the stack config fails loudly instead of being ignored.
const NETWORK_FIELDS = {
  privateServicesDeletionPolicy: "string",
} as const satisfies Record<keyof NetworkSettings, FieldKind>;

const DATABASE_FIELDS = {
  edition: "string",
  tier: "string",
  availabilityType: "string",
  diskSizeGb: "number",
  diskAutoresizeLimitGb: "number",
  dataCacheEnabled: "boolean",
  deletionProtection: "boolean",
  retainBackupsOnDelete: "boolean",
  retainedBackups: "number",
  transactionLogRetentionDays: "number",
  maxConnections: "number",
  databaseVersion: "string",
  databaseName: "string",
  backupStartTime: "string",
  backupLocation: "string",
  maintenanceDay: "number",
  maintenanceHour: "number",
} as const satisfies Record<keyof DatabaseConfig, FieldKind>;

const STUDIO_FIELDS = {
  machineType: "string",
  bootDiskType: "string",
  bootDiskSizeGb: "number",
  minReplicas: "number",
  maxReplicas: "number",
  cpuTarget: "number",
  username: "string",
  organizationName: "string",
  projectName: "string",
  zones: "string[]",
} as const satisfies Record<keyof StudioConfig, FieldKind>;

const VPN_FIELDS = {
  machineType: "string",
  bootDiskSizeGb: "number",
  dataDiskSizeGb: "number",
  zone: "string",
  apiPort: "number",
  accessKeyPort: "number",
  managementSourceRanges: "string[]",
  hostname: "string",
} as const satisfies Record<keyof VpnConfig, FieldKind>;

const IMAGE_FIELDS = {
  studio: "string",
  pgMeta: "string",
  proxy: "string",
  outline: "string",
} as const satisfies Record<keyof ImageSettings, FieldKind>;

/** Reads the stack config with `pulumi.Config` and resolves it. */
export function loadConfig(): StackConfig {
  const config = new pulumi.Config();
  const gcpConfig = new pulumi.Config("gcp");
  return resolveConfig({
    stack: pulumi.getStack(),
    projectId: gcpConfig.get("project"),
    region: gcpConfig.get("region"),
    zone: gcpConfig.get("zone"),
    domain: config.get("domain"),
    preset: config.get("preset"),
    namePrefix: config.get("namePrefix"),
    subnetCidr: config.get("subnetCidr"),
    privateServicesPrefixLength: config.getNumber("privateServicesPrefixLength"),
    enableIapSsh: config.getBoolean("enableIapSsh"),
    allowedSourceRanges: config.getObject("allowedSourceRanges"),
    network: config.getObject("network"),
    database: config.getObject("database"),
    studio: config.getObject("studio"),
    vpn: config.getObject("vpn"),
    images: config.getObject("images"),
  });
}

/**
 * Applies the preset and the defaults to the raw stack config and validates
 * the result. Precedence for every field: stack config, then preset, then
 * defaults.
 */
export function resolveConfig(raw: RawConfig): StackConfig {
  const projectId = required("gcp:project", raw.projectId);
  const region = required("gcp:region", raw.region);
  const domain = required("domain", raw.domain).toLowerCase();
  check(isHostname(domain), `domain must be a hostname such as studio.example.com, got "${domain}"`);

  const presetName = (raw.preset ?? "small") as PresetName;
  check(PRESET_NAMES.includes(presetName), `preset must be one of ${PRESET_NAMES.join(", ")}, got "${raw.preset}"`);
  const preset = PRESETS[presetName];

  const namePrefix = raw.namePrefix ?? defaultNamePrefix(raw.stack);
  check(
    /^[a-z][a-z0-9-]{0,18}[a-z0-9]$/.test(namePrefix),
    `namePrefix must be 2-20 characters of lowercase letters, digits and hyphens, starting with a letter ` +
      `(it becomes part of service account IDs, which must be 6-30 characters), got "${namePrefix}"`,
  );

  const subnetCidr = raw.subnetCidr ?? "10.0.1.0/24";
  check(isIpv4Cidr(subnetCidr, 8, 29), `subnetCidr must be an IPv4 range between /8 and /29, got "${subnetCidr}"`);

  const privateServicesPrefixLength = raw.privateServicesPrefixLength ?? 16;
  check(
    Number.isInteger(privateServicesPrefixLength) && privateServicesPrefixLength >= 8 && privateServicesPrefixLength <= 24,
    `privateServicesPrefixLength must be an integer from 8 to 24, got ${privateServicesPrefixLength}`,
  );

  const allowedSourceRanges = readStringList("allowedSourceRanges", raw.allowedSourceRanges) ?? [];
  // Cloud Armor allows at most 10 ranges per rule; these share one rule.
  check(allowedSourceRanges.length <= 10, "allowedSourceRanges can list at most 10 ranges");
  for (const range of allowedSourceRanges) {
    check(isIpv4Cidr(range, 0, 32) && range !== "0.0.0.0/0", `allowedSourceRanges: "${range}" must be an IPv4 range other than 0.0.0.0/0`);
  }

  const network: NetworkSettings = { ...preset.network, ...readSection<NetworkSettings>("network", raw.network, NETWORK_FIELDS) };
  check(
    ["DELETE", "REMOVE_PEERING"].includes(network.privateServicesDeletionPolicy),
    `network.privateServicesDeletionPolicy must be DELETE or REMOVE_PEERING, got "${network.privateServicesDeletionPolicy}"`,
  );

  const database: DatabaseConfig = {
    ...DATABASE_DEFAULTS,
    ...preset.database,
    ...readSection<DatabaseConfig>("database", raw.database, DATABASE_FIELDS),
  };
  validateDatabase(database);

  const studio: StudioConfig = {
    ...STUDIO_DEFAULTS,
    ...preset.studio,
    ...readSection<StudioConfig>("studio", raw.studio, STUDIO_FIELDS),
  };
  validateStudio(studio, region);

  const vpnOverrides = readSection<VpnConfig>("vpn", raw.vpn, VPN_FIELDS);
  const vpn: VpnConfig = {
    ...VPN_DEFAULTS,
    ...preset.vpn,
    ...vpnOverrides,
    zone: required("gcp:zone", vpnOverrides.zone ?? raw.zone, "the zone for the VPN VM; set gcp:zone, or vpn.zone to override it"),
  };
  validateVpn(vpn, region);

  const images: ImageSettings = { ...DEFAULT_IMAGES, ...readSection<ImageSettings>("images", raw.images, IMAGE_FIELDS) };
  for (const [key, image] of Object.entries(images)) {
    check(/^[a-z0-9][a-z0-9._\/:@-]*$/i.test(image), `images.${key} is not a valid image reference: "${image}"`);
  }

  return {
    projectId,
    region,
    stack: raw.stack,
    presetName,
    namePrefix,
    domain,
    subnetCidr,
    privateServicesPrefixLength,
    enableIapSsh: raw.enableIapSsh ?? true,
    allowedSourceRanges,
    labels: { app: "supabase", stack: namePrefix, "managed-by": "pulumi" },
    network,
    database,
    studio,
    vpn,
    images,
  };
}

function validateDatabase(db: DatabaseConfig): void {
  check(["ENTERPRISE", "ENTERPRISE_PLUS"].includes(db.edition), `database.edition must be ENTERPRISE or ENTERPRISE_PLUS, got "${db.edition}"`);
  check(["ZONAL", "REGIONAL"].includes(db.availabilityType), `database.availabilityType must be ZONAL or REGIONAL, got "${db.availabilityType}"`);
  // The instance uses SSD storage (components/database.ts). Cloud SQL's N4, C4
  // and C4A machine series only take Hyperdisk Balanced, so they can't be
  // used here. Better to fail now than halfway through a deploy.
  check(
    !/^db-(custom-n4-|perf-optimized-c4-|c4a-)/i.test(db.tier),
    `database.tier "${db.tier}" is in a machine series that needs Hyperdisk storage, which this template doesn't set up; ` +
      `use db-perf-optimized-N-<vCPUs> (Enterprise Plus) or db-custom-<vCPUs>-<MB> (Enterprise)`,
  );
  if (db.edition === "ENTERPRISE_PLUS") {
    check(db.tier.startsWith("db-perf-optimized-"), `database.tier "${db.tier}" isn't an Enterprise Plus tier; use db-perf-optimized-N-<vCPUs>`);
  } else {
    check(!db.tier.startsWith("db-perf-optimized-"), `database.tier "${db.tier}" needs database.edition ENTERPRISE_PLUS`);
    check(!db.dataCacheEnabled, "database.dataCacheEnabled needs database.edition ENTERPRISE_PLUS");
  }
  check(/^POSTGRES_\d+$/.test(db.databaseVersion), `database.databaseVersion must look like POSTGRES_18, got "${db.databaseVersion}"`);
  check(/^[a-z_][a-z0-9_]{0,62}$/.test(db.databaseName), `database.databaseName must be a lowercase PostgreSQL identifier, got "${db.databaseName}"`);
  checkInteger("database.diskSizeGb", db.diskSizeGb, 10, 65536);
  checkInteger("database.diskAutoresizeLimitGb", db.diskAutoresizeLimitGb, 0, 65536);
  check(
    db.diskAutoresizeLimitGb === 0 || db.diskAutoresizeLimitGb >= db.diskSizeGb,
    "database.diskAutoresizeLimitGb must be 0 (no limit) or at least database.diskSizeGb",
  );
  checkInteger("database.retainedBackups", db.retainedBackups, 1, 365);
  checkInteger("database.transactionLogRetentionDays", db.transactionLogRetentionDays, 1, db.edition === "ENTERPRISE_PLUS" ? 35 : 7);
  checkInteger("database.maxConnections", db.maxConnections, 14, 262143);
  check(/^([01]\d|2[0-3]):[0-5]\d$/.test(db.backupStartTime), `database.backupStartTime must be HH:MM, got "${db.backupStartTime}"`);
  if (db.backupLocation !== undefined) {
    check(/^[a-z][a-z0-9-]*$/.test(db.backupLocation), `database.backupLocation must be a region or multi-region such as europe-west2 or eu, got "${db.backupLocation}"`);
  }
  checkInteger("database.maintenanceDay", db.maintenanceDay, 1, 7);
  checkInteger("database.maintenanceHour", db.maintenanceHour, 0, 23);
}

function validateStudio(studio: StudioConfig, region: string): void {
  checkInteger("studio.minReplicas", studio.minReplicas, 1, 100);
  checkInteger("studio.maxReplicas", studio.maxReplicas, studio.minReplicas, 100);
  check(studio.cpuTarget > 0 && studio.cpuTarget <= 1, `studio.cpuTarget must be above 0 and at most 1, got ${studio.cpuTarget}`);
  checkInteger("studio.bootDiskSizeGb", studio.bootDiskSizeGb, 10, 1000);
  // The user name ends up in an htpasswd line, so no colons or spaces.
  check(/^[A-Za-z0-9._-]{1,64}$/.test(studio.username), `studio.username may use letters, digits, ".", "_" and "-" only, got "${studio.username}"`);
  for (const key of ["organizationName", "projectName"] as const) {
    check(/^[^\r\n]{1,100}$/.test(studio[key]), `studio.${key} must be 1-100 characters on one line`);
  }
  for (const zone of studio.zones ?? []) {
    check(zone.startsWith(`${region}-`), `studio.zones: "${zone}" isn't in region ${region}`);
  }
}

function validateVpn(vpn: VpnConfig, region: string): void {
  check(vpn.zone.startsWith(`${region}-`), `the VPN zone "${vpn.zone}" isn't in region ${region}; set gcp:zone or vpn.zone`);
  for (const key of ["apiPort", "accessKeyPort"] as const) {
    checkInteger(`vpn.${key}`, vpn[key], 1, 65535);
    check(vpn[key] !== 22, `vpn.${key} can't be 22 (SSH)`);
    // The Outline server binds its metrics endpoints to free local ports from 9090 up.
    check(vpn[key] < 9090 || vpn[key] > 9099, `vpn.${key} can't be in 9090-9099, which the Outline server uses internally`);
  }
  check(vpn.apiPort !== vpn.accessKeyPort, "vpn.apiPort and vpn.accessKeyPort must be different");
  check(vpn.managementSourceRanges.length > 0, "vpn.managementSourceRanges can't be empty");
  for (const range of vpn.managementSourceRanges) {
    check(isIpv4Cidr(range, 0, 32), `vpn.managementSourceRanges: "${range}" isn't an IPv4 range`);
  }
  if (vpn.hostname !== undefined) {
    check(isHostname(vpn.hostname) || isIpv4(vpn.hostname), `vpn.hostname must be a hostname or an IPv4 address, got "${vpn.hostname}"`);
  }
  checkInteger("vpn.bootDiskSizeGb", vpn.bootDiskSizeGb, 10, 1000);
  checkInteger("vpn.dataDiskSizeGb", vpn.dataDiskSizeGb, 10, 1000);
}

/** "supabase-<stack>", reduced to the characters and length GCP names allow. */
function defaultNamePrefix(stack: string): string {
  const slug = stack
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `supabase-${slug}`.slice(0, 20).replace(/-+$/, "");
}

function readSection<T>(section: string, value: unknown, fields: Record<keyof T, FieldKind>): Partial<T> {
  if (value === undefined || value === null) {
    return {};
  }
  check(typeof value === "object" && !Array.isArray(value), `${section} must be an object`);
  const known = fields as Record<string, FieldKind>;
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    const kind = known[key];
    check(kind !== undefined, `unknown key "${section}.${key}". Known keys: ${Object.keys(known).join(", ")}`);
    check(hasKind(fieldValue, kind), `${section}.${key} must be a ${kind}`);
    result[key] = fieldValue;
  }
  return result as Partial<T>;
}

function readStringList(name: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  check(hasKind(value, "string[]"), `${name} must be a list of strings`);
  return value as string[];
}

function hasKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === kind;
  }
}

function required(key: string, value: string | undefined, what?: string): string {
  check(value !== undefined && value !== "", `${key} is required${what ? ` (${what})` : ""}: pulumi config set ${key} <value>`);
  return value as string;
}

function checkInteger(name: string, value: number, min: number, max: number): void {
  check(Number.isInteger(value) && value >= min && value <= max, `${name} must be an integer from ${min} to ${max}, got ${value}`);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new pulumi.RunError(`Invalid stack config: ${message}`);
  }
}

function isHostname(value: string): boolean {
  return value.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv4Cidr(value: string, minPrefix: number, maxPrefix: number): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || address === undefined || prefix === undefined || !/^\d{1,2}$/.test(prefix)) {
    return false;
  }
  const length = Number(prefix);
  return isIpv4(address) && length >= minPrefix && length <= maxPrefix;
}
