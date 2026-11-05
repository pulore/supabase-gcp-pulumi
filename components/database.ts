import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { DatabaseConfig } from "../config";
import { ManagedSecret } from "./secret";

export interface DatabaseArgs {
  namePrefix: string;
  region: string;
  network: gcp.compute.Network;
  /** Cloud SQL can only get a private IP once this connection exists. */
  privateServicesConnection: gcp.servicenetworking.Connection;
  settings: DatabaseConfig;
  labels: Record<string, string>;
}

/**
 * Cloud SQL for PostgreSQL with a private IP and no public IP, automated daily
 * backups and point-in-time recovery.
 *
 * Studio and postgres-meta connect as the built-in `postgres` user. On Cloud
 * SQL that user is not a superuser: it has CREATEROLE and CREATEDB and is a
 * member of `cloudsqlsuperuser`. Its password is generated here and stored in
 * Secret Manager.
 */
export class Database extends pulumi.ComponentResource {
  public readonly instance: gcp.sql.DatabaseInstance;
  /** Only created when `databaseName` isn't "postgres", which Cloud SQL creates itself. */
  public readonly database?: gcp.sql.Database;
  public readonly passwordSecret: ManagedSecret;
  public readonly password: pulumi.Output<string>;
  public readonly privateIp: pulumi.Output<string>;
  public readonly databaseName: string;
  public readonly user = "postgres";
  public readonly port = 5432;

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    super("supabase-gcp:components:Database", name, {}, opts);

    const s = args.settings;
    this.databaseName = s.databaseName;

    // Letters and digits only: Studio puts the password into a postgresql://
    // URL without escaping it.
    const password = new random.RandomPassword(
      `${name}-password`,
      { length: 32, special: false },
      { parent: this },
    );
    this.password = password.result;

    this.instance = new gcp.sql.DatabaseInstance(
      `${name}-instance`,
      {
        // A fixed name on purpose: if a change ever forces Pulumi to replace
        // the instance, creating the new one fails on the name instead of
        // starting an empty database next to the old one.
        name: `${args.namePrefix}-db`,
        databaseVersion: s.databaseVersion,
        region: args.region,
        deletionProtection: s.deletionProtection,
        // Sets the password of the built-in postgres user.
        rootPassword: password.result,
        settings: {
          edition: s.edition,
          tier: s.tier,
          availabilityType: s.availabilityType,

          diskType: "PD_SSD",
          diskSize: s.diskSizeGb,
          diskAutoresize: true,
          diskAutoresizeLimit: s.diskAutoresizeLimitGb,

          dataCacheConfig: s.edition === "ENTERPRISE_PLUS" ? { dataCacheEnabled: s.dataCacheEnabled } : undefined,

          // Also blocks deletion from the console, gcloud and the API.
          deletionProtectionEnabled: s.deletionProtection,
          retainBackupsOnDelete: s.retainBackupsOnDelete,

          ipConfiguration: {
            ipv4Enabled: false,
            privateNetwork: args.network.id,
            enablePrivatePathForGoogleCloudServices: false,
            // Refuse connections without TLS. postgres-meta, the only
            // client, is set to use TLS (PGSSLMODE in
            // scripts/supabase-studio.sh). See "Security notes" in the README.
            sslMode: "ENCRYPTED_ONLY",
          },

          backupConfiguration: {
            enabled: true,
            startTime: s.backupStartTime,
            location: s.backupLocation,
            pointInTimeRecoveryEnabled: true,
            transactionLogRetentionDays: s.transactionLogRetentionDays,
            backupRetentionSettings: {
              retainedBackups: s.retainedBackups,
              retentionUnit: "COUNT",
            },
          },

          maintenanceWindow: {
            day: s.maintenanceDay,
            hour: s.maintenanceHour,
            updateTrack: "stable",
          },

          databaseFlags: [
            { name: "max_connections", value: String(s.maxConnections) },
            { name: "cloudsql.iam_authentication", value: "on" },
          ],

          insightsConfig: {
            queryInsightsEnabled: true,
            queryPlansPerMinute: 5,
            queryStringLength: 1024,
            recordApplicationTags: true,
            recordClientAddress: true,
          },

          userLabels: args.labels,
        },
      },
      { parent: this, dependsOn: [args.privateServicesConnection] },
    );

    if (s.databaseName !== "postgres") {
      this.database = new gcp.sql.Database(
        `${name}-${s.databaseName}`,
        {
          name: s.databaseName,
          instance: this.instance.name,
          charset: "UTF8",
          collation: "en_US.UTF8",
          // PostgreSQL won't drop a database while users are connected, so on
          // destroy leave it to be deleted with the instance.
          deletionPolicy: "ABANDON",
        },
        { parent: this },
      );
    }

    this.passwordSecret = new ManagedSecret(
      `${name}-password`,
      {
        secretId: `${args.namePrefix}-db-password`,
        value: password.result,
        labels: args.labels,
      },
      { parent: this },
    );

    this.privateIp = this.instance.privateIpAddress;

    this.registerOutputs({
      instanceName: this.instance.name,
      connectionName: this.instance.connectionName,
      privateIp: this.privateIp,
    });
  }
}
