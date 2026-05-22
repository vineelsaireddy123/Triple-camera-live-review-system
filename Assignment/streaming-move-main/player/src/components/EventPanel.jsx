import { useRef, useEffect, useState } from 'react'

const CAM_LABELS = [
    { key: 'source', label: 'SOURCE', color: '#4ecdc4' },
    { key: 'sink', label: 'SINK', color: '#ff6b6b' },
    { key: 'hq', label: 'HQ', color: '#f5a623' },
]

export default function EventPanel({ event, apiBase, onClose }) {
    const videoRefs = useRef({})
    const [playing, setPlaying] = useState(false)
    const [currentClipTime, setCurrentClipTime] = useState(0)
    const [clipDuration, setClipDuration] = useState(0)

    if (!event) return null

    const clips = event.clips || {}
    const hasAnyClip = Object.keys(clips).length > 0

    const playAll = () => {
        CAM_LABELS.forEach(cam => {
            const vid = videoRefs.current[cam.key]
            if (vid) {
                vid.currentTime = 0
                vid.play().catch(() => { })
            }
        })
        setPlaying(true)
    }

    const pauseAll = () => {
        CAM_LABELS.forEach(cam => {
            const vid = videoRefs.current[cam.key]
            if (vid) vid.pause()
        })
        setPlaying(false)
    }

    const restartAll = () => {
        CAM_LABELS.forEach(cam => {
            const vid = videoRefs.current[cam.key]
            if (vid) {
                vid.currentTime = 0
                vid.play().catch(() => { })
            }
        })
        setPlaying(true)
    }

    const togglePlay = () => {
        if (playing) pauseAll()
        else playAll()
    }

    return (
        <div style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'linear-gradient(to top, rgba(8,8,8,0.98) 0%, rgba(8,8,8,0.95) 100%)',
            backdropFilter: 'blur(20px)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            animation: 'slideUp 0.3s ease-out',
        }}>
            <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

            {/* Header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 20px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{
                        fontFamily: 'var(--condensed)',
                        fontSize: '13px',
                        letterSpacing: '0.2em',
                        color: 'var(--amber)',
                        textTransform: 'uppercase',
                    }}>
                        ◉ Event #{event.shot_id}
                    </span>
                    {event.counts_as_shot && (
                        <span style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            background: 'rgba(78,205,196,0.15)',
                            border: '1px solid rgba(78,205,196,0.3)',
                            fontFamily: 'var(--mono)',
                            fontSize: '10px',
                            color: '#4ecdc4',
                        }}>SHOT</span>
                    )}
                    {event.bounce_x != null && (
                        <span style={{
                            fontFamily: 'var(--mono)',
                            fontSize: '10px',
                            color: 'var(--muted)',
                        }}>
                            Bounce: ({event.bounce_x?.toFixed(2)}, {event.bounce_y?.toFixed(2)}, {event.bounce_z?.toFixed(2)})
                        </span>
                    )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {/* Playback controls */}
                    {hasAnyClip && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                            <button onClick={restartAll} style={btnStyle} title="Restart">
                                ⟲
                            </button>
                            <button onClick={togglePlay} style={{
                                ...btnStyle,
                                background: 'rgba(245,166,35,0.2)',
                                color: 'var(--amber)',
                                border: '1px solid rgba(245,166,35,0.3)',
                                minWidth: '32px',
                            }} title={playing ? "Pause" : "Play"}>
                                {playing ? '⏸' : '▶'}
                            </button>
                        </div>
                    )}
                    <button onClick={onClose} style={{
                        ...btnStyle,
                        color: 'rgba(255,255,255,0.6)',
                    }} title="Close">✕</button>
                </div>
            </div>

            {/* Video Grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
                padding: '12px 20px 16px',
            }}>
                {CAM_LABELS.map(cam => {
                    const clipUrl = clips[cam.key]
                    return (
                        <div key={cam.key} style={{
                            borderRadius: '8px',
                            overflow: 'hidden',
                            background: 'rgba(0,0,0,0.6)',
                            border: `1px solid ${cam.color}30`,
                        }}>
                            {/* Camera label */}
                            <div style={{
                                padding: '6px 10px',
                                background: `${cam.color}10`,
                                borderBottom: `1px solid ${cam.color}20`,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                            }}>
                                <span style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: cam.color,
                                    boxShadow: `0 0 6px ${cam.color}40`,
                                }} />
                                <span style={{
                                    fontFamily: 'var(--condensed)',
                                    fontSize: '11px',
                                    letterSpacing: '0.15em',
                                    color: cam.color,
                                    textTransform: 'uppercase',
                                }}>{cam.label}</span>
                            </div>

                            {/* Video or placeholder */}
                            {clipUrl ? (
                                <video
                                    ref={el => { if (el) videoRefs.current[cam.key] = el }}
                                    src={clipUrl}
                                    muted
                                    playsInline
                                    style={{
                                        width: '100%',
                                        height: '160px',
                                        objectFit: 'contain',
                                        background: '#000',
                                        display: 'block',
                                    }}
                                    onEnded={() => setPlaying(false)}
                                />
                            ) : (
                                <div style={{
                                    width: '100%',
                                    height: '160px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexDirection: 'column',
                                    gap: '8px',
                                }}>
                                    <span style={{
                                        fontSize: '20px',
                                        opacity: 0.3,
                                    }}>🎬</span>
                                    <span style={{
                                        fontFamily: 'var(--mono)',
                                        fontSize: '10px',
                                        color: 'var(--muted)',
                                    }}>No clip available</span>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

const btnStyle = {
    padding: '6px 10px',
    borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.8)',
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.15s ease',
}
