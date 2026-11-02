import * as fs from "fs";
import * as path from "path";

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

export type StartupScriptName = "supabase-studio" | "outline-vpn";

/**
 * Returns a VM startup script: scripts/common.sh followed by
 * scripts/<name>.sh. The scripts hold no stack-specific values; they read
 * settings from instance metadata and secrets from Secret Manager at boot, so
 * the same files can be run and tested outside Pulumi.
 */
export function startupScript(name: StartupScriptName): string {
  const common = fs.readFileSync(path.join(SCRIPTS_DIR, "common.sh"), "utf8");
  const body = fs.readFileSync(path.join(SCRIPTS_DIR, `${name}.sh`), "utf8");
  return `${common.trimEnd()}\n\n${body}`;
}
