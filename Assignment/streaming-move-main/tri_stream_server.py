#!/usr/bin/env python3
"""
Triple-Camera Live HLS Stream Server
=====================================
Serves synchronized HLS streams for SOURCE, SINK, and HQ cameras.
Provides sync, events, and status APIs for the frontend review system.
"""

import os
import io
import csv
import json
import time
import shutil
import threading
import argparse
from bisect import bisect_right
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import re

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSIGNMENT_DIR = os.path.dirname(BASE_DIR)

CAMERA_CONFIGS = {
    "source": {
        "ts_dir": os.path.join(ASSIGNMENT_DIR, "sync_reports", "ts_segments_source", "1645"),
        "frame_index": os.path.join(ASSIGNMENT_DIR, "test_work", "cv_output", "reader", "source", "hls_segment_frame_index.csv"),
        "port": 8081,
    },
    "sink": {
        "ts_dir": os.path.join(ASSIGNMENT_DIR, "sync_reports", "ts_segments_sink", "1645"),
        "frame_index": os.path.join(ASSIGNMENT_DIR, "test_work", "cv_output", "reader", "sink", "hls_segment_frame_index.csv"),
        "port": 8082,
    },
    "hq": {
        "ts_dir": os.path.join(ASSIGNMENT_DIR, "sync_reports", "ts_segments_hq", "1645"),
        "frame_index": os.path.join(ASSIGNMENT_DIR, "test_work", "cv_output", "reader", "hq", "hls_segment_frame_index.csv"),
        "port": 8083,
    },
}

SYNC_CSV = os.path.join(ASSIGNMENT_DIR, "sync_reports", "segments_1645", "sync", "hls_sync_1645_triple.csv")
SHOTS_CSV = os.path.join(ASSIGNMENT_DIR, "test_work", "cv_output", "correlation", "flight_shots.csv")
BOUNCE_DIR = os.path.join(ASSIGNMENT_DIR, "bounce_clips_share")

API_PORT = 8080
WINDOW_SIZE = 30
FPS = 30  # assumed frame rate for all cameras

# ── Data Loading ───────────────────────────────────────────────────────────────

def parse_playlist(path):
    """Return list of (duration_float, segment_filename)."""
    segments = []
    with open(path) as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        if lines[i].startswith("#EXTINF:"):
            duration = float(lines[i].split(":")[1].rstrip(","))
            seg = lines[i + 1].strip()
            segments.append((duration, seg))
            i += 2
        else:
            i += 1
    return segments


def load_frame_index(csv_path):
    """Load segment frame index CSV → list of dicts."""
    rows = []
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "segment_index": int(row["segment_index"]),
                "seg_basename": row["seg_basename"].strip(),
                "cumulative_start_frame": int(row["cumulative_start_frame"]),
                "frame_count": int(row["frame_count"]),
            })
    return rows


def load_sync_table(csv_path):
    """Load triple sync CSV → list of dicts with frame indices."""
    rows = []
    with open(csv_path) as f:
        content = f.read().replace('\r\n', '\n').replace('\r', '\n')
    reader = csv.DictReader(io.StringIO(content))
    reader.fieldnames = [h.strip() for h in reader.fieldnames]

    for row in reader:
        try:
            row = {k.strip(): v.strip() if isinstance(v, str) else v for k, v in row.items()}
            rows.append({
                "source_idx": int(row["Source_Index"]),
                "sink_idx": int(row["Sink_Index"]),
                "hq_idx": int(row["HQ_Index"]),
                "source_wall_ns": int(row["Source_Wall_ns"]),
                "hq_wall_ns": int(row["HQ_Wall_ns"]),
                "status": row.get("TripleStatus", "").strip(),
            })
        except (ValueError, KeyError):
            continue
    return rows


