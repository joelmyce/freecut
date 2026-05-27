import { describe, expect, it } from 'vitest'
import { summarizeTimelineForAgent, type TimelineAgentSnapshot } from './summarize-timeline'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'

function track(
  id: string,
  name: string,
  order: number,
  overrides: Partial<TimelineTrack> = {},
): TimelineTrack {
  return {
    id,
    name,
    kind: 'video',
    height: 60,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    order,
    ...overrides,
  } as TimelineTrack
}

function videoItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
  overrides: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    id,
    trackId,
    from,
    durationInFrames,
    label: `video-${id}`,
    type: 'video',
    src: 'blob:fake',
    ...overrides,
  } as unknown as TimelineItem
}

function audioItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
  overrides: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    id,
    trackId,
    from,
    durationInFrames,
    label: `audio-${id}`,
    type: 'audio',
    src: 'blob:fake',
    ...overrides,
  } as unknown as TimelineItem
}

function textItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
  text: string,
): TimelineItem {
  return {
    id,
    trackId,
    from,
    durationInFrames,
    label: text,
    type: 'text',
    text,
    color: '#fff',
  } as unknown as TimelineItem
}

function subtitleItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
  cueCount: number,
): TimelineItem {
  return {
    id,
    trackId,
    from,
    durationInFrames,
    label: 'subtitles',
    type: 'subtitle',
    cues: Array.from({ length: cueCount }, (_, i) => ({
      id: `cue-${i}`,
      startSeconds: i,
      endSeconds: i + 1,
      text: `cue ${i}`,
    })),
    color: '#fff',
    source: { type: 'transcript', mediaId: 'm1', clipId: id },
  } as unknown as TimelineItem
}

function compositionItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
  label: string,
): TimelineItem {
  return {
    id,
    trackId,
    from,
    durationInFrames,
    label,
    type: 'composition',
    compositionId: 'c1',
  } as unknown as TimelineItem
}

function baseSnapshot(overrides: Partial<TimelineAgentSnapshot> = {}): TimelineAgentSnapshot {
  return {
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    composition: { activeId: null, activeLabel: null },
    tracks: [],
    items: [],
    selection: { itemIds: [] },
    playback: { currentFrame: 0 },
    markers: { inPoint: null, outPoint: null },
    mediaById: {},
    pendingGenerations: 0,
    ...overrides,
  }
}

