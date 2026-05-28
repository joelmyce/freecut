/**
 * Adapter for editor-feature services consumed by agent handlers.
 *
 * Right now this is just the Kokoro TTS runtime; if more editor-side
 * services need to be reached (Supertonic / MOSS / a future engine), add
 * them here so the agent never reaches across feature boundaries
 * directly. The boundary check (`check:boundaries`) enforces this.
 */
export {
  KOKORO_TTS_BEST_MODEL,
  KOKORO_TTS_VOICE_OPTIONS,
  kokoroTtsService,
  type KokoroTtsModel,
  type KokoroTtsVoice,
} from '@/features/editor/services/kokoro-tts-service'
