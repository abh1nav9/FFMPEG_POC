from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import os
import subprocess
import threading
import logging
import time

app = Flask(__name__)
CORS(app)

# Set up logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), 'uploads')
STREAMS_DIR = os.path.join(os.path.dirname(__file__), 'streams')

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(STREAMS_DIR, exist_ok=True)

def get_video_file():
    """
    Searches the uploads folder for a video file with an allowed extension.
    Returns the full path of the first found video file, or None if none exist.
    """
    allowed_extensions = ('.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.mpeg', '.mpg')
    for file in os.listdir(UPLOADS_DIR):
        if file.lower().endswith(allowed_extensions):
            return os.path.join(UPLOADS_DIR, file)
    return None

def convert_to_hls():
    """
    Detects a video file in UPLOADS_DIR, creates an output folder based on
    the video's base name, and uses FFmpeg to convert the video to an HLS stream.
    The FFmpeg command is configured in event mode with packet flushing so that
    segments and an m3u8 playlist are updated progressively.
    Returns the URL path to the playlist if successful.
    """
    video_path = get_video_file()
    if not video_path:
        logger.error("No video file found in uploads folder")
        return None
    
    # Use the video's basename (without extension) as the stream folder name
    base_filename = os.path.splitext(os.path.basename(video_path))[0]
    stream_output_dir = os.path.join(STREAMS_DIR, base_filename)
    os.makedirs(stream_output_dir, exist_ok=True)

    m3u8_path = os.path.join(stream_output_dir, 'playlist.m3u8')

    # Log paths for debugging
    logger.debug(f"Video path: {video_path}")
    logger.debug(f"Stream output dir: {stream_output_dir}")
    logger.debug(f"M3U8 path: {m3u8_path}")

    # Clear any old segments in the output folder
    for file in os.listdir(stream_output_dir):
        file_path = os.path.join(stream_output_dir, file)
        try:
            os.remove(file_path)
        except Exception as e:
            logger.error(f"Error removing file {file_path}: {str(e)}")

    # FFmpeg command using event mode and flush packets for progressive output
    ffmpeg_cmd = [
        'ffmpeg',
        '-fflags', '+flush_packets',          # Ensure packets are flushed to disk
        '-i', video_path,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-b:v', '800k',
        '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_playlist_type', 'event',         # Use event mode so the playlist updates continuously
        '-hls_list_size', '0',
        '-hls_segment_filename', os.path.join(stream_output_dir, 'segment_%03d.ts'),
        m3u8_path
    ]

    logger.debug(f"Starting FFmpeg: {' '.join(ffmpeg_cmd)}")
    try:
        process = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True
        )

        def log_ffmpeg_output(proc):
            while proc.poll() is None:
                line = proc.stderr.readline()
                if line:
                    logger.debug(f"FFmpeg: {line.strip()}")
            # Capture any remaining output after process ends
            _, stderr = proc.communicate()
            if proc.returncode != 0:
                logger.error(f"FFmpeg failed with code {proc.returncode}: {stderr}")
            else:
                logger.info("FFmpeg completed successfully")

        threading.Thread(target=log_ffmpeg_output, args=(process,), daemon=True).start()

        # Wait until at least the m3u8 file is created and has content
        for _ in range(60):
            if os.path.exists(m3u8_path) and os.path.getsize(m3u8_path) > 0:
                logger.info(f"Playlist updated: {m3u8_path}")
                return f'/streams/{base_filename}/playlist.m3u8'
            time.sleep(1)
        logger.error("Timeout waiting for playlist creation")
        return None
    except Exception as e:
        logger.error(f"FFmpeg setup failed: {str(e)}")
        return None

@app.route('/api/get_video', methods=['GET'])
def get_video():
    """
    Returns the URL for the HLS stream if the playlist file exists,
    otherwise returns an error message.
    """
    video_file = get_video_file()
    if not video_file:
        return jsonify({"error": "No video file found in uploads folder"}), 404
    
    base_filename = os.path.splitext(os.path.basename(video_file))[0]
    hls_path = f'/streams/{base_filename}/playlist.m3u8'
    m3u8_full_path = os.path.join(STREAMS_DIR, base_filename, 'playlist.m3u8')
    if os.path.exists(m3u8_full_path) and os.path.getsize(m3u8_full_path) > 0:
        return jsonify({"video_url": f"http://localhost:5000{hls_path}"})
    else:
        logger.warning("HLS stream not ready")
        return jsonify({"error": "HLS stream not ready yet, please try again in a moment"}), 503

@app.route('/streams/<stream_name>/<path:filename>')
def serve_stream(stream_name, filename):
    """
    Serves files (playlist or TS segments) from the stream output folder.
    """
    logger.debug(f"Serving file: {filename} from stream folder: {stream_name}")
    directory = os.path.join(STREAMS_DIR, stream_name)
    if not os.path.exists(directory):
        logger.error(f"Stream directory not found: {directory}")
        return jsonify({"error": "Stream not found"}), 404
    try:
        return send_from_directory(directory, filename)
    except Exception as e:
        logger.error(f"Error serving file {filename} from {directory}: {str(e)}")
        return jsonify({"error": "File not found"}), 404

def start_hls_conversion():
    """
    Starts the HLS conversion after a short delay to let Flask stabilize.
    """
    time.sleep(2)  # Wait for Flask to stabilize
    logger.info("Initiating HLS conversion")
    try:
        result = convert_to_hls()
        if not result:
            logger.error("Failed to start HLS conversion")
        else:
            logger.info(f"HLS conversion successful: {result}")
    except Exception as e:
        logger.error(f"HLS conversion thread failed: {str(e)}")

if __name__ == '__main__':
    threading.Thread(target=start_hls_conversion, daemon=True).start()
    app.run(host='0.0.0.0', port=5000, debug=False)
