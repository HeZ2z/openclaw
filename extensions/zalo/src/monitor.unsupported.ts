import { sendMessage, type ZaloFetch } from "./api.js";
import type { ZaloStatusSink } from "./monitor.types.js";

const ZALO_UNSUPPORTED_MESSAGE_NOTICE =
  "This message type isn't supported yet. Please resend it as text.";

type UnsupportedMessageAuthorization = {
  isGroup: boolean;
  chatId: string;
  senderId: string;
};

export async function sendUnsupportedMessageNotice(params: {
  authorization: UnsupportedMessageAuthorization;
  accountId: string;
  token: string;
  fetcher?: ZaloFetch;
  statusSink?: ZaloStatusSink;
  logVerbose: (message: string) => void;
}): Promise<void> {
  const { authorization, accountId, token, fetcher, statusSink, logVerbose } = params;
  if (authorization.isGroup) {
    // The reported drop is a DM case; a notice in every group would add noise,
    // so groups keep the verbose log only.
    logVerbose(`[${accountId}] Not sending unsupported notice to group ${authorization.chatId}`);
    return;
  }
  try {
    await sendMessage(
      token,
      {
        chat_id: authorization.chatId,
        text: ZALO_UNSUPPORTED_MESSAGE_NOTICE,
      },
      fetcher,
    );
    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (error) {
    logVerbose(
      `[${accountId}] Unsupported notice failed for ${authorization.senderId}: ${String(error)}`,
    );
  }
}
