import { useCallback, useEffect, useState, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import * as tus from 'tus-js-client';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import { VideoPlayer } from './components/VideoPlayer';
import './App.css';

function App() {
  const [videoUrl, setVideoUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [localVideos, setLocalVideos] = useState([]);
  const [loadingLocalVideos, setLoadingLocalVideos] = useState(false);
  const [processingLocalVideo, setProcessingLocalVideo] = useState(false);
  const [showLocalVideos, setShowLocalVideos] = useState(false);
  const videoRef = useRef(null);
  const playerRef = useRef(null);

  // Initialize WebSocket connection
  useEffect(() => {
    let ws = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectInterval = 3000; // 3 seconds
    
    const connectWebSocket = () => {
      ws = new WebSocket('ws://localhost:8000/ws');
      
      ws.onopen = () => {
        console.log('WebSocket connection established');
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('WebSocket message:', data);
        
        switch (data.type) {
          case 'processing-started':
            setProcessing(true);
            break;
          case 'videoProcessed':
          case 'video-processed':
            setProcessing(false);
            setVideoUrl(data.hlsUrl);
            break;
          case 'videoError':
          case 'processing-error':
            setProcessing(false);
            setError(`Processing error: ${data.error}`);
            break;
          case 'upload-progress':
            setProgress(parseFloat(data.progress));
            break;
          case 'localVideoProcessed':
            // Update local videos list with the newly processed video
            setLocalVideos(prev => {
              const exists = prev.some(v => v.filename === data.video.filename);
              if (exists) {
                return prev.map(v => v.filename === data.video.filename ? data.video : v);
              } else {
                return [...prev, data.video];
              }
            });
            setProcessingLocalVideo(false);
            break;
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      ws.onclose = (event) => {
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        
        // Attempt to reconnect if not a normal closure and we haven't exceeded max attempts
        if (event.code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
          setTimeout(connectWebSocket, reconnectInterval);
        }
      };
    };
    
    connectWebSocket();
    
    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, []);

  // Fetch local videos when component mounts
  useEffect(() => {
    const fetchLocalVideos = async () => {
      try {
        setLoadingLocalVideos(true);
        const response = await fetch('http://localhost:8000/api/local-videos');
        if (!response.ok) {
          throw new Error(`Failed to fetch local videos: ${response.statusText}`);
        }
        const data = await response.json();
        setLocalVideos(data);
      } catch (error) {
        console.error('Error fetching local videos:', error);
        setError(`Failed to load local videos: ${error.message}`);
      } finally {
        setLoadingLocalVideos(false);
      }
    };

    fetchLocalVideos();
  }, []);

  // Process a local video
  const handleProcessLocalVideo = async (filename) => {
    try {
      setProcessingLocalVideo(true);
      setError(null);
      
      const response = await fetch('http://localhost:8000/api/local-videos/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filename })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to process video');
      }
      
      const videoInfo = await response.json();
      
      // Update the local videos list
      setLocalVideos(prev => 
        prev.map(video => 
          video.filename === filename ? { ...videoInfo, processed: true } : video
        )
      );
      
      // Set the video URL to play the processed video
      setVideoUrl(videoInfo.hlsUrl);
      
    } catch (error) {
      console.error('Error processing local video:', error);
      setError(`Failed to process video: ${error.message}`);
    } finally {
      setProcessingLocalVideo(false);
    }
  };

  // Play a processed local video
  const handlePlayLocalVideo = (video) => {
    setVideoUrl(video.hlsUrl);
  };

  const handleUpload = useCallback((file) => {
    if (!file) return;

    setUploading(true);
    setError(null);
    setProgress(0);

    // Create a new tus upload
    const upload = new tus.Upload(file, {
      endpoint: 'http://localhost:8000/uploads',
      retryDelays: [0, 1000, 3000],
      chunkSize: 512 * 1024, // 512KB chunks
      metadata: {
        filename: file.name,
        filetype: file.type
      },
      onBeforeRequest: function(req) {
        console.log(`Upload ${req.getMethod()} request to ${req.getURL()}`);
      },
      onAfterResponse: function(req, res) {
        const status = res.getStatus();
        if (status >= 400) {
          console.error('Upload failed:', status);
          setError(`Upload failed with status ${status}`);
          setUploading(false);
        }
      },
      onError: function(error) {
        console.error('Upload error:', error);
        setError(`Upload failed: ${error.message || 'Unknown error'}`);
        setUploading(false);
      },
      onProgress: function(bytesUploaded, bytesTotal) {
        const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
        setProgress(percentage);
        console.log(`Upload progress: ${percentage}% (${bytesUploaded}/${bytesTotal} bytes)`);
      },
      onSuccess: function() {
        const uploadUrl = upload.url;
        console.log('%%% TUS Success: Upload reported complete by tus-js-client. URL:', uploadUrl);
        setProgress(100);
        setUploading(false);
        setProcessing(true);
        setError('Video uploaded successfully! Processing...');
      }
    });

    // Start the upload
    upload.start();
  }, []);

  const onDrop = useCallback((acceptedFiles) => {
    if (acceptedFiles && acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      
      // Validate file size (max 10GB)
      if (file.size > 10 * 1024 * 1024 * 1024) {
        setError('File size too large. Maximum size is 10GB.');
        return;
      }

      // Validate file type
      if (!file.type.startsWith('video/')) {
        setError('Please upload a video file.');
        return;
      }

      handleUpload(file);
    }
  }, [handleUpload]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': [] },
    maxFiles: 1
  });

  // Initialize video.js player
  useEffect(() => {
    if (videoRef.current) {
      // Initialize player regardless of whether we have a URL yet
      if (playerRef.current) {
        playerRef.current.dispose();
      }

      playerRef.current = videojs(videoRef.current, {
        controls: true,
        fluid: true,
        html5: {
          vhs: {
            enableLowInitialPlaylist: true,
            smoothQualityChange: true,
            overrideNative: true
          }
        }
      });

      // Only set source if we have a URL
      if (videoUrl) {
        const fullUrl = videoUrl.startsWith('http') 
          ? videoUrl 
          : `http://localhost:8000${videoUrl}`;
          
        console.log('Setting video source to:', fullUrl);
        
        playerRef.current.src({
          src: fullUrl,
          type: 'application/x-mpegURL'
        });
      }

      return () => {
        if (playerRef.current) {
          playerRef.current.dispose();
        }
      };
    }
  }, [videoRef, videoUrl]);

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <h1 className="text-3xl font-bold text-center mb-8">Video Processing System</h1>
        
        {/* Error display */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}
        
        {/* Tabs for Upload and Local Videos */}
        <div className="mb-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex">
              <button 
                className={`py-2 px-4 border-b-2 ${!showLocalVideos ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                onClick={() => setShowLocalVideos(false)}
              >
                Upload Video
              </button>
              <button 
                className={`py-2 px-4 border-b-2 ${showLocalVideos ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                onClick={() => setShowLocalVideos(true)}
              >
                Local Videos
              </button>
            </nav>
          </div>
        </div>
        
        {!showLocalVideos ? (
          <div className="bg-white rounded-lg shadow-md p-6 mb-8">
            <div className="upload-container">
              {uploading && (
                <div className="mb-4">
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full transition-all" 
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                  <p className="text-center mt-2 text-sm text-gray-600">
                    Uploading: {progress}%
                  </p>
                </div>
              )}
              
              {processing && (
                <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded mb-4">
                  Video processing in progress. The player will load automatically when ready.
                </div>
              )}
              
              {!uploading && !processing && (
                <div 
                  {...getRootProps()} 
                  className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <input {...getInputProps()} />
                  <p className="text-gray-600">Drag & drop video files here, or click to select</p>
                  <p className="text-sm text-gray-500 mt-2">Supports video files up to 10GB</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-md p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">Local Videos</h2>
            
            {loadingLocalVideos ? (
              <div className="flex justify-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
              </div>
            ) : localVideos.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No local videos found in the server uploads directory.</p>
            ) : (
              <div className="space-y-4">
                {localVideos.map((video, index) => (
                  <div key={index} className="border rounded-lg p-4 flex justify-between items-center">
                    <div>
                      <p className="font-medium">{video.filename}</p>
                      <p className="text-sm text-gray-500">
                        {video.processed ? 'Processed' : 'Not processed'}
                      </p>
                    </div>
                    <div>
                      {video.processed ? (
                        <button
                          onClick={() => handlePlayLocalVideo(video)}
                          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors"
                        >
                          Play
                        </button>
                      ) : (
                        <button
                          onClick={() => handleProcessLocalVideo(video.filename)}
                          disabled={processingLocalVideo}
                          className={`${
                            processingLocalVideo
                              ? 'bg-gray-400 cursor-not-allowed'
                              : 'bg-green-500 hover:bg-green-600'
                          } text-white px-4 py-2 rounded transition-colors`}
                        >
                          {processingLocalVideo ? 'Processing...' : 'Process'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(videoUrl || processing) && (
          <div className="mt-6">
            <div data-vjs-player className="relative">
              <video
                ref={videoRef}
                className="video-js vjs-big-play-centered"
                width="640"
                height="360"
              />
              {processing && !videoUrl && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50">
                  <div className="text-center">
                    <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
                    <p className="text-white mt-2">Processing video...</p>
                    <p className="text-white text-sm mt-1">This may take a few minutes depending on file size</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
