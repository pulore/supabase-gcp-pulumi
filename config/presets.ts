/**
 * Presets hold the settings that usually differ between a trial or development
 * environment and production: machine sizes, availability, backup retention and
 * deletion protection. Choose one with the `preset` stack config key, then
 * override single fields under `database`, `studio` or `vpn`.
 *
 * Resolution order, for every field: stack config, then the preset, then the
 * defaults in config/index.ts.
 */

export type PresetName = "small" | "production-4vcpu" | "production";

export const PRESET_NAMES: readonly PresetName[] = ["small", "production-4vcpu", "production"];

export interface NetworkSettings {
  /**
   * What `pulumi destroy` does with the private services connection. Cloud SQL
   * can hold on to the VPC peering for a while after the instance is deleted,
   * which blocks deleting the network. "REMOVE_PEERING" removes the peering in
   * that case so the destroy finishes; "DELETE" leaves it to you.
   */
  privateServicesDeletionPolicy: "DELETE" | "REMOVE_PEERING";
}

export interface DatabaseSettings {
  /** Cloud SQL edition. Data Cache is only available on ENTERPRISE_PLUS. */
  edition: "ENTERPRISE" | "ENTERPRISE_PLUS";
  /**
   * Machine tier. ENTERPRISE_PLUS uses the db-perf-optimized-N-* tiers;
   * ENTERPRISE uses db-custom-<vCPUs>-<MB> and the shared-core tiers.
   */
  tier: string;
  /** ZONAL: one zone. REGIONAL: a standby in a second zone with automatic failover. */
  availabilityType: "ZONAL" | "REGIONAL";
  /** Initial SSD size in GB. Cloud SQL can grow it but never shrink it. */
  diskSizeGb: number;
  /** Ceiling for automatic storage increases, in GB. 0 means no ceiling. */
  diskAutoresizeLimitGb: number;
  dataCacheEnabled: boolean;
  /** Blocks deleting the instance, both through Pulumi and through the Cloud SQL API. */
  deletionProtection: boolean;
  /** Keep the automated backups after the instance is deleted. */
  retainBackupsOnDelete: boolean;
  /** Number of daily automated backups to keep (1-365). */
  retainedBackups: number;
  /**
   * Days of write-ahead log kept for point-in-time recovery: 1-7 on
   * ENTERPRISE, 1-35 on ENTERPRISE_PLUS.
   */
  transactionLogRetentionDays: number;
  maxConnections: number;
}

export interface StudioSettings {
  machineType: string;
  /** Boot disk type. Use hyperdisk-balanced only with machine series that support it (C3, C4, C4D, N4 and others; not E2). */
  bootDiskType: string;
  bootDiskSizeGb: number;
  /** Autoscaler bounds for the managed instance group. */
  minReplicas: number;
  maxReplicas: number;
  /** Average CPU utilisation the autoscaler aims for, between 0 and 1. */
  cpuTarget: number;
}

export interface VpnSettings {
  machineType: string;
  bootDiskSizeGb: number;
  /** Persistent disk that holds Outline's state (access keys and server settings). */
  dataDiskSizeGb: number;
}

export interface Preset {
  network: NetworkSettings;
  database: DatabaseSettings;
  studio: StudioSettings;
  vpn: VpnSettings;
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  /**
   * For trying the template and for development: Cloud SQL ENTERPRISE in one
   * zone, one Studio VM (autoscaling to two), no deletion protection, and a
   * teardown that removes the Cloud SQL peering if it has to.
   */
  small: {
    network: {
      privateServicesDeletionPolicy: "REMOVE_PEERING",
    },
    database: {
      edition: "ENTERPRISE",
      tier: "db-custom-1-3840",
      availabilityType: "ZONAL",
      diskSizeGb: 20,
      diskAutoresizeLimitGb: 100,
      dataCacheEnabled: false,
      deletionProtection: false,
      retainBackupsOnDelete: false,
      retainedBackups: 7,
      transactionLogRetentionDays: 7,
      maxConnections: 100,
    },
    studio: {
      machineType: "e2-medium",
      bootDiskType: "pd-balanced",
      bootDiskSizeGb: 20,
      minReplicas: 1,
      maxReplicas: 2,
      cpuTarget: 0.7,
    },
    vpn: {
      machineType: "e2-small",
      bootDiskSizeGb: 10,
      dataDiskSizeGb: 10,
    },
  },

  /**
   * `production` with half the database: Cloud SQL Enterprise Plus on
   * db-perf-optimized-N-4 (4 vCPUs, 32 GB of memory, 375 GB of Data Cache)
   * instead of 8 vCPUs and 64 GB. The rest is the same as `production`: a
   * standby in a second zone, 35 daily backups, deletion protection, and the
   * same disk, because Cloud SQL ties an N2 instance's IOPS and throughput to
   * its storage size. Studio's load depends on how many people use it, not
   * on the size of the database, so the Studio VMs and the VPN are the same.
   */
  "production-4vcpu": {
    network: {
      privateServicesDeletionPolicy: "DELETE",
    },
    database: {
      edition: "ENTERPRISE_PLUS",
      tier: "db-perf-optimized-N-4",
      availabilityType: "REGIONAL",
      diskSizeGb: 250,
      diskAutoresizeLimitGb: 1000,
      dataCacheEnabled: true,
      deletionProtection: true,
      retainBackupsOnDelete: true,
      retainedBackups: 35,
      transactionLogRetentionDays: 7,
      maxConnections: 200,
    },
    studio: {
      machineType: "e2-standard-2",
      bootDiskType: "pd-balanced",
      bootDiskSizeGb: 50,
      minReplicas: 2,
      maxReplicas: 4,
      cpuTarget: 0.7,
    },
    vpn: {
      machineType: "e2-small",
      bootDiskSizeGb: 10,
      dataDiskSizeGb: 10,
    },
  },

  /**
   * The production database from the blog series: Cloud SQL Enterprise Plus
   * with Data Cache and a standby in a second zone, 35 daily backups and
   * deletion protection. Two Studio VMs in different zones.
   */
  production: {
    network: {
      privateServicesDeletionPolicy: "DELETE",
    },
    database: {
      edition: "ENTERPRISE_PLUS",
      tier: "db-perf-optimized-N-8",
      availabilityType: "REGIONAL",
      diskSizeGb: 250,
      diskAutoresizeLimitGb: 1000,
      dataCacheEnabled: true,
      deletionProtection: true,
      retainBackupsOnDelete: true,
      retainedBackups: 35,
      transactionLogRetentionDays: 7,
      maxConnections: 200,
    },
    studio: {
      machineType: "e2-standard-2",
      bootDiskType: "pd-balanced",
      bootDiskSizeGb: 50,
      minReplicas: 2,
      maxReplicas: 4,
      cpuTarget: 0.7,
    },
    vpn: {
      machineType: "e2-small",
      bootDiskSizeGb: 10,
      dataDiskSizeGb: 10,
    },
  },
};
