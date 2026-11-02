# Supabase Studio on Google Cloud with Pulumi

[![CI](https://github.com/pulore/supabase-gcp-pulumi/actions/workflows/ci.yml/badge.svg)](https://github.com/pulore/supabase-gcp-pulumi/actions/workflows/ci.yml)

A Pulumi (TypeScript) program that runs Supabase Studio and postgres-meta on Google Cloud, against Cloud SQL for PostgreSQL on a private IP. Studio is reached through your own Outline VPN: a Cloud Armor policy on the load balancer lets in the VPN's static IP (and any ranges you add) and returns 403 to everyone else.

It is the setup from Pulore's blog series on self-hosting Supabase on Google Cloud ([list below](#the-blog-series)), rewritten as a generic template.

## What it deploys

```text
  Team member's laptop (Outline client)
              │  VPN tunnel, access-key port (TCP/UDP)
              ▼
  ┌───────────────────────────┐
  │ Outline VPN VM            │  static public IP
  │ Container-Optimized OS    │  persistent disk for Outline's state
  └─────────────┬─────────────┘
                │  HTTPS, from the VPN's static IP
                ▼
  ┌───────────────────────────┐
  │ Global external HTTPS     │  Google-managed certificate, TLS 1.2+
  │ load balancer             │  Cloud Armor: allow the VPN's IP, deny the rest
  └─────────────┬─────────────┘
                │  port 8000, from Google's load balancer ranges only
 ───── VPC ─────┼──────────────────────────────────────────────────────────
  ┌─────────────▼─────────────┐
  │ Regional managed instance │  autoscaled, auto-healed, no external IPs
  │ group (Container-Opt. OS) │
  │   nginx (basic auth)      │
  │   Supabase Studio         │
  │   postgres-meta           │
  └─────────────┬─────────────┘
                │  private IP (private services access)
  ┌─────────────▼─────────────┐
  │ Cloud SQL for PostgreSQL  │  no public IP
  │                           │  daily backups, point-in-time recovery
  └───────────────────────────┘

  Also: Cloud Router + Cloud NAT (outbound image pulls), Secret Manager (every secret)
```

| Part | Resources |
| --- | --- |
| Network ([components/network.ts](components/network.ts)) | Custom-mode VPC and subnet (Private Google Access on), a reserved range and service networking connection for Cloud SQL's private IP, Cloud Router and Cloud NAT, and a firewall rule for SSH through Identity-Aware Proxy (optional) |
| Database ([components/database.ts](components/database.ts)) | Cloud SQL for PostgreSQL 18 on a private IP only: edition, tier and availability from the preset, SSD storage with auto-resize and a ceiling, automated backups, point-in-time recovery, maintenance window, Query Insights, configurable deletion protection. The `postgres` password is generated and stored in Secret Manager |
| VPN ([components/vpn.ts](components/vpn.ts)) | Outline server on a Container-Optimized OS VM, with a static IP, a persistent data disk, a startup script, firewall rules for its two ports, its own service account, and a generated TLS certificate and API prefix in Secret Manager |
| Studio ([services/supabase-studio](services/supabase-studio/index.ts)) | Instance template, regional managed instance group with auto-healing and a rolling update policy, autoscaler, health check, backend service, Cloud Armor policy ([components/cloud-armor.ts](components/cloud-armor.ts)), HTTPS load balancer with HTTP-to-HTTPS redirect ([components/load-balancer.ts](components/load-balancer.ts)), firewall rule for the load balancer, service account and secrets |

Each Studio VM runs three containers on a private Docker network ([scripts/supabase-studio.sh](scripts/supabase-studio.sh)): nginx with basic auth on port 8000, Studio and postgres-meta. Only nginx publishes a port. Self-hosted Studio has no login of its own, and its API runs any SQL as the database user, so it gets two locks: Cloud Armor in front of the load balancer and a password in nginx.

### Layout

```text
index.ts                     wiring: network, database, VPN, Studio, stack outputs
config/                      typed stack config, presets, pinned images
components/                  one Pulumi ComponentResource per concern
services/supabase-studio/    Studio + postgres-meta on the instance group
scripts/                     VM startup scripts (read metadata, Secret Manager)
lib/                         small helpers (htpasswd hash, Outline config)
test/                        unit tests with Pulumi's runtime mocks
```

## What it doesn't deploy

Only Studio and postgres-meta run here. The rest of the Supabase stack is not deployed: Auth (GoTrue), PostgREST (the REST API), Realtime, Storage, Edge Functions, imgproxy, Supavisor, the analytics/logs service and the API gateway. So there is no API for client apps or `supabase-js`. In Studio, the table editor, SQL editor and database pages go through postgres-meta; the Authentication, Storage, Edge Functions, Logs and API docs pages need services that aren't there.

Cloud SQL is the reason the full stack isn't included:

- **No superuser.** Cloud SQL doesn't give customers the SUPERUSER attribute. The `postgres` user has CREATEROLE and CREATEDB and belongs to `cloudsqlsuperuser` ([Cloud SQL users and roles](https://cloud.google.com/sql/docs/postgres/users)).
- **A fixed extension list.** Only [extensions Cloud SQL supports](https://cloud.google.com/sql/docs/postgres/extensions) can be installed. pg_graphql (behind Supabase's GraphQL API), pg_net (behind Database Webhooks) and Supabase Vault are not among them.
- **Roles you create yourself.** Supabase's services expect roles such as `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin` and `supabase_storage_admin`, which Supabase's own Postgres image creates. On Cloud SQL you'd create them without superuser rights and check that each service's migrations still run.

If you need the whole stack, Supabase's [Docker setup](https://supabase.com/docs/guides/self-hosting/docker) with its own Postgres image is the supported route. The [overview post](https://pulore.com/blog/self-hosting-supabase-gcp) covers these limits in its FAQ.

Saved SQL snippets are stored on the disk of the Studio VM that saved them (Studio's `SNIPPETS_MANAGEMENT_FOLDER`). Session affinity keeps each browser on one VM, but snippets don't move between VMs and are lost when the instance group replaces a VM. Keep SQL you care about in your own repository.

Also not included: DNS records (you add one A record), monitoring and alerting, read replicas or multi-region, Studio's AI assistant (needs an OpenAI key and a read-only role), and TLS between postgres-meta and Cloud SQL (see [Security notes](#security-notes)).

## Prerequisites

- A Google Cloud project with billing enabled.
- [Pulumi CLI](https://www.pulumi.com/docs/iac/download-install/) 3.x and Node.js 22 or later.
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth application-default login`.
- Permission to create Compute Engine, Cloud SQL, Secret Manager and service networking resources, service accounts and project IAM bindings. Project Owner covers it.
- These APIs enabled:

  ```bash
  gcloud services enable compute.googleapis.com sqladmin.googleapis.com \
    servicenetworking.googleapis.com secretmanager.googleapis.com \
    iam.googleapis.com cloudresourcemanager.googleapis.com
  ```

- A domain or subdomain for Studio where you can add an A record.
- [Outline Manager](https://getoutline.org/get-started/) (to manage the VPN) and the Outline client for each team member.

## Deploy

```bash
npm ci
pulumi login                      # Pulumi Cloud, or: pulumi login --local
pulumi stack init dev
pulumi config set gcp:project my-gcp-project
pulumi config set gcp:region europe-west2
pulumi config set gcp:zone europe-west2-a
pulumi config set domain studio.example.com
pulumi preview
pulumi up
```

[Pulumi.dev.yaml.example](Pulumi.dev.yaml.example) shows the same settings and the optional ones as a stack file.

The first `pulumi up` takes a while: the service networking connection for Cloud SQL and the Cloud SQL instance each take several minutes to create.

Then:

1. **DNS.** Point an A record for your domain at `pulumi stack output studioIpAddress`. Google issues the managed certificate once the record resolves; Google says this can take up to 60 minutes. Check with `gcloud compute ssl-certificates list`.
2. **VPN.** Run `pulumi stack output outlineManagerConfig --show-secrets`, and paste the JSON into Outline Manager under "Set up Outline anywhere". Create an access key for each person and send it to them; they import it into the Outline client.
3. **Studio.** Connect to the VPN and open `pulumi stack output studioUrl`. Sign in with `pulumi stack output studioUsername` and `pulumi stack output studioPassword --show-secrets`.

Without the VPN, `curl -I https://<your domain>` should return `403`.

**SSH** goes through Identity-Aware Proxy while `enableIapSsh` is on, which it is by default. Project owners can connect. Anyone else needs `roles/iap.tunnelResourceAccessor` and `roles/compute.osAdminLogin` on the project, and `roles/iam.serviceAccountUser` on the VM's service account. The VPN VM is `<prefix>-vpn`, for example `supabase-dev-vpn` for a stack named `dev`; `gcloud compute instances list` shows the Studio VMs and their zones.

```bash
gcloud compute ssh <prefix>-vpn --zone <zone> --tunnel-through-iap

# Then, on the VM:
sudo journalctl -u google-startup-scripts.service   # startup script log
sudo docker ps
```

## Configuration

Set keys with `pulumi config set`, nested ones with `--path`:

```bash
pulumi config set supabase-gcp:preset production-4vcpu
pulumi config set --path supabase-gcp:database.diskSizeGb 500
pulumi config set --path 'supabase-gcp:allowedSourceRanges[0]' 198.51.100.0/24
```

Every field resolves in this order: your stack config, then the preset, then the defaults. Unknown keys are rejected, so a typo fails `pulumi preview` instead of being ignored. The code is in [config/index.ts](config/index.ts).

### Presets

| Preset | Cloud SQL | Studio VMs | Deletion protection and backups |
| --- | --- | --- | --- |
| `small` (default) | Enterprise, `db-custom-1-3840` (1 vCPU, 3.75 GB), one zone | 1 to 2 × `e2-medium` | Off; 7 daily backups |
| `production-4vcpu` | Enterprise Plus, `db-perf-optimized-N-4` (4 vCPUs, 32 GB), with a standby in a second zone | 2 to 4 × `e2-standard-2` | On; 35 daily backups, kept if the instance is deleted |
| `production` | Enterprise Plus, `db-perf-optimized-N-8` (8 vCPUs, 64 GB), with a standby in a second zone | 2 to 4 × `e2-standard-2` | On; 35 daily backups, kept if the instance is deleted |

`small` is for trying the template and for development. `production-4vcpu` is `production` with half the database's vCPUs and memory. Everything else is the same, including the 250 GB disk, because Cloud SQL sets an N2 instance's IOPS and throughput by its storage size. Studio's load depends on how many people use it, not on the database, so both production presets run the same Studio VMs. Every setting is in the tables below and in [config/presets.ts](config/presets.ts).

### Top-level keys

| Key | Default | Description |
| --- | --- | --- |
| `gcp:project` | required | Google Cloud project ID |
| `gcp:region` | required | Region for everything, e.g. `europe-west2` |
| `gcp:zone` | required | Zone for the VPN VM and its disk |
| `domain` | required | Hostname Studio is served on |
| `preset` | `small` | `small`, `production-4vcpu` or `production`, see [Presets](#presets) |
| `namePrefix` | `supabase-<stack>` | Prefix for resource names, 2-20 characters |
| `subnetCidr` | `10.0.1.0/24` | The subnet's range |
| `privateServicesPrefixLength` | `16` | Size of the range reserved for Cloud SQL's private IP |
| `enableIapSsh` | `true` | Allow SSH to the VMs through Identity-Aware Proxy |
| `allowedSourceRanges` | `[]` | Up to 10 IPv4 ranges Cloud Armor allows besides the VPN, e.g. an office |
| `network.privateServicesDeletionPolicy` | preset | `DELETE` or `REMOVE_PEERING`, see [Destroy](#destroy) |
| `images.studio`, `images.pgMeta`, `images.proxy`, `images.outline` | see [Images](#images) | Container images |

### `database`

| Key | small | production-4vcpu | production | Notes |
| --- | --- | --- | --- | --- |
| `edition` | `ENTERPRISE` | `ENTERPRISE_PLUS` | `ENTERPRISE_PLUS` | Data Cache needs Enterprise Plus |
| `tier` | `db-custom-1-3840` | `db-perf-optimized-N-4` | `db-perf-optimized-N-8` | Enterprise Plus: `db-perf-optimized-N-<vCPUs>`. Enterprise: `db-custom-<vCPUs>-<MB>`. The N4, C4 and C4A series need Hyperdisk storage, which this template doesn't set up |
| `availabilityType` | `ZONAL` | `REGIONAL` | `REGIONAL` | `REGIONAL` keeps a standby in a second zone |
| `diskSizeGb` | `20` | `250` | `250` | SSD; Cloud SQL can grow it but never shrink it |
| `diskAutoresizeLimitGb` | `100` | `1000` | `1000` | Ceiling for automatic growth, `0` for none |
| `dataCacheEnabled` | `false` | `true` | `true` | |
| `deletionProtection` | `false` | `true` | `true` | In Pulumi and in the Cloud SQL API |
| `retainBackupsOnDelete` | `false` | `true` | `true` | Keep automated backups after deleting the instance |
| `retainedBackups` | `7` | `35` | `35` | Daily backups kept |
| `transactionLogRetentionDays` | `7` | `7` | `7` | Point-in-time recovery window: 1-7 days on Enterprise, 1-35 on Enterprise Plus |
| `maxConnections` | `100` | `200` | `200` | `max_connections` flag |
| `databaseVersion` | `POSTGRES_18` | `POSTGRES_18` | `POSTGRES_18` | |
| `databaseName` | `postgres` | `postgres` | `postgres` | Created if it isn't `postgres` |
| `backupStartTime` | `03:00` | `03:00` | `03:00` | UTC |
| `backupLocation` | unset | unset | unset | Unset: Cloud SQL's default multi-region. Set a region to keep backups in it |
| `maintenanceDay`, `maintenanceHour` | `7`, `4` | `7`, `4` | `7`, `4` | Sunday 04:00 UTC |

### `studio`

| Key | small | production-4vcpu | production | Notes |
| --- | --- | --- | --- | --- |
| `machineType` | `e2-medium` | `e2-standard-2` | `e2-standard-2` | |
| `bootDiskType` | `pd-balanced` | `pd-balanced` | `pd-balanced` | `hyperdisk-balanced` needs a machine series that supports it, such as C4 or C4D |
| `bootDiskSizeGb` | `20` | `50` | `50` | |
| `minReplicas`, `maxReplicas` | `1`, `2` | `2`, `4` | `2`, `4` | Autoscaler bounds |
| `cpuTarget` | `0.7` | `0.7` | `0.7` | Average CPU the autoscaler aims for |
| `zones` | unset | unset | unset | Unset: Google Cloud picks zones in the region |
| `username` | `supabase` | `supabase` | `supabase` | Basic-auth user; the password is generated |
| `organizationName`, `projectName` | `Default Organization`, `Default Project` | same | same | Shown in Studio |

### `vpn`

| Key | Default | Notes |
| --- | --- | --- |
| `machineType` | `e2-small` | |
| `bootDiskSizeGb`, `dataDiskSizeGb` | `10`, `10` | |
| `zone` | `gcp:zone` | |
| `accessKeyPort` | `443` | Port clients connect to, TCP and UDP, open to everyone |
| `apiPort` | `8443` | Outline's management API, used by Outline Manager |
| `managementSourceRanges` | `["0.0.0.0/0"]` | Who can reach the management API port |
| `hostname` | the static IP | Put into access keys and the API URL. If you use a DNS name, point it at `vpnIpAddress` |

The firewall opens only `accessKeyPort`, and new access keys use it. If you change the port for new keys in Outline Manager, set `vpn.accessKeyPort` to match and run `pulumi up`.

## Images

| Image | Tag | Source |
| --- | --- | --- |
| `supabase/studio` | `2026.10.12-sha-3699278` | Supabase self-hosted release 0.8.3 |
| `supabase/postgres-meta` | `v0.100.0` | Supabase self-hosted release 0.8.3 |
| `nginx` | `1.30.6-alpine` | Official image, stable branch |
| `quay.io/outline/shadowbox` | `v1.12.3` | What Outline's `stable` tag pointed to on 2026-11-02 |

The Supabase tags come from `docker/docker-compose.yml` at the git tag [`self-hosted/v0.8.3`](https://github.com/supabase/supabase/blob/self-hosted/v0.8.3/docker/docker-compose.yml) (2026-10-16). Take Studio and postgres-meta from the same self-hosted release, so Studio runs with the postgres-meta version it shipped with; the [self-hosted changelog](https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md) lists them. Tags are pinned, not digests.

## Updating

- **Studio, postgres-meta or nginx:** change `images.*` and run `pulumi up`. Pulumi creates a new instance template and the instance group replaces the VMs, starting the new ones before removing the old.
- **Instance group zones:** choose `studio.zones` before the first deploy. Changing them later makes Google Cloud recreate the instance group, and the replacement fails on the group's fixed name.
- **Outline:** change `images.outline` and run `pulumi up`. The VPN VM's metadata changes but the VM doesn't restart; reset it to apply (`gcloud compute instances reset <prefix>-vpn --zone <zone>`). Access keys survive, they're on the data disk.
- **Rotating a generated secret:** find its URN with `pulumi stack --show-urns` and run `pulumi up --replace <urn>` (for example the `studio-password` RandomPassword). The new value gets a new Secret Manager version and the Studio VMs are replaced to read it.
- **Container-Optimized OS** updates itself and applies updates on reboot.

## Destroy

```bash
# production presets: turn deletion protection off first
pulumi config set --path supabase-gcp:database.deletionProtection false
pulumi up

pulumi destroy
pulumi stack rm dev
```

- This deletes the Cloud SQL instance. Its automated backups go with it, unless `database.retainBackupsOnDelete` is on (it is in both production presets), in which case they stay until you delete them.
- It deletes the VPN's data disk, and with it every Outline access key.
- Cloud SQL can hold on to the VPC peering for some time after the instance is deleted, which blocks deleting the network. The `small` preset sets `network.privateServicesDeletionPolicy` to `REMOVE_PEERING`, which removes the peering in that case so the destroy finishes. With the production presets (`DELETE`), wait and retry, or set it to `REMOVE_PEERING` before destroying.

## Costs

[How Much Does Supabase Cost?](https://pulore.com/blog/supabase-cost) compares self-hosting with Supabase Cloud. For this template, the drivers are:

- **Cloud SQL**, usually the largest line: edition and tier, `REGIONAL` (which keeps and bills a standby in a second zone), SSD storage, and backup and transaction-log storage. The production presets run a regional Enterprise Plus instance with 4 vCPUs and 32 GB (`production-4vcpu`) or 8 vCPUs and 64 GB (`production`). For a smaller one, override `database.tier`; the smallest Enterprise Plus tier is `db-perf-optimized-N-2` (2 vCPUs, 16 GB).
- **Studio VMs**: machine type times instance count, plus boot disks.
- **VPN**: one small VM, its disks and a static external IPv4 address.
- **Load balancer**: two forwarding rules (443 and 80) and data processed.
- **Cloud Armor**: one policy, its rules and the requests it evaluates.
- **Cloud NAT**: the gateway and the data it processes (mostly image pulls).
- **Secret Manager**: seven secrets, read at each VM boot.
- **Cloud Logging**: the load balancer logs every request (`sampleRate: 1`); lower it in `services/supabase-studio` if that gets large.

Use the [Google Cloud pricing calculator](https://cloud.google.com/products/calculator) with your region and sizes.

## Security notes

- **Studio has no login of its own** when self-hosted, and its API runs any SQL as `postgres`. Here it sits behind Cloud Armor (VPN IP only) and nginx basic auth. Anyone with VPN access and the Studio password can do whatever `postgres` can.
- **postgres-meta has no authentication.** It is only reachable on each VM's private Docker network.
- **`postgres` on Cloud SQL is not a superuser**, but it can create roles and databases. Give applications their own, narrower roles.
- **Secrets** (database password, Studio password and its hash, postgres-meta's crypto key, Outline's TLS key and API prefix) are generated by Pulumi and kept encrypted in the Pulumi state and in Secret Manager. VMs read them at boot through their own service accounts, each allowed to read only its own secrets, by version name. The values are never in instance metadata, but they are in the containers' configuration on the VMs, readable by root. Protect your Pulumi state backend and passphrase.
- **No TLS between postgres-meta and Cloud SQL.** The traffic stays on the VPC's private network, but it isn't encrypted with TLS: Cloud SQL's `sslMode` is set to `ALLOW_UNENCRYPTED_AND_ENCRYPTED` (the API's default), because the connection string Studio hands to postgres-meta carries no SSL settings. Requiring TLS means changing `sslMode` and giving postgres-meta the server CA (`PG_META_DB_SSL_ROOT_CERT`); v0.1 doesn't do that, and it hasn't been tested.
- **Firewall:** the Studio VMs accept traffic only from Google's load balancer and health-check ranges, on port 8000. The VPN VM accepts its access-key port from anywhere and its management port from `vpn.managementSourceRanges`. Postgres is never exposed. SSH works only through IAP, with OS Login and project-wide SSH keys blocked; set `enableIapSsh: false` to remove it.
- **Health checks:** Google's probes connect straight to the instances, so they're allowed by the VPC firewall rule, not by Cloud Armor. `/healthz` answers without credentials, with Studio's static profile JSON (nothing from the database). From outside Google it is only reachable through the load balancer, so through Cloud Armor.
- **Outline's management API** is protected by its secret URL prefix and a pinned self-signed certificate. If your admins have fixed IPs, restrict `vpn.managementSourceRanges`.
- **Data location:** secrets use automatic replication and Cloud SQL backups default to a multi-region. For data residency, set `database.backupLocation` and switch [components/secret.ts](components/secret.ts) to user-managed replication.
- The VMs run Container-Optimized OS as Shielded VMs with Secure Boot. Container images are pinned by tag.

This template is not a compliance certification. The overview post's FAQ covers [what self-hosting means for HIPAA](https://pulore.com/blog/self-hosting-supabase-gcp).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Where this differs from the blog posts

- **Secrets in Google Secret Manager**, not Infisical, so there is no third-party dependency. To use [Infisical](https://infisical.com/) as the posts do, fetch the values with Infisical's SDK ([the Pulumi post](https://pulore.com/blog/infrastructure-as-code-pulumi-gcp) shows how) and pass them to the components instead of generating them.
- **Pinned image tags** instead of `latest`, and no Watchtower on the VPN.
- **Basic auth (nginx)** in front of Studio, as a second lock behind Cloud Armor.
- **No Cloud Armor rule for health-check ranges**; health checks need the VPC firewall rule instead (above).
- **Narrower VPN firewall:** one access-key port instead of 1024-65535, and SSH through IAP instead of from anywhere.
- **Outline's TLS certificate and API prefix are generated by Pulumi**, so the Outline Manager config is a stack output.
- **Secure Boot on** for both VMs.
- **Defaults that work in every region:** E2 machines and `pd-balanced` disks instead of `c4d-standard-2` and `hyperdisk-balanced`, and zones picked by Google Cloud unless you set them.
- **Current Supabase settings:** Studio connects as `postgres` (`POSTGRES_USER_READ_WRITE`), with a shared postgres-meta crypto key, as in Supabase's current Docker setup.

## Tests

```bash
npm run build   # tsc --noEmit
npm test        # node:test with Pulumi's runtime mocks
```

The tests run the whole program with `pulumi.runtime.setMocks` and check, among other things: Cloud SQL has no public IP and uses the stack's VPC; backups and point-in-time recovery are on; the Cloud Armor default rule denies and only the VPN's IP is allowed; no firewall rule opens Postgres, Studio or postgres-meta to the internet; the instance group auto-heals with the health check and takes its size bounds from the preset; secrets never appear in instance metadata; and every metadata key the startup scripts read is set. Nothing is created in Google Cloud.

CI runs both on every push and pull request. The startup scripts pass [ShellCheck](https://www.shellcheck.net/):

```bash
cat scripts/common.sh scripts/supabase-studio.sh | shellcheck -s bash -
cat scripts/common.sh scripts/outline-vpn.sh | shellcheck -s bash -
```

## The blog series

1. [Why We Self-Host Supabase on GCP (And How We Did It)](https://pulore.com/blog/self-hosting-supabase-gcp)
2. [Building Reusable GCP Infrastructure with Pulumi & TypeScript](https://pulore.com/blog/infrastructure-as-code-pulumi-gcp)
3. [Cloud SQL PostgreSQL 18 Enterprise Plus: A Complete Setup Guide](https://pulore.com/blog/cloud-sql-postgresql-enterprise-plus)
4. [Securing Internal Services with VPN & Cloud Armor on GCP](https://pulore.com/blog/securing-gcp-vpn-cloud-armor)
5. [Auto-Scaling Supabase Studio on GCP with Managed Instance Groups](https://pulore.com/blog/autoscaling-supabase-studio-gcp)

## Who maintains this

[Pulore](https://pulore.com), a software studio in Dubai, built this template and maintains it. We also set up self-hosted Supabase on Google Cloud for teams, as a fixed-price, two-week project from $8,000 ([pulore.com/services/supabase](https://pulore.com/services/supabase)). Moving a project with live users gets its own fixed quote.

Three posts explain the design: [the overview](https://pulore.com/blog/self-hosting-supabase-gcp), [Studio on a managed instance group](https://pulore.com/blog/autoscaling-supabase-studio-gcp), and [the VPN and Cloud Armor](https://pulore.com/blog/securing-gcp-vpn-cloud-armor).

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Pulore Software Consultancy FZCO; see [NOTICE](NOTICE).
