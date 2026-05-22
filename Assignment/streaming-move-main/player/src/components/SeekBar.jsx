import { useRef, useCallback, useState } from 'react'

const CAMERA_COLORS = {
  source: '#4ecdc4',
  sink: '#ff6b6b',
  hq: '#f5a623',
}

function toFraction(t, start, end) {
  if (end <= start) return 0
  return Math.max(0, Math.min(1, (t - start) / (end - start)))
}

export default function SeekBar({
  currentTime,
  liveEdge,
  bufferStart,
  bufferedEnd,
  segments,
  events,
  activeCamera,
  currentEventIndex,
  onSeek,
  onPrevEvent,
  onNextEvent,
  onEventClick,
}) {
  const trackRef = useRef(null)
  const dragging = useRef(false)
  const [hoveredEvent, setHoveredEvent] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })

  const segs = segments ?? []
  const segsStart = segs.length > 0 ? segs[0].start : null
  const segsEnd = segs.length > 0 ? segs[segs.length - 1].end : null

  const rangeStart = segsStart ?? bufferStart ?? (liveEdge !== null ? liveEdge - 80 : 0)
  const rangeEnd = Math.max(
    segsEnd ?? -Infinity,
    liveEdge ?? -Infinity,
    currentTime
  )

  const seekFromEvent = useCallback((e) => {
    const rect = trackRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const targetTime = rangeStart + frac * (rangeEnd - rangeStart)
    onSeek(targetTime)
  }, [rangeStart, rangeEnd, onSeek])

  const onMouseDown = (e) => {
    dragging.current = true
    seekFromEvent(e)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
  const onMouseMove = useCallback((e) => {
    if (dragging.current) seekFromEvent(e)
  }, [seekFromEvent])
  const onMouseUp = useCallback(() => {
    dragging.current = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }, [onMouseMove])

  const playedFrac = toFraction(currentTime, rangeStart, rangeEnd)
  const bufferedFrac = toFraction(bufferedEnd ?? currentTime, rangeStart, rangeEnd)

  const visibleTicks = (segments || []).filter(
    s => s.start > rangeStart && s.start < rangeEnd
  )

  const behind = liveEdge && currentTime
    ? Math.round(liveEdge - currentTime)
    : null

  // Event markers
  const camColor = CAMERA_COLORS[activeCamera] || 'var(--amber)'
  const eventMarkers = (events || []).map((ev, idx) => {
    const evTime = ev.timestamps?.[activeCamera] ?? ev.timestamps?.source ?? 0
    if (evTime < rangeStart || evTime > rangeEnd) return null
    const frac = toFraction(evTime, rangeStart, rangeEnd)
    const isCurrent = idx === currentEventIndex
    const isShot = ev.counts_as_shot

    return (
      <div
        key={ev.shot_id ?? idx}
        onClick={(e) => {
          e.stopPropagation()
          onEventClick?.(idx)
        }}
        onMouseEnter={(e) => {
          setHoveredEvent(ev)
          setHoverPos({ x: e.clientX, y: e.clientY })
        }}
        onMouseLeave={() => setHoveredEvent(null)}
        style={{
          position: 'absolute',
          left: `${frac * 100}%`,
          bottom: '0',
          transform: 'translateX(-50%)',
          width: isCurrent ? '12px' : '8px',
          height: isCurrent ? '20px' : '14px',
          borderRadius: '2px',
          background: isCurrent
            ? camColor
            : isShot
              ? `${camColor}90`
              : 'rgba(255,255,255,0.25)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          zIndex: isCurrent ? 10 : 5,
          boxShadow: isCurrent ? `0 0 10px ${camColor}60` : 'none',
        }}
      />
    )
  }).filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Label row */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '10px',
        fontFamily: 'var(--condensed)',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>DVR Window</span>
          {/* Event navigation buttons */}
          {events && events.length > 0 && (
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                onClick={onPrevEvent}
                style={navBtnStyle}
                title="Previous Event (←)"
              >◁ Prev</button>
              <button
                onClick={onNextEvent}
                style={navBtnStyle}
                title="Next Event (→)"
              >Next ▷</button>
              <span style={{
                fontFamily: 'var(--mono)',
                fontSize: '10px',
                color: camColor,
                marginLeft: '4px',
              }}>
                {currentEventIndex !== null
                  ? `${currentEventIndex + 1}/${events.length}`
                  : `${events.length} events`
                }
              </span>
            </div>
          )}
        </div>
        <span style={{
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          color: 'var(--amber)',
        }}>
          {behind !== null && behind > 1 ? `−${behind}s` : 'LIVE'}
        </span>
      </div>

      {/* Track with event markers */}
      <div style={{ position: 'relative', height: '32px' }}>
        {/* Event markers layer */}
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '12px',
          height: '20px',
          pointerEvents: 'auto',
        }}>
          {eventMarkers}
        </div>

        {/* Seekable track */}
        <div
          ref={trackRef}
          onMouseDown={onMouseDown}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '20px',
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {/* Rail */}
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: '3px',
            background: 'rgba(255,255,255,0.07)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}>
            {/* Buffered fill */}
            <div style={{
              position: 'absolute',
              left: 0,
              width: `${bufferedFrac * 100}%`,
              height: '100%',
              background: `${camColor}35`,
            }} />
            {/* Played fill */}
            <div style={{
              position: 'absolute',
              left: 0,
              width: `${playedFrac * 100}%`,
              height: '100%',
              background: camColor,
            }} />
          </div>

          {/* Segment tick marks */}
          {visibleTicks.map((seg, i) => {
            const frac = toFraction(seg.start, rangeStart, rangeEnd)
            return (
              <div key={i} style={{
                position: 'absolute',
                left: `${frac * 100}%`,
                width: '1px',
                height: '10px',
                background: 'rgba(255,255,255,0.18)',
                transform: 'translateX(-0.5px)',
                pointerEvents: 'none',
              }} />
            )
          })}

          {/* Thumb */}
          <div style={{
            position: 'absolute',
            left: `${playedFrac * 100}%`,
            transform: 'translateX(-50%)',
            width: '11px',
            height: '11px',
            borderRadius: '50%',
            background: camColor,
            boxShadow: `0 0 0 2px ${camColor}40`,
            pointerEvents: 'none',
            zIndex: 2,
          }} />

          {/* Live edge marker */}
          <div style={{
            position: 'absolute',
            right: 0,
            width: '2px',
            height: '14px',
            background: 'var(--red)',
            borderRadius: '1px',
            opacity: 0.8,
            pointerEvents: 'none',
          }} />
        </div>
      </div>

      {/* Time ruler */}
      <div style={{
        position: 'relative',
        height: '12px',
        fontSize: '9px',
        fontFamily: 'var(--mono)',
        color: 'var(--muted)',
      }}>
        <span style={{ position: 'absolute', left: 0 }}>
          {formatOffset(rangeStart - (liveEdge ?? rangeStart))}
        </span>
        <span style={{ position: 'absolute', right: 0, color: 'var(--red)', opacity: 0.7 }}>
          EDGE
        </span>
      </div>

      {/* Event hover tooltip */}
      {hoveredEvent && (
        <div style={{
          position: 'fixed',
          left: `${hoverPos.x}px`,
          top: `${hoverPos.y - 80}px`,
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.9)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '6px',
          padding: '8px 12px',
          pointerEvents: 'none',
          zIndex: 1000,
          minWidth: '140px',
        }}>
          <div style={{
            fontFamily: 'var(--condensed)',
            fontSize: '11px',
            color: 'var(--amber)',
            letterSpacing: '0.1em',
            marginBottom: '4px',
          }}>
            Event #{hoveredEvent.shot_id}
          </div>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            color: 'var(--muted)',
          }}>
            {hoveredEvent.counts_as_shot ? '🏸 Shot' : 'Flight'}
            {hoveredEvent.bounce_x != null && (
              <span> · ({hoveredEvent.bounce_x?.toFixed(1)}, {hoveredEvent.bounce_y?.toFixed(1)})</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const navBtnStyle = {
  padding: '2px 8px',
  borderRadius: '3px',
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.6)',
  cursor: 'pointer',
  fontFamily: 'var(--condensed)',
  fontSize: '10px',
  letterSpacing: '0.1em',
  transition: 'all 0.15s ease',
}

function formatOffset(seconds) {
  const s = Math.round(Math.abs(seconds))
  return seconds < -1 ? `−${s}s` : '0s'
}
