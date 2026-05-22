# Triple-Camera Live Review System

Built a multi-camera review tool for sports (pickleball specifically). It takes HLS streams from 3 different camera angles — SOURCE, SINK, and HQ — syncs them up, and lets you switch between them in real-time without any rebuffering. There's also an event timeline showing all the detected shots/bounces, and you can inspect bounce clips from all 3 angles side by side.


## How it works

The backend (`tri_stream_server.py`) does a few things:
- Simulates live HLS streams for each camera by serving `.ts` segments with a sliding window playlist
- Exposes a REST API for camera URLs, sync data, event info, and bounce clips
- Uses a pre-computed sync table (nanosecond wall-clock timestamps) to map frames across cameras

The frontend is a React app (Vite + hls.js) that keeps 3 hls.js instances running simultaneously — one per camera. When you switch cameras, it just swaps which `<video>` is visible and seeks to the synced position. No reconnection needed, so switching feels instant.

There's also a review/replay mode where it snapshots whatever's been buffered, builds blob-based VOD playlists from those bytes, and plays them back entirely offline (no more network requests).

## Setup

You need Python 3.8+ and Node 18+.

### 1. Start the Backend (Terminal 1)

```bash
cd streaming-move-main
python3 tri_stream_server.py --speed 4
```

This starts:
- 3 HLS stream servers (SOURCE:8081, SINK:8082, HQ:8083)
- API server on port 8080 with endpoints: `/cameras`, `/sync`, `/events`, `/status`, `/clips/`

### 2. Start the Frontend (Terminal 2)

```bash
cd streaming-move-main/player
npm install
npm run dev
```

### 3. Open the App

Open **http://localhost:3000** in your browser (Chrome recommended).

## Features & How to Test

###  1. Three Synchronized Camera Streams
- All 3 cameras stream simultaneously (SOURCE, SINK, HQ)
- Check: The header shows 3 colored status dots (teal, red, amber)

###  2. Instant Camera Switching
- Click **SOURCE / SINK / HQ** buttons in the top-left overlay
- **Expected**: Near-instant switch with no black screen or rebuffer
- **How it works**: All 3 hls.js instances stay connected; switching only changes which `<video>` is visible and seeks using the sync API

### 3. Event Markers on Seek Bar
- Colored markers appear on the timeline representing shot/bounce events
- **Hover** over a marker → tooltip with event details
- **Click** a marker → seeks to that event and opens the Event Panel

###  4. Event Navigation
- **Prev/Next buttons** on the seek bar
- **Keyboard**: `←` / `→` arrow keys jump between events
- Current event is highlighted with a larger marker

###  5. Review Mode (Replay)
- Click the **⏪ Review** button or press `R`
- **Expected**: All live connections destroyed, replay uses ONLY buffered segment bytes
- **Verify**: Open Network tab in DevTools — NO new `.ts` requests should appear
- Camera switching and seeking still work in review mode
- Click **⏩ Go Live** or press `R` again to return to live

###  6. Event Panel with Bounce Clips
- Click any event marker on the timeline
- A slide-up panel shows 3 synchronized bounce clip players (SOURCE, SINK, HQ)
- Play/Pause/Restart controls for all clips simultaneously
- Missing clips show a graceful placeholder
- Press `Esc` to close

### 7. DVR-Style Seek Bar
- Drag the seek bar to scrub through buffered content
- Buffer indicator shows how much is available
- Live edge marker on the right

### 8. Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `←` | Previous event |
| `→` | Next event |
| `Space` | Play/Pause |
| `R` | Toggle Review/Live mode |
| `Esc` | Close Event Panel |

## Backend API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /cameras` | Returns stream URLs for all 3 cameras |
| `GET /sync?from_camera=source&from_time=10.5` | Returns synchronized positions across all cameras |
| `GET /events` | Returns all shot/bounce events with timestamps and clip URLs |
| `GET /status` | Returns current streaming status per camera |
| `GET /clips/{camera}/{filename}` | Serves bounce clip MP4 files |

## Implementation Notes

- **No stream reconnection on switch**: All 3 HLS instances buffer continuously. Camera switching only swaps the visible `<video>` element and seeks using sync API data.
- **Review mode is fully offline**: On entering review, all HLS connections are destroyed. Replay uses blob-based VOD playlists created from already-buffered segment bytes.
- **Rolling buffer**: Last 30 segments (~120s at 4s/segment) kept in memory per camera.
- **Sync accuracy**: Camera positions are mapped using the triple sync table (frame-level accuracy via nanosecond wall-clock timestamps).
- **Event timestamps**: Converted from frame numbers using segment frame index CSVs for precise playback positioning.


## Assumptions

- All cameras assumed to be 30fps
- Segments are roughly 4 seconds each
- Rolling buffer keeps the last 30 segments per camera (~120s of content) in memory
- Bounce clips follow the naming pattern `bounce_{frame}_{shot_id}.mp4`
- The sync accuracy depends on the triple sync CSV which maps frames across cameras using wall-clock nanosecond timestamps
