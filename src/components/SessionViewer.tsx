import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ansiThemeColors, xtermTheme } from '../lib/theme'
import { getTerminalTheme, subscribeTheme } from '../lib/themeStore'
import '@xterm/xterm/css/xterm.css'
import type { SessionEventDto } from '../types'
import { fixLowContrastSgr } from './terminal/sgrContrast'

// Only "output" events are visible terminal bytes. "input" events are the raw
// keystrokes we sent to the PTY, which the PTY already echoes back inside the
// "output" stream — writing both would duplicate every typed character during
// playback. "command" events are logical markers (used by extract-commands),
// not something rendered to the screen.
const isVisible = (ev: SessionEventDto) => ev.direction === 'output'
import { getSessionEvents } from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

/**
 * Write one recorded event, applying the same legibility guard as the live
 * terminal (terminal/sgrContrast.ts). The guard is pure, so a replayed session
 * shows exactly the colours the live one did.
 */
const writeEvent = (term: Terminal | null, content: string): void => {
  if (!term) return
  term.write(fixLowContrastSgr(content, ansiThemeColors(term.options.theme)))
}

interface SessionViewerProps {
  sessionId: string
  sessionTitle: string
  onClose: () => void
}

export const SessionViewer: React.FC<SessionViewerProps> = ({
  sessionId,
  sessionTitle,
  onClose,
}) => {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const eventsRef = useRef<SessionEventDto[]>([])
  const playIndexRef = useRef(0)
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [events, setEvents] = useState<SessionEventDto[]>([])
  const [loading, setLoading] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [speed, setSpeed] = useState(1)

  const isPlayingRef = useRef(false)
  const speedRef = useRef(1)
  isPlayingRef.current = isPlaying
  speedRef.current = speed

  // Load events
  useEffect(() => {
    setLoading(true)
    getSessionEvents(sessionId)
      .then((evs) => {
        setEvents(evs)
        eventsRef.current = evs
      })
      .catch((e) => console.error('Failed to load session events:', e))
      .finally(() => setLoading(false))
  }, [sessionId])

  // Init terminal
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        '"WrolpNerdFont", "FiraCode Nerd Font", "Fira Code Nerd Font", "CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "JetBrainsMono Nerd Font", "MesloLGS NF", "Symbols Nerd Font", Cascadia Code, Consolas, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace',
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 100000,
      // Shared with Terminal.tsx — see src/lib/theme.ts. Used to be a byte-for-byte
      // duplicate of the palette there.
      theme: xtermTheme(getTerminalTheme()),
      minimumContrastRatio: 1,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // xterm owns its palette in JS, so CSS tokens can't reach it.
    const unsubTheme = subscribeTheme(() => {
      term.options.theme = xtermTheme(getTerminalTheme())
    })

    const ro = new ResizeObserver(() => fitRef.current?.fit())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      unsubTheme()
      playTimerRef.current && clearTimeout(playTimerRef.current)
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Load the bundled Nerd Font. If xterm opened with a fallback font, the
  // texture atlas and cell metrics need to be reset once the real font is
  // ready, otherwise icon glyphs render with stale metrics and leave ghosts.
  useEffect(() => {
    document.fonts.load('13px "WrolpNerdFont"').then(
      () => {
        const fit = fitRef.current
        const term = termRef.current
        if (fit && term && term.cols > 0 && term.rows > 0) {
          try {
            // Reset the renderer so the font texture atlas is rebuilt with the
            // newly loaded Nerd Font metrics, then refresh every visible row.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(term as any)._core?._renderService?.clear()
            fit.fit()
            term.refresh(0, term.rows - 1)
          } catch {
            /* container may be momentarily 0-sized */
          }
        }
      },
      () => {
        /* font failed to load; terminal stays on fallback, still usable */
      },
    )
  }, [])

  const playNext = useCallback(() => {
    if (!isPlayingRef.current) return
    const evs = eventsRef.current
    const idx = playIndexRef.current
    if (idx >= evs.length) {
      setIsPlaying(false)
      return
    }

    const ev = evs[idx]
    if (isVisible(ev)) writeEvent(termRef.current, ev.content)
    playIndexRef.current = idx + 1
    setCurrentIndex(idx + 1)

    const nextEv = evs[idx + 1]
    if (nextEv) {
      const rawDelay = nextEv.timestampMs - ev.timestampMs
      const delay = Math.min(Math.max(rawDelay / speedRef.current, 5), 500)
      playTimerRef.current = setTimeout(playNext, delay)
    } else {
      setIsPlaying(false)
    }
  }, [])

  const handlePlay = () => {
    if (playIndexRef.current >= eventsRef.current.length) {
      // Reset to beginning
      playIndexRef.current = 0
      setCurrentIndex(0)
      termRef.current?.clear()
    }
    setIsPlaying(true)
    setTimeout(playNext, 50)
  }

  const handlePause = () => {
    setIsPlaying(false)
    if (playTimerRef.current) {
      clearTimeout(playTimerRef.current)
    }
  }

  const handleStepForward = () => {
    handlePause()
    const idx = playIndexRef.current
    if (idx < eventsRef.current.length) {
      const ev = eventsRef.current[idx]
      if (isVisible(ev)) writeEvent(termRef.current, ev.content)
      playIndexRef.current = idx + 1
      setCurrentIndex(idx + 1)
    }
  }

  const handleStepBack = () => {
    handlePause()
    if (playIndexRef.current === 0) return
    const newIdx = playIndexRef.current - 1
    playIndexRef.current = 0
    setCurrentIndex(0)
    termRef.current?.clear()
    // Replay up to newIdx
    for (let i = 0; i < newIdx; i++) {
      const ev = eventsRef.current[i]
      if (isVisible(ev)) writeEvent(termRef.current, ev.content)
    }
    playIndexRef.current = newIdx
    setCurrentIndex(newIdx)
  }

  const handleSeek = (ratio: number) => {
    handlePause()
    const targetIdx = Math.floor(ratio * eventsRef.current.length)
    termRef.current?.clear()
    for (let i = 0; i < targetIdx; i++) {
      const ev = eventsRef.current[i]
      if (isVisible(ev)) writeEvent(termRef.current, ev.content)
    }
    playIndexRef.current = targetIdx
    setCurrentIndex(targetIdx)
  }

  const totalMs = events.length > 0 ? events[events.length - 1].timestampMs : 0
  const currentMs =
    currentIndex > 0 && events[currentIndex - 1] ? events[currentIndex - 1].timestampMs : 0

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  return (
    <div className="session-viewer">
      <div className="session-viewer-header">
        <span className="session-viewer-title">
          <Icon name="play" /> {sessionTitle}
        </span>
        <div className="session-viewer-controls">
          <button
            onClick={isPlaying ? handlePause : handlePlay}
            disabled={loading || events.length === 0}
          >
            {isPlaying ? <Icon name="pause" /> : <Icon name="play" />}
          </button>
          <button onClick={handleStepBack} disabled={loading || currentIndex === 0}>
            <Icon name="stepBack" />
          </button>
          <button
            onClick={handleStepForward}
            disabled={loading || currentIndex >= events.length}
            title={t('stepForward')}
          >
            ⏭
          </button>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="speed-select"
          >
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={5}>5x</option>
            <option value={10}>10x</option>
          </select>
          <span className="time-display">
            {formatTime(currentMs)} / {formatTime(totalMs)}
          </span>
          <button onClick={onClose} className="close-btn" title={t('close')}>
            ✕
          </button>
        </div>
      </div>
      <div className="session-viewer-timeline">
        <input
          type="range"
          min={0}
          max={100}
          value={events.length > 0 ? (currentIndex / events.length) * 100 : 0}
          onChange={(e) => handleSeek(Number(e.target.value) / 100)}
          disabled={loading || events.length === 0}
          className="timeline-slider"
        />
        <span className="event-count">
          {currentIndex} / {events.length} {t('events')}
        </span>
      </div>
      <div className="session-viewer-terminal" ref={containerRef} />
    </div>
  )
}
