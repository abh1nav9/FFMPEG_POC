import React, { useEffect, useRef } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import axios from 'axios';

const VideoJsPlayer: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
    // Clean up previous player instance if it exists
    if (playerRef.current) {
      playerRef.current.dispose();
      playerRef.current = null;
    }

    // Only initialize Video.js once a valid video URL is available
    if (!videoUrl) return;

    // Short timeout to ensure the DOM is fully rendered
    const timeoutId = setTimeout(() => {
      if (containerRef.current && videoRef.current) {
        console.log('Initializing Video.js with URL:', videoUrl);

        const isHLS = videoUrl.endsWith('.m3u8');
        const options = {
          autoplay: false,
          controls: true,
          responsive: true,
          fluid: true,
          html5: {
            vhs: {
              overrideNative: true,
              withCredentials: false,
              useBandwidthFromLocalStorage: true,
            },
            nativeAudioTracks: false,
            nativeVideoTracks: false,
          },
          sources: [{
            src: videoUrl,
            type: isHLS ? 'application/x-mpegURL' : 'video/mp4'
          }]
        };

        try {
          const player = videojs(videoRef.current, options);

          player.on('ready', () => {
            console.log('Video.js player is ready');
            setLoading(false);
          });

          player.on('loadedmetadata', () => {
            console.log('Metadata loaded');
          });

          player.on('error', () => {
            const errorInfo = player.error();
            console.error('Video.js player error:', errorInfo);
            setError(`Video error: ${errorInfo?.code || 'unknown'} - ${errorInfo?.message || 'Unknown error'}`);
            setLoading(false);
          });

          player.on('loadeddata', () => {
            console.log('Video data loaded');
          });

          playerRef.current = player;
        } catch (err) {
          console.error('Error initializing video player:', err);
          setError('Failed to initialize video player');
          setLoading(false);
        }
      } else {
        console.error('Video container or element not found in DOM');
        setError('Video element not found in DOM');
        setLoading(false);
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [videoUrl]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-gray-100">
      <h1 className="text-3xl font-bold mb-6">📺 VideoJS Player Demo</h1>
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
        <p className="mt-4 text-gray-500">Loading video, please wait...</p>
      )}

      <div className="mt-6 w-full max-w-4xl">
        <div key={videoUrl || 'no-video'} ref={containerRef} data-vjs-player>
          <video
            ref={videoRef}
            className="video-js vjs-big-play-centered"
            controls
            preload="auto"
            width="640"
            height="360"
          />
        </div>
      </div>
    </div>
  );
};

export default VideoJsPlayer;