def load_shots(csv_path):
    """Load flight_shots.csv → list of shot dicts."""
    shots = []
    with open(csv_path) as f:
        content = f.read().replace('\r\n', '\n').replace('\r', '\n')
    reader = csv.DictReader(io.StringIO(content))
    # Normalize header keys
    reader.fieldnames = [h.strip().replace('\n', '') for h in reader.fieldnames]

    for row in reader:
        try:
            # Normalize keys in each row
            row = {k.strip().replace('\n', ''): v.strip() if isinstance(v, str) else v for k, v in row.items()}
            shot = {
                "flight_id": int(row.get("flight_id", 0)),
                "start_frame": int(row.get("start_frame", 0)),
                "end_frame": int(row.get("end_frame", 0)),
                "counts_as_shot": row.get("counts_as_shot", "0").strip() == "1",
                "shot_id": int(row.get("shot_id", 0)),
                "bounce_frame": int(row["bounce_frame"]) if row.get("bounce_frame") and row["bounce_frame"].strip() else None,
                "bounce_x": float(row["bounce_x"]) if row.get("bounce_x") and row["bounce_x"].strip() else None,
                "bounce_y": float(row["bounce_y"]) if row.get("bounce_y") and row["bounce_y"].strip() else None,
                "bounce_z": float(row["bounce_z"]) if row.get("bounce_z") and row["bounce_z"].strip() else None,
                "bounce_hq_frame": int(row["bounce_hq_frame"]) if row.get("bounce_hq_frame") and row["bounce_hq_frame"].strip() else None,
                "landing_x": float(row["landing_x"]) if row.get("landing_x") and row["landing_x"].strip() else None,
                "landing_y": float(row["landing_y"]) if row.get("landing_y") and row["landing_y"].strip() else None,
            }
            shots.append(shot)
        except (ValueError, KeyError) as e:
            continue
    return shots


# ── Frame → Playback Position Conversion ───────────────────────────────────────

class CameraData:
    """Holds all precomputed data for one camera."""

    def __init__(self, name, config):
        self.name = name
        self.ts_dir = config["ts_dir"]
        self.port = config["port"]
        playlist_path = os.path.join(self.ts_dir, "playlist.m3u8")

        self.segments = parse_playlist(playlist_path)
        self.frame_index = load_frame_index(config["frame_index"])

        # Build cumulative time offset for each segment
        self.seg_time_offsets = []  # seg_index → start_time_seconds
        t = 0.0
        for dur, _ in self.segments:
            self.seg_time_offsets.append(t)
            t += dur
        self.total_duration = t

        # Frame → (segment_index, offset_within_segment_seconds)
        self.frame_to_seg = {}
        for entry in self.frame_index:
            seg_idx = entry["segment_index"]
            if seg_idx < len(self.segments):
                seg_dur = self.segments[seg_idx][0]
                frame_count = entry["frame_count"]
                for f in range(entry["cumulative_start_frame"],
                               entry["cumulative_start_frame"] + frame_count):
                    frame_offset = f - entry["cumulative_start_frame"]
                    time_in_seg = (frame_offset / frame_count) * seg_dur if frame_count > 0 else 0
                    self.frame_to_seg[f] = (seg_idx, time_in_seg)

    def frame_to_time(self, frame):
        """Convert frame number to playback time in seconds."""
        if frame in self.frame_to_seg:
            seg_idx, time_in_seg = self.frame_to_seg[frame]
            return self.seg_time_offsets[seg_idx] + time_in_seg

        # Fallback: estimate from FPS
        return frame / FPS

    def seg_to_time(self, seg_idx):
        """Get start time of a segment."""
        if 0 <= seg_idx < len(self.seg_time_offsets):
            return self.seg_time_offsets[seg_idx]
        return 0.0


# ── Stream Simulator ──────────────────────────────────────────────────────────

class StreamSimulator:
    """Runs a circular HLS live stream for one camera."""

    def __init__(self, camera_data, serve_dir, speed=1.0):
        self.camera = camera_data
        self.serve_dir = serve_dir
        self.speed = speed
        self.current_index = 0
        self.media_sequence = 0
        self.released = []
        self.lock = threading.Lock()

    def get_status(self):
        with self.lock:
            return {
                "current_segment": self.current_index,
                "media_sequence": self.media_sequence,
                "total_segments": len(self.camera.segments),
                "released_count": len(self.released),
            }

    def write_playlist(self, done=False):
        window = self.released[-WINDOW_SIZE:]
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:6",
            f"#EXT-X-MEDIA-SEQUENCE:{self.media_sequence}",
        ]
        for duration, name in window:
            lines.append(f"#EXTINF:{duration:.6f},")
            lines.append(name)
        if done:
            lines.append("#EXT-X-ENDLIST")
        playlist_path = os.path.join(self.serve_dir, "live.m3u8")
        with open(playlist_path, "w") as f:
            f.write("\n".join(lines) + "\n")

    def stream_loop(self):
        """Continuously loop through segments, simulating live."""
        segments = self.camera.segments
        total = len(segments)
        if total == 0:
            return

        while True:
            for i, (duration, name) in enumerate(segments):
                with self.lock:
                    self.current_index = i
                    self.released.append((duration, name))

                # Copy segment file
                src = os.path.join(self.camera.ts_dir, name)
                dst = os.path.join(self.serve_dir, name)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)

                with self.lock:
                    if len(self.released) > WINDOW_SIZE:
                        self.media_sequence += 1

                self.write_playlist(done=False)
                time.sleep(duration / self.speed)

            # Loop: don't add ENDLIST, just restart


