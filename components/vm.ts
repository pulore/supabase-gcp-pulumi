/** Settings shared by the VPN VM and the Studio VMs. */

/**
 * Container-Optimized OS, stable channel. An image family: each new VM gets
 * the newest image, and running VMs update themselves and apply it on reboot.
 */
export const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";

export const SHIELDED_VM = {
  enableSecureBoot: true,
  enableVtpm: true,
  enableIntegrityMonitoring: true,
};

/**
 * Metadata every VM gets: SSH through OS Login only (no project-wide SSH
 * keys), and Container-Optimized OS's logging and monitoring agents, which
 * send system and container logs to Cloud Logging.
 */
export const BASE_METADATA: Readonly<Record<string, string>> = {
  "enable-oslogin": "TRUE",
  "block-project-ssh-keys": "TRUE",
  "google-logging-enabled": "true",
  "google-monitoring-enabled": "true",
};
