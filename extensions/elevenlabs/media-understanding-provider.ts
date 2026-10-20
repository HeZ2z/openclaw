import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

const ELEVENLABS_STT_QUERY_FIELDS = ["no_verbatim", "tag_audio_events", "diarize"] as const;

type ElevenLabsSttQueryField = (typeof ELEVENLABS_STT_QUERY_FIELDS)[number];

/** Forwards the allowlisted synchronous transcription options, ignoring other response-changing fields. */
function resolveElevenLabsSttQueryFields(
  query: AudioTranscriptionRequest["query"],
): Partial<Record<ElevenLabsSttQueryField, string | number | boolean>> {
  const fields: Partial<Record<ElevenLabsSttQueryField, string | number | boolean>> = {};
  for (const key of ELEVENLABS_STT_QUERY_FIELDS) {
    const value = query?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  return fields;
}

async function transcribeElevenLabsAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }

  const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
      defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
      headers: req.headers,
      request: req.request,
      defaultHeaders: {
        "xi-api-key": apiKey,
      },
      provider: "elevenlabs",
      api: "elevenlabs-speech-to-text",
      capability: "audio",
      transport: "media-understanding",
    });
  const form = buildAudioTranscriptionFormData({
    buffer: req.buffer,
    fileName: req.fileName,
    mime: req.mime,
    fields: {
      ...resolveElevenLabsSttQueryFields(req.query),
      model_id: model,
      language_code: req.language,
      prompt: req.prompt,
    },
  });
  const { response, release } = await postTranscriptionRequest({
    url: `${baseUrl}/v1/speech-to-text`,
    headers,
    body: form,
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "elevenlabs speech-to-text",
  });

  try {
    await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
    const payload = await readProviderJsonObjectResponse(
      response,
      "ElevenLabs audio transcription failed",
    );
    const text = requireTranscriptionText(
      payload.text,
      "ElevenLabs audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}

export const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "elevenlabs",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
  autoPriority: { audio: 45 },
  transcribeAudio: transcribeElevenLabsAudio,
};
