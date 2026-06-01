import { describe, expect, it } from 'vitest'
import {
  BRAND_IDS,
  getBrandProfile,
  resolveBrandKnobs,
  resolveBrandKnobsOrThrow,
  resolveBrandMode,
} from './index.ts'

describe('brand registry', () => {
  it('registers the abdias profile and exposes its id', () => {
    expect(BRAND_IDS).toContain('abdias')
    expect(getBrandProfile('abdias')?.name).toBe('Abdias.Marketing')
  })

  it('matches by id and alias, case-insensitively and trimmed', () => {
    expect(getBrandProfile('Abdias')?.id).toBe('abdias')
    expect(getBrandProfile('  abdias marketing ')?.id).toBe('abdias')
    expect(getBrandProfile('My Brand')?.id).toBe('abdias')
    expect(getBrandProfile('on-brand')?.id).toBe('abdias')
  })

  it('returns undefined for unknown / empty input', () => {
    expect(getBrandProfile('nope')).toBeUndefined()
    expect(getBrandProfile(undefined)).toBeUndefined()
    expect(getBrandProfile('')).toBeUndefined()
  })

  it('defaults to the profile mode (light) and honors an override', () => {
    const profile = getBrandProfile('abdias')!
    expect(profile.defaultMode).toBe('light')
    expect(resolveBrandMode(profile, undefined)).toBe('light')
    expect(resolveBrandMode(profile, 'dark')).toBe('dark')
  })
})

describe('resolveBrandKnobs', () => {
  it('resolves the light "Paper" tokens by default', () => {
    const knobs = resolveBrandKnobs('abdias')!
    expect(knobs.mode).toBe('light')
    expect(knobs.backgroundColor).toBe('#F5F0E8') // Paper
    expect(knobs.surfaceColor).toBe('#FAF7F2') // Paper Soft
    expect(knobs.titleColor).toBe('#0B1220') // Ink
    expect(knobs.secondaryColor).toBe('#3D4A63') // Slate
    expect(knobs.accentColor).toBe('#2B5CE6') // Signal Blue (structural)
    expect(knobs.emphasisColor).toBe('#B8553A') // Terracotta (emphasis)
    expect(knobs.fontFamily).toBe('Fraunces')
    expect(knobs.bodyFontFamily).toBe('Inter')
    expect(knobs.monoFontFamily).toBe('JetBrains Mono')
  })

  it('resolves the dark "Ink" tokens with lifted accents', () => {
    const knobs = resolveBrandKnobs('abdias', 'dark')!
    expect(knobs.mode).toBe('dark')
    expect(knobs.backgroundColor).toBe('#0B1220') // Ink
    expect(knobs.surfaceColor).toBe('#1A2540') // Midnight
    expect(knobs.titleColor).toBe('#F5F0E8') // Paper
    expect(knobs.accentColor).toBe('#7FA1F0') // lighter Signal Blue
    expect(knobs.emphasisColor).toBe('#D87B5A') // Clay
  })

  it('returns undefined for an unknown brand', () => {
    expect(resolveBrandKnobs('nope')).toBeUndefined()
  })
})

describe('resolveBrandKnobsOrThrow', () => {
  it('returns undefined when no brand was requested', () => {
    expect(resolveBrandKnobsOrThrow(undefined)).toBeUndefined()
    expect(resolveBrandKnobsOrThrow('')).toBeUndefined()
    expect(resolveBrandKnobsOrThrow('   ')).toBeUndefined()
  })

  it('resolves a known brand', () => {
    expect(resolveBrandKnobsOrThrow('abdias')?.brandId).toBe('abdias')
  })

  it('throws a clear error naming the unknown brand and the known set', () => {
    expect(() => resolveBrandKnobsOrThrow('acme')).toThrow(/Unknown brand "acme"/)
    expect(() => resolveBrandKnobsOrThrow('acme')).toThrow(/abdias/)
  })
})
