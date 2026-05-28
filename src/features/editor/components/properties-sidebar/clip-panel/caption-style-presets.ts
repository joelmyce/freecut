/**
 * Re-export shim — the preset registry now lives in `@/shared/typography/`
 * so the media-library caption builder (`buildSubtitleSegmentForClip`) can
 * import it without crossing feature boundaries. This file stays so existing
 * editor-side imports keep working.
 */
export {
  CAPTION_STYLE_PRESETS,
  DEFAULT_CAPTION_PRESET_ID,
  detectActiveCaptionPreset,
  getCaptionStylePresetById,
  resolveCaptionStylePatch,
  type CaptionStylePatch,
  type CaptionStylePreset,
} from '@/shared/typography/caption-style-presets'
