// Zalo tests cover unsupported inbound routing and the authorized no-text notice.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageLifecycleCore,
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
} from "./test-support/lifecycle-test-support.js";
import {
  getZaloRuntimeMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

const UNSUPPORTED_MESSAGE_NOTICE =
  "This message type isn't supported yet. Please resend it as text.";

function createUnsupportedUpdate(params: {
  messageId: string;
  userId: string;
  userName: string;
  chatId: string;
  text?: string;
  chatType?: "PRIVATE" | "GROUP";
}) {
  const update = createTextUpdate(params);
  return {
    event_name: "message.unsupported.received",
    message: {
      ...update.message,
      chat: { ...update.message.chat, chat_type: params.chatType ?? "PRIVATE" },
      text: params.text,
    },
  };
}

function sentMessageTexts(): string[] {
  return sendMessageMock.mock.calls.map((call) => {
    const payload = call[1] as { text?: string } | undefined;
    return payload?.text ?? "";
  });
}

async function postUpdate(
  monitor: Awaited<ReturnType<typeof startWebhookLifecycleMonitor>>,
  payload: Record<string, unknown>,
  replay = false,
): Promise<void> {
  await withServer(
    (req, res) => {
      void monitor.route.handler(req, res);
    },
    async (baseUrl) => {
      if (replay) {
        const { first, replay: duplicate } = await postWebhookReplay({
          baseUrl,
          path: "/hooks/zalo",
          secret: "supersecret",
          payload,
        });
        expect([first.status, duplicate.status]).toEqual([200, 200]);
      } else {
        const response = await fetch(`${baseUrl}/hooks/zalo`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bot-api-secret-token": "supersecret",
          },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
      }
      await monitor.waitForIdle();
    },
  );
}

describe("Zalo unsupported inbound events", () => {
  const { core, recordInboundSessionMock } = createImageLifecycleCore();

  // The monitor receives the merged runtime created by setLifecycleRuntimeCore,
  // so dispatch assertions must read that instance rather than the seed core.
  const liveDispatch = () =>
    vi.mocked((getZaloRuntimeMock() as typeof core).channel.inbound.dispatch);

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-unsupported-received");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore(core.channel, core.state);
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  it("routes unsupported events carrying text through the text pipeline once", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open" }),
      cacheKey: "zalo-unsupported-received",
    });
    const text = "https://example.com/articles/zalo-link-preview";

    try {
      await postUpdate(
        monitor,
        createUnsupportedUpdate({
          messageId: `zalo-unsupported-text-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
          text,
        }),
        true,
      );

      const dispatch = liveDispatch();
      expect(dispatch).toHaveBeenCalledTimes(1);
      const ctxPayload = dispatch.mock.calls[0]?.[0].ctxPayload;
      expect(ctxPayload).toEqual(
        expect.objectContaining({
          BodyForAgent: text,
          RawBody: text,
          CommandBody: text,
        }),
      );
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });

  it("sends one resend-guidance notice to an authorized DM without recoverable text", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open" }),
      cacheKey: "zalo-unsupported-received",
    });

    try {
      await postUpdate(
        monitor,
        createUnsupportedUpdate({
          messageId: `zalo-unsupported-notice-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
        }),
        true,
      );

      expect(liveDispatch()).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [token, payload] = sendMessageMock.mock.calls[0] as [
        string,
        { chat_id?: string; text?: string },
      ];
      expect(token).toBe("zalo-token");
      expect(payload.chat_id).toBe("dm-chat-1");
      expect(payload.text).toBe(UNSUPPORTED_MESSAGE_NOTICE);
    } finally {
      await monitor.stop();
    }
  });

  it("does not send the notice or dispatch for an unauthorized DM sender", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({
        accountId: "default",
        dmPolicy: "pairing",
        allowFrom: ["allowed-user"],
      }),
      cacheKey: "zalo-unsupported-received",
    });

    try {
      await postUpdate(
        monitor,
        createUnsupportedUpdate({
          messageId: `zalo-unsupported-unauthorized-${Date.now()}`,
          userId: "user-unauthorized",
          userName: "Unauthorized User",
          chatId: "dm-unauthorized-1",
        }),
      );

      expect(liveDispatch()).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      // Authorization still wins: any outbound send is the pairing challenge, never the notice.
      expect(sentMessageTexts().some((text) => text.includes("resend it as text"))).toBe(false);
    } finally {
      await monitor.stop();
    }
  });

  it("keeps unsupported no-text events quiet in group chats", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open" }),
      cacheKey: "zalo-unsupported-received",
    });

    try {
      await postUpdate(
        monitor,
        createUnsupportedUpdate({
          messageId: `zalo-unsupported-group-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "group-chat-1",
          chatType: "GROUP",
        }),
      );

      expect(liveDispatch()).not.toHaveBeenCalled();
      expect(recordInboundSessionMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });

  it("keeps the no-text notice best-effort when the send fails", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("zalo send failed"));
    const monitor = await startWebhookLifecycleMonitor({
      ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open" }),
      cacheKey: "zalo-unsupported-received",
    });

    try {
      await postUpdate(
        monitor,
        createUnsupportedUpdate({
          messageId: `zalo-unsupported-send-failure-${Date.now()}`,
          userId: "user-1",
          userName: "User One",
          chatId: "dm-chat-1",
        }),
      );

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(liveDispatch()).not.toHaveBeenCalled();
      expect(monitor.runtime.error).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
