import { describe, expect, it } from 'vite-plus/test'
import type { ShapeItem, TextItem } from '@/types/timeline'
import { resolveMotionGraphicItems, type MotionGraphicEnv } from './add-motion-graphic'

const ENV: MotionGraphicEnv = {
  fps: 30,
  canvasWidth: 1920,
  canvasHeight: 1080,
  fromFrame: 60,
  durationInFrames: 150,
}

// Minimal spec mirroring the server MotionGraphicSpec shape. Cast through
// `Parameters` so the literal is checked against the (unexported) param type.
type Spec = Parameters<typeof resolveMotionGraphicItems>[0]

const SPEC: Spec = {
  templateId: 'test',
  defaultDurationSec: 5,
  layers: [
    {
      kind: 'shape',
      name: 'Panel',
      shapeType: 'rectangle',
      fillColor: '#0F172A',
      cornerRadiusFrac: 0.02,
      xFrac: -0.1,
      yFrac: 0.3,
      widthFrac: 0.5,
      heightFrac: 0.15,
      opacity: 0.9,
      animations: [
        {
          property: 'x',
          keyframes: [
            { atSec: 0, value: -0.6, easing: 'ease-out' },
            { atSec: 0.5, value: -0.1 },
          ],
        },
        {
          property: 'opacity',
          keyframes: [
            { atSec: 0, value: 0 },
            { beforeEndSec: 0, value: 0 },
          ],
        },
      ],
    },
    {
      kind: 'text',
      name: 'Name',
      text: 'Hi',
      color: '#ffffff',
      fontWeight: 'bold',
      textAlign: 'left',
      fontSizeFrac: 0.05,
      xFrac: -0.1,
      yFrac: 0.3,
      widthFrac: 0.4,
      heightFrac: 0.08,
    },
  ],
}

describe('resolveMotionGraphicItems', () => {
  it('preserves layer order (back → front)', () => {
    const layers = resolveMotionGraphicItems(SPEC, ENV)
    expect(layers).toHaveLength(2)
    expect(layers[0]!.item.type).toBe('shape')
    expect(layers[1]!.item.type).toBe('text')
  })

  it('resolves shape geometry from center-origin fractions to pixels', () => {
    const [panel] = resolveMotionGraphicItems(SPEC, ENV)
    const item = panel!.item as ShapeItem
    expect(item.type).toBe('shape')
    expect(item.shapeType).toBe('rectangle')
    expect(item.fillColor).toBe('#0F172A')
    expect(item.transform).toMatchObject({
      x: -0.1 * 1920, // -192
      y: 0.3 * 1080, // 324
      width: 0.5 * 1920, // 960
      height: 0.15 * 1080, // 162
      opacity: 0.9,
    })
    // cornerRadius scales by min(width, height) = 1080 → round(0.02 * 1080) = 22
    expect(item.cornerRadius).toBe(22)
    expect(item.from).toBe(60)
    expect(item.durationInFrames).toBe(150)
    expect(panel!.trackName).toBe('Panel')
  })

  it('resolves text font size from a fraction of canvas height', () => {
    const [, name] = resolveMotionGraphicItems(SPEC, ENV)
    const item = name!.item as TextItem
    expect(item.type).toBe('text')
    expect(item.text).toBe('Hi')
    expect(item.fontSize).toBe(Math.round(0.05 * 1080)) // 54
    expect(item.fontWeight).toBe('bold')
    expect(item.textAlign).toBe('left')
    // sensible non-authored defaults
    expect(item.fontFamily).toBe('Inter')
    expect(item.verticalAlign).toBe('middle')
  })

  it('applies an authored (brand) fontFamily to the text item', () => {
    const spec: Spec = {
      templateId: 't',
      defaultDurationSec: 4,
      layers: [
        {
          kind: 'text',
          name: 'Branded',
          text: 'Hola',
          color: '#0B1220',
          fontFamily: 'Fraunces',
          fontSizeFrac: 0.08,
          xFrac: 0,
          yFrac: 0,
          widthFrac: 0.8,
          heightFrac: 0.2,
        },
      ],
    }
    const [layer] = resolveMotionGraphicItems(spec, ENV)
    expect((layer!.item as TextItem).fontFamily).toBe('Fraunces')
  })

  it('scales x keyframes by width and rounds times to frames', () => {
    const [panel] = resolveMotionGraphicItems(SPEC, ENV)
    const xKfs = panel!.keyframes.filter((k) => k.property === 'x')
    expect(xKfs).toEqual([
      expect.objectContaining({ frame: 0, value: -0.6 * 1920, easing: 'ease-out' }),
      expect.objectContaining({ frame: 15, value: -0.1 * 1920, easing: 'linear' }),
    ])
  })

  it('keeps opacity values absolute and anchors beforeEndSec to the clip end', () => {
    const [panel] = resolveMotionGraphicItems(SPEC, ENV)
    const opacityKfs = panel!.keyframes.filter((k) => k.property === 'opacity')
    expect(opacityKfs[0]).toMatchObject({ frame: 0, value: 0 })
    // beforeEndSec: 0 → durationInFrames (150) clamped to last frame (149)
    expect(opacityKfs[1]).toMatchObject({ frame: 149, value: 0 })
  })

  it('stamps every keyframe with its own item id', () => {
    const layers = resolveMotionGraphicItems(SPEC, ENV)
    for (const layer of layers) {
      for (const kf of layer.keyframes) {
        expect(kf.itemId).toBe(layer.item.id)
      }
    }
    // ids are unique per layer
    expect(layers[0]!.item.id).not.toBe(layers[1]!.item.id)
  })

  it('emits no keyframes for a layer without animations', () => {
    const [, name] = resolveMotionGraphicItems(SPEC, ENV)
    expect(name!.keyframes).toEqual([])
  })

  it('scales width by canvas width, height/fontSize by height, and keeps rotation absolute', () => {
    const spec: Spec = {
      templateId: 't',
      defaultDurationSec: 3,
      layers: [
        {
          kind: 'shape',
          name: 'bar',
          shapeType: 'rectangle',
          fillColor: '#ffffff',
          xFrac: 0,
          yFrac: 0,
          widthFrac: 0.1,
          heightFrac: 0.02,
          animations: [
            {
              property: 'width',
              keyframes: [
                { atSec: 0, value: 0 },
                { atSec: 0.4, value: 0.1 },
              ],
            },
            { property: 'height', keyframes: [{ atSec: 0, value: 0.05 }] },
            { property: 'rotation', keyframes: [{ atSec: 0, value: 15 }] },
          ],
        },
      ],
    }
    const [bar] = resolveMotionGraphicItems(spec, ENV)
    const width = bar!.keyframes.filter((k) => k.property === 'width')
    expect(width[1]).toMatchObject({ value: 0.1 * 1920 })
    expect(bar!.keyframes.find((k) => k.property === 'height')).toMatchObject({
      value: 0.05 * 1080,
    })
    expect(bar!.keyframes.find((k) => k.property === 'rotation')).toMatchObject({ value: 15 })
  })
})
