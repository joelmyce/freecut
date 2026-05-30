import { beforeEach, describe, expect, it } from 'vite-plus/test'
import type { ShapeItem, TextItem, TimelineTrack } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useTransitionsStore } from '../transitions-store'
import { useKeyframesStore } from '../keyframes-store'
import { useTimelineCommandStore } from '../timeline-command-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import { insertMotionGraphic, type MotionGraphicLayer } from './motion-graphic-actions'

function panelLayer(): MotionGraphicLayer {
  const id = 'panel-1'
  const item: ShapeItem = {
    id,
    type: 'shape',
    trackId: '',
    from: 0,
    durationInFrames: 150,
    label: 'Panel',
    shapeType: 'rectangle',
    fillColor: '#0F172A',
  }
  return {
    item,
    keyframes: [
      { itemId: id, property: 'opacity', frame: 0, value: 0, easing: 'ease-out' },
      { itemId: id, property: 'opacity', frame: 149, value: 0, easing: 'linear' },
    ],
    trackName: 'Lower third panel',
  }
}

function nameLayer(): MotionGraphicLayer {
  const id = 'name-1'
  const item: TextItem = {
    id,
    type: 'text',
    trackId: '',
    from: 0,
    durationInFrames: 150,
    label: 'Name',
    text: 'Alex Rivera',
    color: '#ffffff',
  }
  return { item, keyframes: [], trackName: 'Lower third name' }
}

function existingTrack(): TimelineTrack {
  return {
    id: 'base-track',
    name: 'Video 1',
    kind: 'video',
    height: 60,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    order: 0,
    items: [],
  }
}

describe('insertMotionGraphic', () => {
  beforeEach(() => {
    useTimelineCommandStore.getState().clearHistory()
    useTimelineSettingsStore.setState({ fps: 30, isDirty: false })
    useItemsStore.getState().setItems([])
    useItemsStore.getState().setTracks([existingTrack()])
    useTransitionsStore.getState().setTransitions([])
    useKeyframesStore.getState().setKeyframes([])
  })

  it('creates one dedicated track per layer, stacked above existing content', () => {
    const result = insertMotionGraphic([panelLayer(), nameLayer()])

    expect(result.itemIds).toEqual(['panel-1', 'name-1'])
    expect(result.trackIds).toHaveLength(2)

    const tracks = useItemsStore.getState().tracks
    // base + 2 new
    expect(tracks).toHaveLength(3)

    const panelTrack = tracks.find((t) => t.id === result.trackIds[0])!
    const nameTrack = tracks.find((t) => t.id === result.trackIds[1])!
    expect(panelTrack.name).toBe('Lower third panel')
    expect(nameTrack.name).toBe('Lower third name')

    // Both above existing content (order < 0), and the name (frontmost) has a
    // LOWER order than the panel (backmost) so it renders in front.
    expect(panelTrack.order).toBeLessThan(0)
    expect(nameTrack.order).toBeLessThan(panelTrack.order)
  })

  it('places each item on its own freshly-created track', () => {
    const result = insertMotionGraphic([panelLayer(), nameLayer()])
    const items = useItemsStore.getState().items
    const panel = items.find((i) => i.id === 'panel-1')!
    const name = items.find((i) => i.id === 'name-1')!
    expect(panel.trackId).toBe(result.trackIds[0])
    expect(name.trackId).toBe(result.trackIds[1])
  })

  it('adds the layer keyframes', () => {
    insertMotionGraphic([panelLayer(), nameLayer()])
    const kfs = useKeyframesStore.getState().keyframesByItemId['panel-1']
    expect(kfs).toBeDefined()
    const opacity = kfs!.properties.find((p) => p.property === 'opacity')
    expect(opacity?.keyframes).toHaveLength(2)
  })

  it('commits tracks + items + keyframes as a SINGLE undo entry', () => {
    insertMotionGraphic([panelLayer(), nameLayer()])
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)

    useTimelineCommandStore.getState().undo()

    // One Ctrl+Z removes the whole graphic: items, the new tracks, and keyframes.
    expect(useItemsStore.getState().items).toHaveLength(0)
    expect(useItemsStore.getState().tracks).toHaveLength(1) // back to just the base track
    expect(useKeyframesStore.getState().keyframes).toHaveLength(0)
  })

  it('marks the project dirty', () => {
    insertMotionGraphic([panelLayer()])
    expect(useTimelineSettingsStore.getState().isDirty).toBe(true)
  })

  it('is a no-op for an empty layer list', () => {
    const result = insertMotionGraphic([])
    expect(result).toEqual({ itemIds: [], trackIds: [] })
    expect(useItemsStore.getState().tracks).toHaveLength(1)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
  })
})
