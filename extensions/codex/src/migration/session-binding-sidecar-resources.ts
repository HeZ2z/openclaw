import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { collectLegacyBindingSources } from "./session-binding-sidecars.js";

/** Read-only recovery inventory for the legacy sidecars the binding migration archives. */
export async function collectLegacySessionBindingBackupResources(
  params: Parameters<NonNullable<PluginDoctorStateMigration["collectBackupResources"]>>[0],
) {
  const { sources } = await collectLegacyBindingSources(params);
  return sources.map(({ sidecarPath }) => ({ path: sidecarPath, kind: "file" as const }));
}
