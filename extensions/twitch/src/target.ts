import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { normalizeTwitchChannel } from "./utils/twitch.js";

/**
 * Normalizes a Twitch messaging target to the bare channel name used by routing
 * and the chat transport. Accepts internal addresses such as
 * `twitch:channel:<channel>` and their `twitch-chat:` alias. Direct-message
 * targets are unsupported and normalize to an empty string.
 */
export function normalizeTwitchMessagingTarget(target: string): string {
  const providerTarget = stripChannelTargetPrefix(target, "twitch", "twitch-chat");
  const kindMatch = /^(user|dm|channel|group|conversation|room):/i.exec(providerTarget);
  const kind = kindMatch?.[1]?.toLowerCase();
  if (kind === "user" || kind === "dm") {
    return "";
  }
  const channelTarget = kindMatch ? providerTarget.slice(kindMatch[0].length) : providerTarget;
  return normalizeTwitchChannel(channelTarget);
}
