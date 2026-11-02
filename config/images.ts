/**
 * Container images the VMs run. Override any of them with the `images` stack
 * config key.
 *
 * The two Supabase tags are the ones in Supabase's self-hosted release 0.8.3
 * (git tag `self-hosted/v0.8.3`, 2026-10-16), from docker/docker-compose.yml:
 * https://github.com/supabase/supabase/blob/self-hosted/v0.8.3/docker/docker-compose.yml
 * When you update them, take both from the same release, so Studio runs with
 * the postgres-meta version it shipped with.
 */
export interface ImageSettings {
  /** Supabase Studio, the dashboard. */
  studio: string;
  /** postgres-meta, the API Studio uses to read and change the database. */
  pgMeta: string;
  /** nginx, which puts basic auth in front of Studio on each VM. */
  proxy: string;
  /** The Outline server ("shadowbox"). */
  outline: string;
}

export const DEFAULT_IMAGES: Readonly<ImageSettings> = {
  studio: "supabase/studio:2026.10.12-sha-3699278",
  pgMeta: "supabase/postgres-meta:v0.100.0",
  // Official image, stable branch.
  proxy: "nginx:1.30.6-alpine",
  // The tag `stable` pointed to on 2026-11-02. Pinned so that a VM restart
  // never changes the version; Outline's own installer tracks `stable` with
  // Watchtower instead.
  outline: "quay.io/outline/shadowbox:v1.12.3",
};
