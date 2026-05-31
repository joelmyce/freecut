import { describe, expect, it } from 'vitest'
import { buildKineticTitleHtml } from './templates/kinetic-title.ts'

describe('buildKineticTitleHtml', () => {
  it('wraps each title word in an animatable span and wires a paused GSAP timeline', () => {
    const html = buildKineticTitleHtml({ title: 'Welcome to FreeCut' }, { durationSec: 4 })
    // one .word span per word
    expect(html.match(/class="word"/g) ?? []).toHaveLength(3)
    expect(html).toContain('>Welcome</span>')
    expect(html).toContain('>FreeCut</span>')
    // composition wiring
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('data-duration="4"')
    expect(html).toContain('window.__timelines["main"] = tl')
    expect(html).toContain('gsap.timeline({ paused: true })')
    expect(html).toContain('.word')
  })

  it('omits the subtitle node + tween when no subtitle is given', () => {
    const html = buildKineticTitleHtml({ title: 'Solo' }, { durationSec: 3 })
    expect(html).not.toContain('class="subtitle"')
    expect(html).not.toContain('.subtitle"')
  })

  it('includes the subtitle node + tween when given', () => {
    const html = buildKineticTitleHtml(
      { title: 'Hi', subtitle: 'a quick tour' },
      { durationSec: 3 },
    )
    expect(html).toContain('class="subtitle"')
    expect(html).toContain('a quick tour')
    expect(html).toContain('gsap')
    expect(html).toContain('.subtitle"') // the subtitle tween targets it
  })

  it('applies a custom accent color', () => {
    const html = buildKineticTitleHtml({ title: 'X', accentColor: '#22D3EE' }, { durationSec: 3 })
    expect(html).toContain('#22D3EE')
  })

  it('escapes HTML in user content so titles cannot break the markup', () => {
    const html = buildKineticTitleHtml(
      { title: 'A & B <script>', subtitle: '"quoted" & <b>' },
      { durationSec: 3 },
    )
    expect(html).toContain('&amp;')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;quoted&quot;')
    // no raw injected script tag from user content
    expect(html).not.toContain('<script>A')
  })

  it('clamps very short durations up to a floor so the animation has room', () => {
    const html = buildKineticTitleHtml({ title: 'X' }, { durationSec: 0.2 })
    expect(html).toContain('data-duration="1.5"')
  })

  it('defaults the canvas to 1920x1080', () => {
    const html = buildKineticTitleHtml({ title: 'X' }, { durationSec: 3 })
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
})
