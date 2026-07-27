import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionEventDto } from '../types'
import { getSessionEvents } from '../commands'
import { Icon } from './Icon'

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
      fontFamily: 'Cascadia Code, Consolas, monospace',
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 100000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const ro = new ResizeObserver(() => fitRef.current?.fit())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      playTimerRef.current && clearTimeout(playTimerRef.current)
      term.dispose()
      termRef.current = null
    }
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
    termRef.current?.write(ev.content)
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
      termRef.current?.write(ev.content)
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
      termRef.current?.write(eventsRef.current[i].content)
    }
    playIndexRef.current = newIdx
    setCurrentIndex(newIdx)
  }

  const handleSeek = (ratio: number) => {
    handlePause()
    const targetIdx = Math.floor(ratio * eventsRef.current.length)
    termRef.current?.clear()
    for (let i = 0; i < targetIdx; i++) {
      termRef.current?.write(eventsRef.current[i].content)
    }
    playIndexRef.current = targetIdx
    setCurrentIndex(targetIdx)
  }

  const totalMs = events.length > 0 ? events[events.length - 1].timestampMs : 0
  const currentMs = currentIndex > 0 && events[currentIndex - 1]
    ? events[currentIndex - 1].timestampMs
    : 0

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  return (
    <div className="session-viewer">
      <div className="session-viewer-header">
        <span className="session-viewer-title"><Icon name="play" /> {sessionTitle}</span>
        <div className="session-viewer-controls">
          <button onClick={isPlaying ? handlePause : handlePlay} disabled={loading || events.length === 0}>
            {isPlaying ? <Icon name="pause" /> : <Icon name="play" />}
          </button>
          <button onClick={handleStepBack} disabled={loading || currentIndex === 0}>
            <Icon name="stepBack" />
          </button>
          <button onClick={handleStepForward} disabled={loading || currentIndex >= events.length}>
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
          <button onClick={onClose} className="close-btn">✕</button>
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
        <span className="event-count">{currentIndex} / {events.length} events</span>
      </div>
      <div className="session-viewer-terminal" ref={containerRef} />
    </div>
  )
}
