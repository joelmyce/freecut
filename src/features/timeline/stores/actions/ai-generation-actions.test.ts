import { beforeEach, describe, expect, it } from 'vite-plus/test'

import type { VideoItem, ShapeItem } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useTransitionsStore } from '../transitions-store'
import { useKeyframesStore } from '../keyframes-store'
import { useTimelineCommandStore } from '../timeline-command-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import {
  __clearPendingSnapshots,
  insertGenerationPlaceholder,
  markGenerationPlaceholderError,
  removeGenerationPlaceholder,
  swapPlaceholderWithMedia,
} from './ai-generation-actions'

function makeVideo(id: string, from: number, durationInFrames: number): VideoItem {
  return {
    id,
    type: 'video',
    trackId: 'track-1',
    from,
    durationInFrames,
    label: `${id}.mp4`,
    src: 'blob:test',
    mediaId: `media-${id}`,
    sourceStart: 0,
    sourceEnd: durationInFrames,
    sourceDuration: durationInFrames,
  }
}

function setupTimeline(): void {
  useTimelineCommandStore.getState().clearHistory()
  useTimelineSettingsStore.setState({ fps: 30, isDirty: false })
  useItemsStore.getState().setItems([])
  useItemsStore.getState().setTracks([
    {
      id: 'track-1',
      name: 'V1',
      kind: 'video',
      height: 80,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
      items: [],
      order: 0,
    },
  ])
  useTransitionsStore.getState().setTransitions([])
  useKeyframesStore.getState().setKeyframes([])
  __clearPendingSnapshots()
}

describe('ai-generation-actions', () => {
  beforeEach(setupTimeline)

  it('insertGenerationPlaceholder adds a shape with aiPlaceholder set and does NOT push undo', () => {
    const id = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 60,
      durationInFrames: 90,
      prompt: 'city night skyline',
      providerId: 'fal',
    })
    const items = useItemsStore.getState().items
    const placeholder = items.find((i) => i.id === id) as ShapeItem | undefined
    expect(placeholder).toBeDefined()
    expect(placeholder?.type).toBe('shape')
    expect(placeholder?.aiPlaceholder?.prompt).toBe('city night skyline')
    expect(placeholder?.aiPlaceholder?.status).toBe('generating')
    expect(placeholder?.label).toBe('Generating: city night skyline')

    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
  })

  it('swapPlaceholderWithMedia swaps in the real item and pushes ONE undo entry that rewinds past the placeholder', () => {
    const placeholderId = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 60,
      durationInFrames: 90,
      prompt: 'p',
    })
    const replacement = makeVideo('real-1', 60, 90)
    const ok = swapPlaceholderWithMedia(placeholderId, replacement)
    expect(ok).toBe(true)

    const items = useItemsStore.getState().items
    expect(items.some((i) => i.id === placeholderId)).toBe(false)
    expect(items.some((i) => i.id === 'real-1')).toBe(true)
    expect(useTimelineCommandStore.getState().canUndo).toBe(true)

    // One undo should rewind past placeholder + swap → empty timeline.
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items).toHaveLength(0)

    // Second undo is a no-op (stack is empty).
    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
  })

  it('swapPlaceholderWithMedia returns false when placeholder is gone', () => {
    const placeholderId = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 0,
      durationInFrames: 30,
      prompt: 'x',
    })
    removeGenerationPlaceholder(placeholderId)
    const ok = swapPlaceholderWithMedia(placeholderId, makeVideo('r', 0, 30))
    expect(ok).toBe(false)
    expect(useItemsStore.getState().items).toHaveLength(0)
  })

  it('removeGenerationPlaceholder cleans up without an undo entry', () => {
    const id = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 0,
      durationInFrames: 30,
      prompt: 'x',
    })
    removeGenerationPlaceholder(id)
    expect(useItemsStore.getState().items).toHaveLength(0)
    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
  })

  it('markGenerationPlaceholderError flips status + label without an undo entry', () => {
    const id = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 0,
      durationInFrames: 30,
      prompt: 'broken prompt',
    })
    markGenerationPlaceholderError(id, 'fal job failed')
    const item = useItemsStore.getState().items.find((i) => i.id === id) as ShapeItem | undefined
    expect(item?.aiPlaceholder?.status).toBe('error')
    expect(item?.aiPlaceholder?.errorMessage).toBe('fal job failed')
    expect(item?.label).toBe('Failed: broken prompt')
    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
  })

  it('prompt longer than 60 chars is truncated in the label', () => {
    const long = 'a'.repeat(80)
    const id = insertGenerationPlaceholder({
      trackId: 'track-1',
      from: 0,
      durationInFrames: 30,
      prompt: long,
    })
    const item = useItemsStore.getState().items.find((i) => i.id === id) as ShapeItem | undefined
    expect(item?.label.startsWith('Generating: ')).toBe(true)
    expect(item?.label.length).toBeLessThan('Generating: '.length + long.length)
    expect(item?.label.endsWith('…')).toBe(true)
  })
})
