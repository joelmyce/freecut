/**
 * Kinetic title — the first HyperFrames rich-graphics template.
 *
 * Produces a self-contained HTML composition: a full-frame title card whose
 * words stagger in (rise + blur clear), an accent underline wipes open, an
 * optional subtitle fades up, then the whole card fades out near the end. Driven
 * by a PAUSED GSAP timeline on `window.__timelines["main"]` that HyperFrames
 * seeks deterministically per frame. Core GSAP only (no premium plugins); GSAP
 * is auto-inlined by HyperFrames at compile, so the render needs no network.
 *
 * This is the rich/baked complement to the native `add_motion_graphic` title —
 * effects (blur clear, gradient accent, staggered kinetics) that FreeCut's
 * primitives can't express. Output is opaque MP4 (a title card); transparent
 * overlays (WebM/MOV alpha) are a follow-up.
 */

export interface KineticTitleContent {
  title: string
  subtitle?: string
  /** Accent color for the underline + gradient sheen. Default indigo. */
  accentColor?: string
  /** Background color of the card. Default near-black navy. */
  backgroundColor?: string
  /** Title text color. Default white. */
  titleColor?: string
  /** Subtitle text color. Default slate-300. */
  subtitleColor?: string
  /**
   * Google Fonts family name (e.g. "Montserrat", "Poppins", "Playfair Display").
   * Loaded from Google Fonts at render and inlined by HyperFrames; falls back to
   * a system sans stack when unset or unavailable.
   */
  fontFamily?: string
}

export interface KineticTitleOptions {
  durationSec: number
  width?: number
  height?: number
}

const DEFAULT_ACCENT = '#6366F1' // indigo-500
const DEFAULT_BG = '#0B1020'
const DEFAULT_TITLE_COLOR = '#FFFFFF'
const DEFAULT_SUBTITLE_COLOR = '#CBD5E1' // slate-300
const FALLBACK_FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif'

/** Strip characters that could break out of a CSS value (colors are user input). */
function sanitizeCssValue(value: string): string {
  return value.replace(/[;{}<>"'\n\r]/g, '').trim()
}

/** Reduce a Google Fonts family name to a safe URL/CSS token (letters/digits/space). */
function sanitizeFontFamily(value: string): string {
  return value
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Build the full composition HTML for a kinetic title. */
export function buildKineticTitleHtml(
  content: KineticTitleContent,
  options: KineticTitleOptions,
): string {
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const durationSec = Math.max(1.5, options.durationSec)
  const accent = sanitizeCssValue(content.accentColor?.trim() || DEFAULT_ACCENT)
  const background = sanitizeCssValue(content.backgroundColor?.trim() || DEFAULT_BG)
  const titleColor = sanitizeCssValue(content.titleColor?.trim() || DEFAULT_TITLE_COLOR)
  const subtitleColor = sanitizeCssValue(content.subtitleColor?.trim() || DEFAULT_SUBTITLE_COLOR)

  // Optional brand font, loaded from Google Fonts (HyperFrames inlines it).
  const fontName = content.fontFamily ? sanitizeFontFamily(content.fontFamily) : ''
  const fontStack = fontName ? `"${fontName}", ${FALLBACK_FONT_STACK}` : FALLBACK_FONT_STACK
  const fontLink = fontName
    ? `<link rel="preconnect" href="https://fonts.googleapis.com" />` +
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />` +
      `<link href="https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@400;500;700;800&display=swap" rel="stylesheet" />`
    : ''

  const title = content.title?.trim() || 'Title'
  const subtitle = content.subtitle?.trim()

  const titleSize = Math.round(height * 0.11)
  const subtitleSize = Math.round(height * 0.032)
  const accentWidth = Math.round(width * 0.12)

  const words = title
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span class="word">${escapeHtml(word)}</span>`)
    .join(' ')

  const subtitleHtml = subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''

  // Out-animation start, anchored to the clip end so it adapts to any duration.
  const outAt = Math.max(0.6, durationSec - 0.5).toFixed(2)
  const subtitleTween = subtitle
    ? `tl.from(".subtitle", { opacity: 0, y: 24, duration: 0.6, ease: "power2.out" }, 0.55);`
    : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    ${fontLink}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
      #stage {
        position: absolute; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: ${Math.round(height * 0.03)}px;
        background: radial-gradient(circle at 50% 38%, ${background} 0%, #05070d 100%);
        font-family: ${fontStack};
        text-align: center;
      }
      #title {
        max-width: ${Math.round(width * 0.84)}px;
        font-size: ${titleSize}px; font-weight: 800; line-height: 1.05;
        letter-spacing: -2px; color: ${titleColor};
      }
      .word { display: inline-block; will-change: transform, filter, opacity; }
      .accent {
        width: ${accentWidth}px; height: ${Math.max(3, Math.round(height * 0.006))}px;
        border-radius: 999px;
        background: linear-gradient(90deg, ${accent}, #ffffff);
        will-change: transform;
      }
      .subtitle {
        font-size: ${subtitleSize}px; font-weight: 500; color: ${subtitleColor};
        letter-spacing: 0.5px; max-width: ${Math.round(width * 0.6)}px;
      }
    </style>
  </head>
  <body>
    <div
      id="stage"
      data-composition-id="main"
      data-start="0"
      data-duration="${durationSec}"
      data-width="${width}"
      data-height="${height}"
    >
      <div id="title">${words}</div>
      <div class="accent"></div>
      ${subtitleHtml}
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from(".word", {
        y: ${Math.round(height * 0.06)},
        opacity: 0,
        filter: "blur(14px)",
        duration: 0.7,
        stagger: 0.08,
        ease: "power3.out",
      }, 0.1);
      tl.from(".accent", { scaleX: 0, transformOrigin: "left center", duration: 0.6, ease: "power3.out" }, 0.45);
      ${subtitleTween}
      tl.to("#stage", { opacity: 0, duration: 0.45, ease: "power2.in" }, ${outAt});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`
}
