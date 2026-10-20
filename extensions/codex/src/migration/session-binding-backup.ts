import type { PluginDoctorMigrationBackupResource } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  collectLegacyBindingSources,
  type MigrationEnvironment,
} from "./session-binding-sidecars.js";

export async function collectLegacySessionBindingBackupResources(
  params: MigrationEnvironment & { requireLocalResources?: boolean },
): Promise<PluginDoctorMigrationBackupResource[]> {
  const { sources } = await collectLegacyBindingSources(params);
  return sources.map(({ sidecarPath }) => ({ path: sidecarPath, kind: "file" }));
}
