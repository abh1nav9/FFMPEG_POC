import React, { useRef, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import Hls from 'hls.js';
import axios from 'axios';
import VideoJsPlayer from './VideoJsPlayer';

const HlsPlayer: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const handleLoadVideo = async () => {
    setLoading(true);
    setError(null);
    setVideoUrl(null);

    try {
      console.log('Fetching video URL...');
      const res = await axios.get('http://localhost:5000/api/get_video');
      if (res.data.error) {
        throw new Error(res.data.error);
      }
      const url = res.data.video_url;
      console.log('Got URL:', url);
      setVideoUrl(url);
    } catch (e: any) {
      console.error('Error:', e);
      setError(e.message || 'Failed to load video');
      setLoading(false);
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;

    // Clean up previous HLS instance, if any
    if (hlsRef.current) {
      console.log('Cleaning up old HLS instance');
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    console.log('Setting up HLS player for:', videoUrl);

    if (Hls.isSupported()) {
      // Do not specify live sync options so that we can force starting at position 0
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30
      });
      hlsRef.current = hls;

      hls.loadSource(videoUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('Manifest loaded; forcing playback from the beginning');
        // Force the player to start loading from the beginning (fragment 0)
        hls.startLoad(0);
        // Also reset the video element's current time
        video.currentTime = 0;
        setLoading(false);
        video.play().catch((err) => console.error('Playback failed:', err));
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data);
        if (data.fatal) {
          setError(`Streaming error: ${data.type} - ${data.details}`);
          setLoading(false);
          hls.destroy();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // For browsers that support HLS natively (e.g., Safari)
      video.src = videoUrl;
      video.addEventListener('loadedmetadata', () => {
        console.log('Metadata loaded; starting playback from beginning');
        video.currentTime = 0;
        setLoading(false);
        video.play().catch((err) => console.error('Playback failed:', err));
      });
      video.addEventListener('error', () => {
        setError('Video playback failed');
        setLoading(false);
      });
    } else {
      setError('HLS streaming is not supported in this browser');
      setLoading(false);
    }

    // Cleanup effect on unmount or videoUrl change
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (video) {
        video.src = '';
      }
    };
  }, [videoUrl]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gray-100">
      <h1 className="text-3xl font-bold mb-6">📺 HLS Streaming Demo</h1>
      <button
        onClick={handleLoadVideo}
        disabled={loading}
        className={`px-4 py-2 rounded-md text-white ${
          loading ? 'bg-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {loading ? 'Loading...' : 'Load Video'}
      </button>

      {error && (
        <p className="mt-4 text-red-500">
          {error}
          {error.includes('not ready') && (
            <span>
              {" "}
              <button
                onClick={handleLoadVideo}
                className="underline text-blue-500"
              >
                Try again
              </button>
            </span>
          )}
        </p>
      )}
      {loading && !error && (
        <p className="mt-4 text-gray-500">
          Generating video stream, please wait...
        </p>
      )}

      {videoUrl && (
        <div className="mt-6 w-full max-w-4xl">
          <video
            ref={videoRef}
            controls
            className="w-full rounded shadow-lg"
            style={{ maxHeight: '70vh' }}
          />
        </div>
      )}
    </div>
  );
};

const Navigation: React.FC = () => {
  return (
    <nav className="bg-blue-600 text-white p-4">
      <div className="container mx-auto flex justify-between">
        <span className="font-bold text-xl">Video Player Demo</span>
        <ul className="flex space-x-4">
          <li>
            <Link to="/" className="hover:underline">
              HLS Player
            </Link>
          </li>
          <li>
            <Link to="/videojs" className="hover:underline">
              VideoJS Player
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <div className="flex flex-col min-h-screen">
        <Navigation />
        <Routes>
          <Route path="/" element={<HlsPlayer />} />
          <Route path="/videojs" element={<VideoJsPlayer />} />
        </Routes>
      </div>
    </Router>
  );
};

export default App;
