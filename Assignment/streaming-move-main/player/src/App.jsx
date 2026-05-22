import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import SeekBar from './components/SeekBar.jsx'
import LiveBadge from './components/LiveBadge.jsx'
import CameraSelector from './components/CameraSelector.jsx'
import EventPanel from './components/EventPanel.jsx'

const API_BASE = 'http://localhost:8080'
const REVIEW_BUFFER_SIZE = 30
const LIVE_THRESHOLD = 2
const CAMERAS = ['source', 'sink', 'hq']

const CAMERA_COLORS = {
  source: '#4ecdc4',
  sink: '#ff6b6b',
  hq: '#f5a623',
}

const LIVE_CONFIG = {
  backBufferLength: 60,
  maxBufferLength: 60,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 6,
  enableWorker: true,
  lowLatencyMode: false,
}

const REVIEW_CONFIG = {
  enableWorker: true,
  maxBufferLength: 60,
  backBufferLength: 60,
}

function buildReviewPlaylist(segments) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  for (const seg of segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(6)},`)
    lines.push(seg.blobUrl)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

export default function App() {
  // Refs for 3 video elements + 3 hls instances
  const videoRefs = useRef({})
  const hlsRefs = useRef({})
  const rafRef = useRef(null)
  const hoverTimer = useRef(null)
  const lastTickRef = useRef(0)

  // Rolling buffers for each camera (for review mode)
  const rollingBuffers = useRef({
    source: [],
    sink: [],
    hq: [],
  })
  const blobUrls = useRef({
    source: [],
    sink: [],
    hq: [],
  })
  const modeRef = useRef('live')

  // State
  const [status, setStatus] = useState('connecting')
  const [mode, setMode] = useState('live')
  const [activeCamera, setActiveCamera] = useState('source')
  const [showControls, setShowControls] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [liveEdge, setLiveEdge] = useState(null)
  const [bufferStart, setBufferStart] = useState(null)
  const [bufferedEnd, setBufferedEnd] = useState(null)
  const [liveSegments, setLiveSegments] = useState([])
  const [reviewSegs, setReviewSegs] = useState([])
  const [isPaused, setIsPaused] = useState(false)
  const [cameraUrls, setCameraUrls] = useState({})

  // Event state
  const [events, setEvents] = useState([])
  const [currentEventIndex, setCurrentEventIndex] = useState(null)
  const [showEventPanel, setShowEventPanel] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [streamStatus, setStreamStatus] = useState({})

  const isLive = mode === 'live' && liveEdge !== null && currentTime >= liveEdge - LIVE_THRESHOLD

  const setModeBoth = useCallback((m) => {
    modeRef.current = m
    setMode(m)
  }, [])

  // ── Fetch camera URLs and events ──────────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/cameras`)
      .then(r => r.json())
      .then(data => {
        setCameraUrls(data)
      })
      .catch(err => console.error('Failed to fetch cameras:', err))

    fetch(`${API_BASE}/events`)
      .then(r => r.json())
      .then(data => {
        setEvents(data)
      })
      .catch(err => console.error('Failed to fetch events:', err))

    // Poll status
    const statusInterval = setInterval(() => {
      // Pause network requests during review mode
      if (modeRef.current === 'review') return

      fetch(`${API_BASE}/status`)
        .then(r => r.json())
        .then(setStreamStatus)
        .catch(() => { })
    }, 5000)

    return () => clearInterval(statusInterval)
  }, [])

  // ── RAF tick ──────────────────────────────────────────────────────────
  const tick = useCallback((now) => {
    if (now - lastTickRef.current > 100) {
      lastTickRef.current = now
      const video = videoRefs.current[activeCamera]
      if (video) {
        setCurrentTime(video.currentTime)
        setIsPaused(video.paused)

        if (modeRef.current === 'live') {
          const hls = hlsRefs.current[activeCamera]
          if (hls) {
            const syncPos = hls.liveSyncPosition
            if (syncPos != null && Number.isFinite(syncPos)) setLiveEdge(syncPos)
          }
        }

        if (video.buffered.length > 0) {
          setBufferStart(video.buffered.start(0))
          setBufferedEnd(video.buffered.end(video.buffered.length - 1))
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [activeCamera])

  // ── Init all 3 live HLS instances ─────────────────────────────────────
  const initAllLive = useCallback((urls) => {
    CAMERAS.forEach(cam => {
      const url = urls[cam]
      const video = videoRefs.current[cam]
      if (!url || !video) return

      // Destroy existing
      hlsRefs.current[cam]?.destroy()

      const hls = new Hls(LIVE_CONFIG)
      hlsRefs.current[cam] = hls
      hls.loadSource(url)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('playing')
        // Play ALL cameras so their buffers stay hot for instant switching
        video.play().catch(() => { })
      })

      // Capture fragment bytes for review mode
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        const payload = data.payload
        if (!payload || !payload.byteLength) return

        const entry = {
          sn: data.frag.sn,
          originalStart: data.frag.start,
          duration: data.frag.duration,
          bytes: payload.slice(0),
        }

        const buf = [...rollingBuffers.current[cam], entry].slice(-REVIEW_BUFFER_SIZE)
        rollingBuffers.current[cam] = buf

        // Update state for active camera
        if (cam === activeCamera) {
          setLiveSegments(buf.map(s => ({
            sn: s.sn,
            start: s.originalStart,
            end: s.originalStart + s.duration,
          })))
        }
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.error(`[${cam}] HLS error:`, data)
        }
      })
    })

    setModeBoth('live')
  }, [setModeBoth])

  // ── Camera switching ──────────────────────────────────────────────────
  const switchCamera = useCallback((targetCam) => {
    if (targetCam === activeCamera) return

    const currentVideo = videoRefs.current[activeCamera]
    const targetVideo = videoRefs.current[targetCam]
    if (!currentVideo || !targetVideo) return

    // INSTANT visual switch — no blocking await
    setActiveCamera(targetCam)

    // Update live segments for new camera
    const buf = rollingBuffers.current[targetCam]
    setLiveSegments(buf.map(s => ({
      sn: s.sn,
      start: s.originalStart,
      end: s.originalStart + s.duration,
    })))

    if (modeRef.current === 'live') {
      // Target is already playing (all cameras auto-play), just sync position
      const currentTimePos = currentVideo.currentTime
      // Fire-and-forget sync — doesn't block the switch
      fetch(`${API_BASE}/sync?from_camera=${activeCamera}&from_time=${currentTimePos}`)
        .then(r => r.json())
        .then(syncData => {
          if (syncData[targetCam]?.time != null) {
            const targetTime = syncData[targetCam].time
            if (Math.abs(videoRefs.current[targetCam].currentTime - targetTime) > 0.5) {
              videoRefs.current[targetCam].currentTime = targetTime
            }
          }
        })
        .catch(() => { /* target already playing at its own live position */ })
    } else {
      // Review mode: sync to same time position
      targetVideo.currentTime = currentVideo.currentTime
      if (!currentVideo.paused) {
        targetVideo.play().catch(() => { })
      }
    }
  }, [activeCamera])

  // ── Enter review mode ─────────────────────────────────────────────────
  const enterReview = useCallback(() => {
    // Build blob VOD playlists for ALL cameras
    const allReviewSegs = {}

    for (const cam of CAMERAS) {
      const snapshot = rollingBuffers.current[cam].slice()
      if (snapshot.length === 0) continue

      const fragUrls = snapshot.map(s =>
        URL.createObjectURL(new Blob([s.bytes], { type: 'video/mp2t' }))
      )

      const reviewEntries = []
      let t = 0
      for (let i = 0; i < snapshot.length; i++) {
        reviewEntries.push({
          sn: snapshot[i].sn,
          start: t,
          end: t + snapshot[i].duration,
          duration: snapshot[i].duration,
          originalStart: snapshot[i].originalStart,
          blobUrl: fragUrls[i],
        })
        t += snapshot[i].duration
      }

      const m3u8 = buildReviewPlaylist(reviewEntries)
      const m3u8Url = URL.createObjectURL(
        new Blob([m3u8], { type: 'application/vnd.apple.mpegurl' })
      )

      blobUrls.current[cam] = [...fragUrls, m3u8Url]
      allReviewSegs[cam] = { entries: reviewEntries, m3u8Url }
    }

    // Destroy all live HLS instances
    CAMERAS.forEach(cam => {
      hlsRefs.current[cam]?.destroy()
      hlsRefs.current[cam] = null
    })
    setLiveEdge(null)
    setBufferStart(null)
    setBufferedEnd(null)
    setModeBoth('review')

    // Spin up review HLS for all cameras
    CAMERAS.forEach(cam => {
      const data = allReviewSegs[cam]
      if (!data) return

      const video = videoRefs.current[cam]
      if (!video) return

      const hls = new Hls(REVIEW_CONFIG)
      hlsRefs.current[cam] = hls
      hls.loadSource(data.m3u8Url)
      hls.attachMedia(video)

      hls.once(Hls.Events.MANIFEST_PARSED, () => {
        video.currentTime = 0
      })
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) console.error(`[review-${cam}] error`, d)
      })

      video.pause()
    })

    // Set review segments for active camera
    const activeReview = allReviewSegs[activeCamera]
    if (activeReview) {
      setReviewSegs(activeReview.entries.map(e => ({
        sn: e.sn,
        start: e.start,
        end: e.end,
      })))
    }

    return true
  }, [setModeBoth, activeCamera])

  // ── Exit review (Go Live) ─────────────────────────────────────────────
  const exitReview = useCallback(() => {
    // Tear down all review HLS
    CAMERAS.forEach(cam => {
      hlsRefs.current[cam]?.destroy()
      hlsRefs.current[cam] = null

      // Revoke blob URLs
      blobUrls.current[cam]?.forEach(URL.revokeObjectURL)
      blobUrls.current[cam] = []

      // Clear buffers
      rollingBuffers.current[cam] = []
    })

    setLiveSegments([])
    setReviewSegs([])

    if (Object.keys(cameraUrls).length > 0) {
      initAllLive(cameraUrls)
    }
  }, [initAllLive, cameraUrls])

  // ── Mount ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!Hls.isSupported()) {
      setStatus('error')
      return
    }

    if (Object.keys(cameraUrls).length > 0) {
      initAllLive(cameraUrls)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      CAMERAS.forEach(cam => {
        hlsRefs.current[cam]?.destroy()
        blobUrls.current[cam]?.forEach(URL.revokeObjectURL)
      })
    }
  }, [cameraUrls]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restart RAF when active camera changes ────────────────────────────
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // ── Event navigation ──────────────────────────────────────────────────
  const handleEventClick = useCallback((idx) => {
    if (!events[idx]) return
    setCurrentEventIndex(idx)
    setSelectedEvent(events[idx])
    setShowEventPanel(true)

    // Seek to event time
    const ev = events[idx]
    const time = ev.timestamps?.[activeCamera] ?? ev.timestamps?.source ?? 0
    const video = videoRefs.current[activeCamera]
    if (video) {
      video.currentTime = time
    }
  }, [events, activeCamera])

  const handlePrevEvent = useCallback(() => {
    if (!events.length) return
    const idx = currentEventIndex !== null
      ? Math.max(0, currentEventIndex - 1)
      : 0
    handleEventClick(idx)
  }, [events, currentEventIndex, handleEventClick])

  const handleNextEvent = useCallback(() => {
    if (!events.length) return
    const idx = currentEventIndex !== null
      ? Math.min(events.length - 1, currentEventIndex + 1)
      : 0
    handleEventClick(idx)
  }, [events, currentEventIndex, handleEventClick])

  // ── Keyboard support ──────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrevEvent()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNextEvent()
      } else if (e.key === ' ') {
        e.preventDefault()
        const video = videoRefs.current[activeCamera]
        if (video) {
          if (video.paused) video.play().catch(() => { })
          else video.pause()
        }
      } else if (e.key === 'Escape') {
        setShowEventPanel(false)
      } else if (e.key === 'r' || e.key === 'R') {
        if (mode === 'live') enterReview()
        else exitReview()
      } else if (e.key === '1') {
        switchCamera('source')
      } else if (e.key === '2') {
        switchCamera('sink')
      } else if (e.key === '3') {
        switchCamera('hq')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrevEvent, handleNextEvent, activeCamera, mode, enterReview, exitReview, switchCamera])

  // ── Controls ──────────────────────────────────────────────────────────
  const handleGoLive = useCallback(() => {
    setShowEventPanel(false)
    if (modeRef.current === 'review') {
      exitReview()
      return
    }
    // Seek to live edge
    const video = videoRefs.current[activeCamera]
    const hls = hlsRefs.current[activeCamera]
    if (!video || !hls) return
    if (Number.isFinite(hls.liveSyncPosition)) {
      video.currentTime = hls.liveSyncPosition
    }
    video.play().catch(() => { })
  }, [exitReview, activeCamera])

  const handleSeek = useCallback((time) => {
    const video = videoRefs.current[activeCamera]
    if (video) video.currentTime = time
  }, [activeCamera])

  // ── Display values ────────────────────────────────────────────────────
  const inReview = mode === 'review'
  const reviewStart = inReview && reviewSegs.length > 0 ? reviewSegs[0].start : null
  const reviewEnd = inReview && reviewSegs.length > 0 ? reviewSegs[reviewSegs.length - 1].end : null

  const displaySegments = inReview ? reviewSegs : liveSegments
  const displayLiveEdge = inReview ? reviewEnd : liveEdge
  const displayBufferStart = inReview ? reviewStart : bufferStart
  const displayBufferedEnd = inReview ? reviewEnd : bufferedEnd

  const memoryMB = CAMERAS.reduce((acc, cam) => {
    return acc + rollingBuffers.current[cam].reduce(
      (a, s) => a + (s.bytes?.byteLength || 0), 0
    )
  }, 0) / (1024 * 1024)

  // ── Hover ─────────────────────────────────────────────────────────────
  const onMouseEnter = () => { clearTimeout(hoverTimer.current); setShowControls(true) }
  const onMouseLeave = () => { hoverTimer.current = setTimeout(() => setShowControls(false), 2000) }
  const onMouseMove = () => {
    clearTimeout(hoverTimer.current)
    setShowControls(true)
    hoverTimer.current = setTimeout(() => setShowControls(false), 2500)
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg)',
    }}>
      {/* Header */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        background: 'rgba(8,8,8,0.95)',
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{
            fontFamily: 'var(--condensed)',
            fontSize: '14px',
            fontWeight: 700,
            letterSpacing: '0.2em',
            color: 'var(--amber)',
            textTransform: 'uppercase',
          }}>
            ◉ Judex Live Review
          </span>
          <span style={{ color: 'var(--border)', fontSize: '12px' }}>／</span>
          <span style={{
            fontFamily: 'var(--condensed)',
            fontSize: '12px',
            letterSpacing: '0.1em',
            color: 'var(--muted)',
            textTransform: 'uppercase',
          }}>
            Triple Camera System
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {/* Stream status indicators */}
          {CAMERAS.map(cam => (
            <div key={cam} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              <div style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: status === 'playing'
                  ? CAMERA_COLORS[cam]
                  : 'var(--muted)',
                boxShadow: status === 'playing'
                  ? `0 0 6px ${CAMERA_COLORS[cam]}60`
                  : 'none',
                animation: status === 'playing' ? 'pulse 2s infinite' : 'none',
              }} />
              <span style={{
                fontFamily: 'var(--mono)',
                fontSize: '9px',
                color: CAMERA_COLORS[cam],
                textTransform: 'uppercase',
                opacity: 0.7,
              }}>{cam}</span>
            </div>
          ))}

          <span style={{
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            color: 'var(--muted)',
          }}>
            mem <span style={{ color: 'var(--amber)' }}>{Math.round(memoryMB)} MB</span>
          </span>
        </div>
      </header>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @keyframes blink {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1.2); }
        }
      `}</style>

      {/* Main content */}
      <div
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onMouseMove={onMouseMove}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {/* All three video elements — only active one visible */}
        {CAMERAS.map(cam => (
          <video
            key={cam}
            ref={el => { if (el) videoRefs.current[cam] = el }}
            muted
            playsInline
            style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
              opacity: cam === activeCamera ? 1 : 0,
              pointerEvents: cam === activeCamera ? 'auto' : 'none',
              transition: 'opacity 0.15s ease',
            }}
          />
        ))}

        {/* Connecting overlay */}
        {status === 'connecting' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '16px',
            background: 'rgba(8,8,8,0.92)',
            zIndex: 50,
          }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  background: 'var(--amber)',
                  animation: `blink 1.2s ${i * 0.2}s ease-in-out infinite`,
                  opacity: 0.3,
                }} />
              ))}
            </div>
            <span style={{
              fontFamily: 'var(--condensed)', letterSpacing: '0.2em',
              fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase',
            }}>
              Connecting to streams…
            </span>
          </div>
        )}

        {/* Review mode badge */}
        {inReview && (
          <div style={{
            position: 'absolute', top: '16px', left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.75)',
            border: '1px solid rgba(245,166,35,0.4)',
            borderRadius: '6px',
            padding: '6px 16px',
            fontFamily: 'var(--condensed)',
            fontSize: '11px',
            letterSpacing: '0.2em',
            color: 'var(--amber)',
            textTransform: 'uppercase',
            pointerEvents: 'none',
            zIndex: 20,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            ◉ Replay Mode · No network downloads
          </div>
        )}

        {/* Camera selector overlay */}
        <div style={{
          position: 'absolute',
          top: '16px',
          left: '16px',
          zIndex: 20,
          opacity: showControls ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: showControls ? 'auto' : 'none',
        }}>
          <CameraSelector
            active={activeCamera}
            onSwitch={switchCamera}
          />
        </div>

        {/* Controls overlay */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: '32px 20px 18px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
          opacity: showControls ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: showControls ? 'auto' : 'none',
          zIndex: 15,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', marginBottom: '10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <LiveBadge isLive={isLive && !isPaused} onClick={handleGoLive} />

              {/* Review mode button */}
              {mode === 'live' ? (
                <button
                  onClick={enterReview}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '4px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(255,255,255,0.6)',
                    cursor: 'pointer',
                    fontFamily: 'var(--condensed)',
                    fontSize: '10px',
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                    transition: 'all 0.15s ease',
                  }}
                >⏪ Review</button>
              ) : (
                <button
                  onClick={handleGoLive}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '4px',
                    border: '1px solid rgba(245,166,35,0.3)',
                    background: 'rgba(245,166,35,0.15)',
                    color: 'var(--amber)',
                    cursor: 'pointer',
                    fontFamily: 'var(--condensed)',
                    fontSize: '10px',
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                    transition: 'all 0.15s ease',
                  }}
                >⏩ Go Live</button>
              )}
            </div>

            <div style={{
              display: 'flex', gap: '18px',
              fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--muted)',
            }}>
              <span>
                buf&nbsp;
                <span style={{ color: CAMERA_COLORS[activeCamera] }}>
                  {inReview ? reviewSegs.length : liveSegments.length} / {REVIEW_BUFFER_SIZE}
                </span>
              </span>
              <span>
                events&nbsp;
                <span style={{ color: 'var(--amber)' }}>
                  {events.length}
                </span>
              </span>
            </div>
          </div>

          {status === 'playing' && (
            <SeekBar
              currentTime={currentTime}
              liveEdge={displayLiveEdge}
              bufferStart={displayBufferStart}
              bufferedEnd={displayBufferedEnd}
              segments={displaySegments}
              events={events}
              activeCamera={activeCamera}
              currentEventIndex={currentEventIndex}
              onSeek={handleSeek}
              onPrevEvent={handlePrevEvent}
              onNextEvent={handleNextEvent}
              onEventClick={handleEventClick}
            />
          )}
        </div>
      </div>

      {/* Event Panel */}
      {showEventPanel && selectedEvent && (
        <EventPanel
          event={selectedEvent}
          apiBase={API_BASE}
          onClose={() => {
            setShowEventPanel(false)
            setSelectedEvent(null)
          }}
        />
      )}
    </div>
  )
}