# ── HTTP Handlers ──────────────────────────────────────────────────────────────

def make_stream_handler(serve_dir):
    """Create an HTTP handler that serves from a specific directory."""
    class StreamHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=serve_dir, **kwargs)

        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Cache-Control", "no-cache, no-store")
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt, *args):
            pass  # suppress logs

    return StreamHandler


class APIHandler(SimpleHTTPRequestHandler):
    """Handles API requests and serves bounce clips."""

    cameras = {}        # set by main()
    sync_table = []
    shots = []
    events = []
    simulators = {}

    def __init__(self, *args, **kwargs):
        self._bounce_dir = BOUNCE_DIR
        super().__init__(*args, directory=BOUNCE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-cache, no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/cameras":
            self._json_response(self._handle_cameras())
        elif path == "/sync":
            self._json_response(self._handle_sync(params))
        elif path == "/events":
            self._json_response(self._handle_events())
        elif path == "/status":
            self._json_response(self._handle_status())
        elif path.startswith("/clips/"):
            self._serve_clip(path)
        else:
            self.send_error(404, "Not Found")

    def _json_response(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_cameras(self):
        result = {}
        for name, cam in self.cameras.items():
            result[name] = f"http://localhost:{cam.port}/live.m3u8"
        return result

    def _handle_sync(self, params):
        from_camera = params.get("from_camera", [None])[0]
        from_seg = params.get("from_seg", [None])[0]
        from_time = params.get("from_time", [None])[0]

        if not from_camera:
            return {"error": "from_camera required"}

        result = {}
        cam = self.cameras.get(from_camera)
        if not cam:
            return {"error": f"unknown camera: {from_camera}"}

        if from_seg is not None:
            from_seg = int(from_seg)
            # Find the frame range for this segment
            source_time = cam.seg_to_time(from_seg)

            # Use sync table to find matching positions
            # Find closest frame in the source camera for this segment time
            source_frame = int(source_time * FPS)

            result = self._find_sync_positions(from_camera, source_frame)
            result["from_camera"] = from_camera
            result["from_segment"] = from_seg
            result["from_time"] = source_time

        elif from_time is not None:
            from_time = float(from_time)
            source_frame = int(from_time * FPS)
            result = self._find_sync_positions(from_camera, source_frame)
            result["from_camera"] = from_camera
            result["from_time"] = from_time

        return result

    def _find_sync_positions(self, from_camera, frame):
        """Find matching positions in all cameras using binary search O(log n)."""
        result = {}
        key_map = {
            "source": "source_idx",
            "sink": "sink_idx",
            "hq": "hq_idx",
        }

        from_key = key_map.get(from_camera)
        if not from_key:
            return {"error": "invalid camera"}

        if not self.sync_table:
            return {"error": "no sync data"}

        # Binary search for nearest matching frame in sync table
        frames = [row[from_key] for row in self.sync_table]
        idx = bisect_right(frames, frame)
        # Check the two candidates (idx-1 and idx) for closest match
        candidates = []
        if idx > 0:
            candidates.append(idx - 1)
        if idx < len(self.sync_table):
            candidates.append(idx)

        best_idx = min(candidates, key=lambda i: abs(frames[i] - frame))
        best_row = self.sync_table[best_idx]

        for cam_name, cam_data in self.cameras.items():
            cam_key = key_map[cam_name]
            cam_frame = best_row[cam_key]
            cam_time = cam_data.frame_to_time(cam_frame)

            # Binary search for segment index
            seg_idx = bisect_right(cam_data.seg_time_offsets, cam_time) - 1
            seg_idx = max(0, seg_idx)

            result[cam_name] = {
                "frame": cam_frame,
                "time": round(cam_time, 4),
                "segment": seg_idx,
            }

        return result

    def _handle_events(self):
        return self.events

    def _handle_status(self):
        status = {}
        for name, sim in self.simulators.items():
            status[name] = sim.get_status()
        return status

    def _serve_clip(self, path):
        """Serve bounce clips: /clips/{camera}/{filename}"""
        parts = path.strip("/").split("/")
        if len(parts) < 3:
            self.send_error(404, "Not Found")
            return

        camera = parts[1]
        filename = "/".join(parts[2:])
        filepath = os.path.join(BOUNCE_DIR, camera, filename)

        if not os.path.isfile(filepath):
            self.send_error(404, f"Clip not found: {filepath}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(os.path.getsize(filepath)))
        self.end_headers()
        with open(filepath, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def log_message(self, fmt, *args):
        pass


# ── Event Builder ──────────────────────────────────────────────────────────────

def build_events(shots, cameras):
    """Convert shots into frontend-ready event objects with per-camera timestamps."""
    events = []
    for shot in shots:
        bounce_frame = shot.get("bounce_frame")
        if bounce_frame is None:
            continue

        event = {
            "shot_id": shot["shot_id"],
            "flight_id": shot["flight_id"],
            "counts_as_shot": shot["counts_as_shot"],
            "bounce_frame": bounce_frame,
            "bounce_x": shot.get("bounce_x"),
            "bounce_y": shot.get("bounce_y"),
            "bounce_z": shot.get("bounce_z"),
            "start_frame": shot["start_frame"],
            "end_frame": shot["end_frame"],
            "timestamps": {},
            "clips": {},
        }

        # Per-camera timestamps
        for cam_name, cam_data in cameras.items():
            # Get playback time for bounce frame in this camera
            if cam_name == "hq" and shot.get("bounce_hq_frame") is not None:
                t = cam_data.frame_to_time(shot["bounce_hq_frame"])
            else:
                t = cam_data.frame_to_time(bounce_frame)
            event["timestamps"][cam_name] = round(t, 4)

        # Bounce clips
        for cam_name in ["source", "sink", "hq"]:
            clip_name = f"bounce_{bounce_frame}_{shot['shot_id']:05d}.mp4"
            clip_path = os.path.join(BOUNCE_DIR, cam_name, clip_name)
            if os.path.isfile(clip_path):
                event["clips"][cam_name] = f"http://localhost:{API_PORT}/clips/{cam_name}/{clip_name}"
            else:
                # Try alternative naming formats
                alt_name = f"bounce_{bounce_frame}_{shot['shot_id']}.mp4"
                alt_path = os.path.join(BOUNCE_DIR, cam_name, alt_name)
                if os.path.isfile(alt_path):
                    event["clips"][cam_name] = f"http://localhost:{API_PORT}/clips/{cam_name}/{alt_name}"

        events.append(event)

    # Sort by source timestamp
    events.sort(key=lambda e: e["timestamps"].get("source", 0))
    return events


# ── Find bounce clips by matching pattern ──────────────────────────────────────

def discover_bounce_clips(shots):
    """Match bounce clips from the filesystem to shots."""
    clip_map = {}  # (camera, shot_id) → filename

    for cam in ["source", "sink", "hq"]:
        clip_dir = os.path.join(BOUNCE_DIR, cam)
        if not os.path.isdir(clip_dir):
            continue
        for fname in os.listdir(clip_dir):
            if not fname.endswith(".mp4"):
                continue
            # Parse bounce_{frame}_{shot_id}.mp4
            match = re.match(r"bounce_(\d+)_(\d+)\.mp4", fname)
            if match:
                frame = int(match.group(1))
                sid = int(match.group(2))
                clip_map[(cam, sid)] = fname

    return clip_map


def build_events_v2(shots, cameras, clip_map):
    """Build events with discovered clip mapping."""
    events = []
    for shot in shots:
        bounce_frame = shot.get("bounce_frame")
        shot_id = shot["shot_id"]

        event = {
            "shot_id": shot_id,
            "flight_id": shot["flight_id"],
            "counts_as_shot": shot["counts_as_shot"],
            "bounce_frame": bounce_frame,
            "bounce_x": shot.get("bounce_x"),
            "bounce_y": shot.get("bounce_y"),
            "bounce_z": shot.get("bounce_z"),
            "start_frame": shot["start_frame"],
            "end_frame": shot["end_frame"],
            "timestamps": {},
            "clips": {},
        }

        for cam_name, cam_data in cameras.items():
            if cam_name == "hq" and shot.get("bounce_hq_frame") is not None:
                frame = shot["bounce_hq_frame"]
            elif bounce_frame is not None:
                frame = bounce_frame
            else:
                frame = shot["start_frame"]
            t = cam_data.frame_to_time(frame)
            event["timestamps"][cam_name] = round(t, 4)

        for cam_name in ["source", "sink", "hq"]:
            key = (cam_name, shot_id)
            if key in clip_map:
                fname = clip_map[key]
                event["clips"][cam_name] = f"http://localhost:{API_PORT}/clips/{cam_name}/{fname}"

        events.append(event)

    events.sort(key=lambda e: e["timestamps"].get("source", 0))
    return events


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    global WINDOW_SIZE

    parser = argparse.ArgumentParser(description="Triple-Camera HLS Stream Server")
    parser.add_argument("--speed", type=float, default=4.0,
                        help="Speed multiplier for streaming (default: 4x)")
    parser.add_argument("--window", type=int, default=WINDOW_SIZE,
                        help="Sliding window size")
    parser.add_argument("--api-port", type=int, default=API_PORT)
    args = parser.parse_args()

    WINDOW_SIZE = args.window

    print("╔══════════════════════════════════════════════════════════════╗")
    print("║          Triple-Camera Live Review System Server            ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()

    # 1. Load data
    print("Loading data...")
    cameras = {}
    for name, config in CAMERA_CONFIGS.items():
        cameras[name] = CameraData(name, config)
        print(f"  ✓ {name}: {len(cameras[name].segments)} segments, "
              f"{cameras[name].total_duration:.1f}s total")

    sync_table = load_sync_table(SYNC_CSV)
    print(f"  ✓ Sync table: {len(sync_table)} entries")

    shots = load_shots(SHOTS_CSV)
    print(f"  ✓ Shots: {len(shots)} events")

    clip_map = discover_bounce_clips(shots)
    print(f"  ✓ Bounce clips: {len(clip_map)} files mapped")

    events = build_events_v2(shots, cameras, clip_map)
    print(f"  ✓ Events built: {len(events)} with timestamps")

    # 2. Prepare serve directories and simulators
    simulators = {}
    for name, cam in cameras.items():
        serve_dir = os.path.join(BASE_DIR, f"serve_{name}")
        if os.path.exists(serve_dir):
            shutil.rmtree(serve_dir)
        os.makedirs(serve_dir)

        sim = StreamSimulator(cam, serve_dir, speed=args.speed)
        simulators[name] = sim

        # Write initial empty playlist
        sim.write_playlist()

    # 3. Set up API handler class attrs
    APIHandler.cameras = cameras
    APIHandler.sync_table = sync_table
    APIHandler.shots = shots
    APIHandler.events = events
    APIHandler.simulators = simulators

    # 4. Start stream servers
    print()
    print("Starting stream servers...")
    for name, cam in cameras.items():
        serve_dir = os.path.join(BASE_DIR, f"serve_{name}")
        handler = make_stream_handler(serve_dir)
        server = HTTPServer(("", cam.port), handler)

        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()

        # Start the stream loop
        sim = simulators[name]
        st = threading.Thread(target=sim.stream_loop, daemon=True)
        st.start()

        print(f"  ✓ {name.upper():8s} → http://localhost:{cam.port}/live.m3u8")

    # 5. Start API server
    api_server = HTTPServer(("", args.api_port), APIHandler)
    api_thread = threading.Thread(target=api_server.serve_forever, daemon=True)
    api_thread.start()

    print(f"\n  ✓ API Server → http://localhost:{args.api_port}")
    print(f"    GET /cameras")
    print(f"    GET /sync?from_camera=source&from_time=10.5")
    print(f"    GET /events")
    print(f"    GET /status")
    print(f"    GET /clips/{{camera}}/{{filename}}")
    print(f"\n  Speed: {args.speed}x  |  Window: {WINDOW_SIZE} segments")
    print(f"\n  Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