describe('summarizeTimelineForAgent', () => {
  it('renders an empty timeline with a header, playhead, and pending-generations line', () => {
    const output = summarizeTimelineForAgent(baseSnapshot())
    expect(output).toContain('Timeline — 30 fps, 1920x1080, 00:00 total')
    expect(output).toContain('Playhead: 00:00')
    expect(output).toContain('Pending generations: 0')
    expect(output).not.toContain('Selected:')
    expect(output).not.toContain('In:')
  })

  it('renders a single video item on one track using the media filename', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [videoItem('clip_a', 't1', 0, 360, { mediaId: 'm1' })]
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        tracks,
        items,
        mediaById: { m1: { fileName: 'intro.mp4' } },
      }),
    )
    expect(output).toContain('  V1  [00:00-00:12 intro.mp4 (media:m1)]')
    expect(output).toContain('Timeline — 30 fps, 1920x1080, 00:12 total')
  })

  it('falls back to the item label when the media is not in mediaById', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [videoItem('clip_a', 't1', 0, 30, { mediaId: 'm1', label: 'fallback.mp4' })]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toContain('fallback.mp4 (media:m1)')
  })

  it('orders tracks ascending by order and renders multiple items per track sorted by `from`', () => {
    const tracks = [
      track('tv2', 'V2', 0),
      track('tv1', 'V1', 1),
      track('ta1', 'A1', 2, { kind: 'audio' }),
    ]
    const items = [
      videoItem('clip_b3', 'tv2', 540, 810, { mediaId: 'm_scene' }),
      videoItem('clip_a8', 'tv2', 0, 360, { mediaId: 'm_intro' }),
      videoItem('clip_c1', 'tv1', 0, 8160, { mediaId: 'm_bg' }),
      audioItem('clip_d2', 'ta1', 0, 8160, { mediaId: 'm_vo' }),
    ]
    const mediaById = {
      m_intro: { fileName: 'intro.mp4' },
      m_scene: { fileName: 'scene1.mp4' },
      m_bg: { fileName: 'background.mp4' },
      m_vo: { fileName: 'voiceover.wav' },
    }
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items, mediaById }))
    const lines = output.split('\n')
    expect(lines[1]).toBe(
      '  V2  [00:00-00:12 intro.mp4 (media:m_intro)] [00:18-00:45 scene1.mp4 (media:m_scene)]',
    )
    expect(lines[2]).toBe('  V1  [00:00-04:32 background.mp4 (media:m_bg)]')
    expect(lines[3]).toBe('  A1  [00:00-04:32 voiceover.wav (media:m_vo)]')
  })

  it('skips group tracks and shows empty tracks as "(empty)"', () => {
    const tracks = [
      track('g1', 'Group A', 0, { isGroup: true }),
      track('t1', 'V1', 1),
      track('t2', 'V2', 2),
    ]
    const items = [videoItem('clip_a', 't1', 0, 30)]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).not.toContain('Group A')
    expect(output).toContain('  V1  [00:00-00:01')
    expect(output).toContain('  V2  (empty)')
  })

  it('annotates effective track flags (muted, hidden, locked) on each item', () => {
    const tracks = [track('t1', 'V1', 0, { muted: true, visible: false, locked: true })]
    const items = [videoItem('clip_a', 't1', 0, 30, { mediaId: 'm1' })]
    const output = summarizeTimelineForAgent(
      baseSnapshot({ tracks, items, mediaById: { m1: { fileName: 'a.mp4' } } }),
    )
    expect(output).toContain('(media:m1, muted, hidden, locked)')
  })

  it('renders subtitle items as "N segments"', () => {
    const tracks = [track('ts', 'Captions', 0)]
    const items = [subtitleItem('clip_e7', 'ts', 540, 7560, 12)]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toContain('  Captions  [00:18-04:30 12 segments (item:clip_e7)]')
  })

  it('renders composition items as comp:"label"', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [compositionItem('clip_c', 't1', 0, 60, 'Title Sequence')]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toContain('comp:"Title Sequence" (item:clip_c)')
  })

  it('renders text items quoted', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [textItem('clip_t', 't1', 0, 30, 'Hello world')]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toContain('"Hello world" (item:clip_t)')
  })

  it('shows selection of a single item', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [videoItem('clip_a', 't1', 0, 30, { mediaId: 'm1' })]
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        tracks,
        items,
        mediaById: { m1: { fileName: 'intro.mp4' } },
        selection: { itemIds: ['clip_a'] },
      }),
    )
    expect(output).toContain('Selected: media:m1 intro.mp4')
  })

  it('shows selection of multiple items with a more-count suffix', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [
      videoItem('clip_a', 't1', 0, 30, { mediaId: 'm1' }),
      videoItem('clip_b', 't1', 60, 30, { mediaId: 'm1' }),
      videoItem('clip_c', 't1', 120, 30, { mediaId: 'm1' }),
    ]
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        tracks,
        items,
        mediaById: { m1: { fileName: 'x.mp4' } },
        selection: { itemIds: ['clip_a', 'clip_b', 'clip_c'] },
      }),
    )
    expect(output).toContain('Selected: media:m1 x.mp4 (+2 more)')
  })

  it('annotates the active sub-composition in the header', () => {
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        composition: { activeId: 'c1', activeLabel: 'Intro' },
      }),
    )
    expect(output).toContain('Timeline (in composition "Intro") — 30 fps')
  })

  it('shows in/out points on the playhead line when set', () => {
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        playback: { currentFrame: 1020 },
        markers: { inPoint: 540, outPoint: 8100 },
      }),
    )
    expect(output).toContain('Playhead: 00:34  In: 00:18  Out: 04:30')
  })

  it('renders only the playhead when in/out are not set', () => {
    const output = summarizeTimelineForAgent(baseSnapshot({ playback: { currentFrame: 60 } }))
    expect(output).toContain('Playhead: 00:02')
    expect(output).not.toContain('In:')
    expect(output).not.toContain('Out:')
  })

  it('renders only the in point when only one of in/out is set', () => {
    const output = summarizeTimelineForAgent(
      baseSnapshot({ markers: { inPoint: 60, outPoint: null } }),
    )
    expect(output).toContain('In: 00:02')
    expect(output).toContain('Out: (none)')
  })

  it('truncates very long text labels', () => {
    const tracks = [track('t1', 'V1', 0)]
    const longText = 'a'.repeat(200)
    const items = [textItem('clip_t', 't1', 0, 30, longText)]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toMatch(/"a{39}…" \(item:clip_t\)/)
  })

  it('collapses overflow items with [+N more]', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = Array.from({ length: 25 }, (_, i) =>
      videoItem(`c${i}`, 't1', i * 30, 30, { mediaId: 'm1' }),
    )
    const output = summarizeTimelineForAgent(
      baseSnapshot({ tracks, items, mediaById: { m1: { fileName: 'x.mp4' } } }),
    )
    expect(output).toContain('[+5 more]')
  })

  it('formats hours when timeline is over an hour long', () => {
    const tracks = [track('t1', 'V1', 0)]
    const items = [videoItem('clip_a', 't1', 0, 30 * 3661)]
    const output = summarizeTimelineForAgent(baseSnapshot({ tracks, items }))
    expect(output).toContain('1:01:01 total')
  })

  it('reports unknown resolution when none is supplied', () => {
    const output = summarizeTimelineForAgent(baseSnapshot({ resolution: null }))
    expect(output).toContain('unknown size')
  })

  it('reports pending generations count', () => {
    const output = summarizeTimelineForAgent(baseSnapshot({ pendingGenerations: 3 }))
    expect(output).toContain('Pending generations: 3')
  })

  it('§6.5.2.3: renders Context flags line with playhead + ai-generated hints', () => {
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        uiFlags: {
          playheadInsideClipId: 'clip_a',
          selectedClipIsAiGenerated: true,
        },
      }),
    )
    expect(output).toContain(
      'Context flags: playheadInsideClipId=item:clip_a, selectedClipIsAiGenerated=true',
    )
  })

  it('§6.5.2.3: omits Context flags line when both flags are empty', () => {
    const output = summarizeTimelineForAgent(
      baseSnapshot({
        uiFlags: { playheadInsideClipId: null, selectedClipIsAiGenerated: false },
      }),
    )
    expect(output).not.toContain('Context flags:')
  })

  it('§6.5.2.3: omits Context flags line entirely when uiFlags is undefined', () => {
    const output = summarizeTimelineForAgent(baseSnapshot({ uiFlags: undefined }))
    expect(output).not.toContain('Context flags:')
  })
})
