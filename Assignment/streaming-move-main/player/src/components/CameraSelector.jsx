import { useState } from 'react'

const CAMERAS = [
    { key: 'source', label: 'SOURCE', color: '#4ecdc4' },
    { key: 'sink', label: 'SINK', color: '#ff6b6b' },
    { key: 'hq', label: 'HQ', color: '#f5a623' },
]

export default function CameraSelector({ active, onSwitch, disabled }) {
    const [hovered, setHovered] = useState(null)

    return (
        <div style={{
            display: 'flex',
            gap: '4px',
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(12px)',
            borderRadius: '8px',
            padding: '4px',
            border: '1px solid rgba(255,255,255,0.08)',
        }}>
            {CAMERAS.map(cam => {
                const isActive = active === cam.key
                const isHover = hovered === cam.key
                return (
                    <button
                        key={cam.key}
                        disabled={disabled}
                        onClick={() => onSwitch(cam.key)}
                        onMouseEnter={() => setHovered(cam.key)}
                        onMouseLeave={() => setHovered(null)}
                        style={{
                            position: 'relative',
                            padding: '8px 18px',
                            borderRadius: '6px',
                            border: 'none',
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            fontFamily: 'var(--condensed)',
                            fontSize: '12px',
                            fontWeight: 600,
                            letterSpacing: '0.15em',
                            textTransform: 'uppercase',
                            transition: 'all 0.2s ease',
                            background: isActive
                                ? `${cam.color}22`
                                : isHover
                                    ? 'rgba(255,255,255,0.06)'
                                    : 'transparent',
                            color: isActive ? cam.color : 'rgba(255,255,255,0.5)',
                            opacity: disabled ? 0.4 : 1,
                        }}
                    >
                        {/* Active indicator dot */}
                        <span style={{
                            display: 'inline-block',
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: isActive ? cam.color : 'rgba(255,255,255,0.2)',
                            marginRight: '8px',
                            transition: 'all 0.2s ease',
                            boxShadow: isActive ? `0 0 8px ${cam.color}60` : 'none',
                        }} />
                        {cam.label}

                        {/* Bottom active bar */}
                        {isActive && (
                            <div style={{
                                position: 'absolute',
                                bottom: '2px',
                                left: '20%',
                                right: '20%',
                                height: '2px',
                                borderRadius: '1px',
                                background: cam.color,
                                boxShadow: `0 0 6px ${cam.color}40`,
                            }} />
                        )}
                    </button>
                )
            })}
        </div>
    )
}

export { CAMERAS }
