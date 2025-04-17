import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { fileTypeFromFile } from 'file-type';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { WebSocketServer } from 'ws';
import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure directories
const uploadsDir = path.join(__dirname, 'uploads');
const tusUploadDir = path.join(uploadsDir, 'tus-uploads');
const publicDir = path.join(__dirname, 'public');
const videoDir = path.join(publicDir, 'videos');
const hlsDir = path.join(publicDir, 'hls');

// Create directories if they don't exist
const createDirs = async () => {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.mkdir(tusUploadDir, { recursive: true });
    await fs.mkdir(publicDir, { recursive: true });
    await fs.mkdir(videoDir, { recursive: true });
    await fs.mkdir(hlsDir, { recursive: true });
    console.log('%%% SERVER: All directories created successfully');
  } catch (error) {
    console.error('%%% SERVER ERROR: Failed to create directories:', error);
  }
};

// Process video to HLS
const processVideo = async (inputPath, videoId) => {
  const outputDir = path.join(hlsDir, videoId);
  await fs.mkdir(outputDir, { recursive: true });
  
  console.log(`%%% SERVER: Starting HLS conversion for video: ${videoId}`);
  console.log(`%%% SERVER: Input path: ${inputPath}`);
  console.log(`%%% SERVER: Output directory: ${outputDir}`);
  
  try {
    // Create a simple single-quality HLS stream first to ensure basic functionality
    console.log(`%%% SERVER: Creating standard quality HLS stream`);
    
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',          // Video codec
          '-crf 23',               // Constant Rate Factor (quality)
          '-preset fast',          // Encoding speed/compression ratio
          '-c:a aac',              // Audio codec
          '-b:a 128k',             // Audio bitrate
          '-ac 2',                 // Audio channels
          '-hls_time 4',           // HLS segment duration in seconds
          '-hls_list_size 0',      // Keep all segments in the playlist
          '-hls_segment_filename', // Segment filename format
          path.join(outputDir, 'segment_%03d.ts'),
          '-f hls'                 // Format
        ])
        .output(path.join(outputDir, 'playlist.m3u8'))
        .on('start', (commandLine) => {
          console.log(`%%% SERVER: FFMPEG command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          console.log(`%%% SERVER: Processing: ${progress.percent ? progress.percent.toFixed(1) : '0'}% done`);
        })
        .on('end', () => {
          console.log(`%%% SERVER: HLS conversion complete for video: ${videoId}`);
          resolve(videoId);
        })
        .on('error', (err) => {
          console.error(`%%% SERVER ERROR: FFMPEG error: ${err.message}`);
          reject(err);
        })
        .run();
    });
    
    console.log(`%%% SERVER: Successfully created HLS stream for ${videoId}`);
    return videoId;
    
  } catch (error) {
    console.error(`%%% SERVER ERROR: Failed to process video: ${error.message}`);
    throw error;
  }
};

// Make sure directories exist before starting server
await createDirs();

// Check if the TUS uploads directory exists and has proper permissions
try {
  const stats = await fs.stat(tusUploadDir);
  console.log('%%% SERVER: TUS uploads directory exists:', {
    path: tusUploadDir,
    isDirectory: stats.isDirectory(),
    permissions: stats.mode.toString(8)
  });
} catch (error) {
  console.error('%%% SERVER ERROR: TUS uploads directory check failed:', error);
}

const app = express();
const server = createServer(app);

// Increase server timeouts
server.timeout = 0; // Disable timeout
server.keepAliveTimeout = 0; // Disable keep-alive timeout

// Configure Express for large files
app.use(express.json({ limit: '10gb' }));
app.use(express.urlencoded({ extended: true, limit: '10gb' }));

// Configure CORS for Express and TUS
const corsOptions = {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Content-Length',
    'Upload-Length',
    'Upload-Offset',
    'Tus-Resumable',
    'Upload-Metadata',
    'Upload-Concat',
    'Upload-Checksum',
    'Upload-Defer-Length',
    'X-HTTP-Method-Override'
  ],
  exposedHeaders: [
    'Upload-Offset',
    'Location',
    'Upload-Length',
    'Tus-Version',
    'Tus-Resumable',
    'Tus-Max-Size',
    'Tus-Extension',
    'Upload-Metadata',
    'Upload-Defer-Length',
    'Upload-Concat',
    'Location',
    'Content-Type'
  ],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Store WebSocket connections
const clients = new Map();

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    console.log('%%% SERVER: WebSocket upgrade request received');
    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = uuidv4();
      clients.set(clientId, {
        id: clientId,
        ws,
        isAlive: true,
        timestamp: Date.now()
      });

      console.log(`%%% SERVER: WebSocket client connected (ID: ${clientId}), total clients: ${clients.size}`);

      // Setup ping-pong for connection health check
      ws.on('pong', () => {
        const client = clients.get(clientId);
        if (client) {
          client.isAlive = true;
        }
      });

      // Handle client messages
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          console.log(`%%% SERVER: Received message from client ${clientId}:`, data);
          
          // Handle different message types here if needed
        } catch (error) {
          console.error(`%%% SERVER ERROR: Invalid message from client ${clientId}:`, error);
        }
      });

      ws.on('error', (error) => {
        console.error(`%%% SERVER ERROR: WebSocket error for client ${clientId}:`, error);
      });

      ws.on('close', () => {
        console.log(`%%% SERVER: WebSocket client disconnected (ID: ${clientId})`);
        clients.delete(clientId);
      });

      wss.emit('connection', ws, request);
    });
  }
});

// Ping all clients every 30 seconds to keep connections alive
const pingInterval = setInterval(() => {
  clients.forEach((client, id) => {
    if (client.isAlive === false) {
      console.log(`%%% SERVER: Terminating inactive client: ${id}`);
      client.ws.terminate();
      clients.delete(id);
      return;
    }
    
    client.isAlive = false;
    client.ws.ping();
  });
}, 30000);

// Clean up interval on server close
server.on('close', () => {
  clearInterval(pingInterval);
});

// Function to broadcast video URL to all connected clients
const broadcastVideoUrl = (videoUrl, lessonId) => {
  const message = JSON.stringify({
    type: 'video_ready',
    videoUrl,
    lessonId
  });

  clients.forEach((client) => {
    if (client.ws.readyState === 1) { // 1 = WebSocket.OPEN
      client.ws.send(message);
    }
  });
};

// Configure TUS server with simplified options
const tusServer = new Server({
  path: '/uploads',
  datastore: new FileStore({
    directory: tusUploadDir,
    createIfNotExists: true
  })
});

console.log('%%% SERVER: TUS Server instance created:', !!tusServer);

// Modify the handle method once, outside the route handler
const originalHandle = tusServer.handle;
tusServer.handle = function(req, res) {
  console.log('%%% SERVER: Inside TUS handle method, about to process request');
  
  // Call the original handle method
  return originalHandle.call(this, req, res);
};

// Add general error handler for the TUS server
tusServer.on('error', (error) => {
  console.error('%%% SERVER ERROR: TUS Server emitted an error:', error);
});

// Add listeners for all TUS events for debugging
tusServer.on('create', (event) => {
  console.log('%%% SERVER: TUS create event:', event.file.id);
});

tusServer.on('upload-start', (event) => {
  console.log('%%% SERVER: TUS upload-start event:', event.file.id);
});

tusServer.on('upload-complete', (event) => {
  console.log('%%% SERVER: TUS upload-complete event:', event.file.id);
});

// Handle video processing after upload
console.log('%%% SERVER: Attaching upload-finish listener...');
tusServer.on('upload-finish', async (event) => {
  console.log("%%% SERVER: 'upload-finish' event handler EXECUTED! Event data:", event); 
  let videoId;
  try {
    console.log("%%% SERVER: 'upload-finish' event triggered.");
    const { file } = event;
    if (!file || !file.path) {
      console.error("%%% SERVER ERROR: 'upload-finish' event received, but file data is missing:", event);
      return; // Stop processing if file info is bad
    }
    console.log("%%% SERVER: Processing file:", file.path);
    videoId = uuidv4(); // Assign videoId early for error reporting
    const outputDir = path.join(hlsDir, videoId);
    await fs.mkdir(outputDir, { recursive: true });

    // Define quality presets optimized for speed
    const qualities = [
      { name: '360p', height: 360, bitrate: '800k', preset: 'ultrafast' },
      { name: '480p', height: 480, bitrate: '1500k', preset: 'ultrafast' },
      { name: '720p', height: 720, bitrate: '2500k', preset: 'ultrafast' }
    ];

    // Get video dimensions
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file.path, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata);
      });
    });

    const { width, height } = metadata.streams[0];
    const aspectRatio = width / height;

    // Create master playlist
    let masterPlaylist = '#EXTM3U\n#EXT-X-VERSION:3\n';

    // Generate master playlist entries first
    for (const quality of qualities) {
      const targetHeight = Math.min(quality.height, height);
      const targetWidth = Math.round(targetHeight * aspectRatio);
      masterPlaylist += `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(quality.bitrate)}000,RESOLUTION=${targetWidth}x${targetHeight}\n${quality.name}.m3u8\n`;
    }

    // Write the master playlist
    const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');
    await fs.writeFile(masterPlaylistPath, masterPlaylist);
    console.log('Master playlist created:', videoId);

    let processingStartedNotified = false; // Flag to ensure notification is sent only once

    // Process each quality variant sequentially to avoid overload
    for (const quality of qualities) {
      const targetHeight = Math.min(quality.height, height);
      const targetWidth = Math.round(targetHeight * aspectRatio);
      const outputPath = path.join(outputDir, `${quality.name}.m3u8`);
      console.log(`%%% SERVER: Starting processing for ${quality.name} (${videoId})`);

      // Process video for this quality
      const processPromise = new Promise((resolve, reject) => {
        ffmpeg(file.path)
          .outputOptions([
            '-profile:v baseline',
            '-level 3.0',
            '-start_number 0',
            '-hls_time 2', // Reduced from 4 to 2 seconds for faster loading
            '-hls_list_size 0',
            '-hls_segment_size 500000', // ~500KB segments
            '-hls_flags independent_segments',
            '-f hls'
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            console.log(`%%% SERVER: FFMPEG command: ${commandLine}`);
          })
          .on('progress', (progress) => {
            console.log(`%%% SERVER: Processing: ${progress.percent ? progress.percent.toFixed(1) : '0'}% done`);
          })
          .on('end', () => {
            console.log(`%%% SERVER: HLS conversion complete for video: ${videoId}`);
            resolve(videoId);
          })
          .on('error', (err) => {
            console.error(`%%% SERVER ERROR: FFMPEG error: ${err.message}`);
            reject(err);
          })
          .run();
      });

      // Send notification after starting the first variant's processing
      if (!processingStartedNotified) {
        const hlsUrl = `/hls/${videoId}/playlist.m3u8`;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            // Reuse 'videoProcessed' type, frontend will handle it
            client.send(JSON.stringify({
              type: 'videoProcessed',
              videoId,
              hlsUrl
            }));
          }
        });
        console.log('Sent videoProcessed notification early:', videoId);
        processingStartedNotified = true;
      }

      // Await completion of this quality before starting the next
      await processPromise;
      console.log(`%%% SERVER: Finished processing for ${quality.name} (${videoId})`);
    }

    console.log('All video processing variants completed for:', videoId);

    // Clean up original file only after successful processing of all variants
    try {
      await fs.unlink(file.path);
      console.log('Removed original uploaded file:', file.path);
    } catch (unlinkError) {
      console.error('Error removing original file:', unlinkError);
    }

  } catch (error) {
    console.error('%%% SERVER ERROR: Error in upload-finish handler:', error);
    // Notify WebSocket clients about the error
    // Ensure videoId is defined or provide a default
    const currentVideoId = typeof videoId !== 'undefined' ? videoId : 'unknown';
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'videoError',
          videoId: currentVideoId,
          error: error.message
        }));
      }
    });
  }
});

// Log upload progress
tusServer.on('upload-progress', (event) => {
  const { bytesReceived, bytesTotal } = event;
  const progress = ((bytesReceived / bytesTotal) * 100).toFixed(2);
  console.log(`Upload progress: ${progress}% (${bytesReceived}/${bytesTotal} bytes)`);
  
  // Notify clients through WebSocket
  wss.clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'upload-progress',
        progress: progress
      }));
    }
  });
});

tusServer.on('error', (error) => {
  console.error('TUS server error:', error);
});

// Use CORS middleware for all routes
app.use(cors(corsOptions));

// Handle TUS server
app.use('/uploads', (req, res) => {
  console.log('%%% SERVER: TUS Request Handler Hit:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    tusServerExists: !!tusServer,
    tusListeners: tusServer.listenerCount('upload-finish')
  });

  tusServer.handle(req, res);
});

// Serve static files with CORS headers
const serveStaticWithCORS = (directory, route) => {
  app.use(route, (req, res, next) => {
    // Add CORS headers for all static files
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    
    next();
  }, express.static(directory));
};

// Serve static files with CORS headers
serveStaticWithCORS(uploadsDir, '/uploads');
serveStaticWithCORS(videoDir, '/videos');
serveStaticWithCORS(hlsDir, '/hls');
serveStaticWithCORS(publicDir, '/');

// Add a periodic check for completed uploads
const checkForCompletedUploads = async () => {
  try {
    console.log('%%% SERVER: Checking for completed uploads...');
    
    // Store processed video IDs to avoid duplicate processing
    const processedVideoIds = new Set();
    
    // First, check for any .processed files that don't have corresponding HLS output
    // This indicates a failed processing attempt that we should retry
    const processedFiles = await fs.readdir(tusUploadDir)
      .then(files => files.filter(file => file.endsWith('.processed')))
      .catch(() => []);
    
    for (const processedFlag of processedFiles) {
      const originalFile = processedFlag.replace('.processed', '');
      const originalPath = path.join(tusUploadDir, originalFile);
      
      // Check if the original file exists
      const originalExists = await fs.access(originalPath).then(() => true).catch(() => false);
      
      if (originalExists) {
        // Extract videoId from the processed flag file
        const processedContent = await fs.readFile(path.join(tusUploadDir, processedFlag), 'utf8')
          .catch(() => '');
        
        // If we can parse a date from the content, it's a valid processed flag
        try {
          const processedDate = new Date(processedContent);
          const now = new Date();
          
          // If the flag is older than 30 minutes, it's likely a failed process
          if (now - processedDate > 30 * 60 * 1000) {
            console.log(`%%% SERVER: Found stale processed flag: ${processedFlag}, removing for retry`);
            await fs.unlink(path.join(tusUploadDir, processedFlag)).catch(() => {});
          } else {
            // Add this file to the processed set to avoid reprocessing
            processedVideoIds.add(originalFile);
          }
        } catch (e) {
          // If we can't parse the date, it's an invalid flag, remove it
          console.log(`%%% SERVER: Found invalid processed flag: ${processedFlag}, removing`);
          await fs.unlink(path.join(tusUploadDir, processedFlag)).catch(() => {});
        }
      } else {
        // If the original file doesn't exist, remove the orphaned flag
        console.log(`%%% SERVER: Found orphaned processed flag: ${processedFlag}, removing`);
        await fs.unlink(path.join(tusUploadDir, processedFlag)).catch(() => {});
      }
    }
    
    // Now check for files to process
    const files = await fs.readdir(tusUploadDir);
    
    if (files.length > 0) {
      // Filter out JSON files and already processed files
      const uploadFiles = files.filter(file => 
        !file.endsWith('.json') && 
        !file.endsWith('.processed') && 
        !processedVideoIds.has(file)
      );
      
      if (uploadFiles.length > 0) {
        console.log(`%%% SERVER: Found ${uploadFiles.length} files to check for processing`);
        
        for (const file of uploadFiles) {
          const filePath = path.join(tusUploadDir, file);
          const stats = await fs.stat(filePath);
          
          // Only process files, not directories
          if (stats.isFile()) {
            console.log(`%%% SERVER: Found file: ${file}, size: ${stats.size} bytes`);
            
            try {
              // Check if this is a completed upload by looking for .json files
              const jsonFilePath = `${filePath}.json`;
              const jsonExists = await fs.access(jsonFilePath).then(() => true).catch(() => false);
              
              if (jsonExists) {
                const jsonContent = await fs.readFile(jsonFilePath, 'utf8');
                const info = JSON.parse(jsonContent);
                
                console.log(`%%% SERVER: File info:`, info);
                
                // Check if upload is complete by comparing size or other metadata
                // The TUS metadata JSON has a size field that should match the file size
                if (stats.size === info.size) {
                  console.log(`%%% SERVER: Found completed upload: ${file}, size matches metadata`);
                  
                  // Create a processed flag file to avoid reprocessing
                  const processedFlagPath = `${filePath}.processed`;
                  const alreadyProcessed = await fs.access(processedFlagPath).then(() => true).catch(() => false);
                  
                  if (!alreadyProcessed) {
                    // Extract metadata from the JSON file
                    const metadata = {};
                    if (info.metadata) {
                      // Extract metadata
                      Object.entries(info.metadata).forEach(([key, value]) => {
                        metadata[key] = value;
                      });
                    }
                    
                    console.log(`%%% SERVER: Extracted metadata:`, metadata);
                    
                    // Generate a new video ID
                    const videoId = uuidv4();
                    
                    // Create the processed flag file to prevent reprocessing during this attempt
                    await fs.writeFile(processedFlagPath, new Date().toISOString());
                    
                    try {
                      // Process the video
                      console.log(`%%% SERVER: Processing upload ${file} with videoId ${videoId}`);
                      
                      // Notify clients that processing has started
                      clients.forEach((client, id) => {
                        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                          client.ws.send(JSON.stringify({
                            type: 'processing-started',
                            videoId,
                            message: 'Video processing has started'
                          }));
                        }
                      });
                      
                      // Process the video
                      await processVideo(filePath, videoId);
                      
                      // Check if the HLS playlist was created
                      const hlsOutputDir = path.join(hlsDir, videoId);
                      const hlsPlaylistPath = path.join(hlsOutputDir, 'playlist.m3u8');
                      const playlistExists = await fs.access(hlsPlaylistPath)
                        .then(() => true)
                        .catch(() => false);
                      
                      if (playlistExists) {
                        console.log(`%%% SERVER: HLS playlist created successfully for ${videoId}`);
                        
                        // Notify clients that the video is ready
                        const hlsUrl = `/hls/${videoId}/playlist.m3u8`;
                        clients.forEach((client, id) => {
                          if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                              type: 'videoProcessed',
                              videoId,
                              hlsUrl
                            }));
                          }
                        });
                        
                        console.log(`%%% SERVER: Notified clients about processed video ${videoId}`);
                        
                        // Add this file to the processed set to avoid reprocessing in this session
                        processedVideoIds.add(file);
                      } else {
                        throw new Error(`HLS playlist not created for ${videoId}`);
                      }
                    } catch (error) {
                      console.error(`%%% SERVER ERROR: Failed to process upload ${file}:`, error);
                      
                      // Remove the processed flag so it can be retried
                      await fs.unlink(processedFlagPath).catch(() => {});
                      
                      // Notify clients about the error
                      clients.forEach((client, id) => {
                        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                          client.ws.send(JSON.stringify({
                            type: 'videoError',
                            videoId,
                            error: error.message
                          }));
                        }
                      });
                    }
                  } else {
                    console.log(`%%% SERVER: Upload ${file} already processed, skipping`);
                    
                    // Add this file to the processed set to avoid reprocessing in this session
                    processedVideoIds.add(file);
                  }
                } else {
                  console.log(`%%% SERVER: Upload not yet complete for ${file}. Current size: ${stats.size}, Expected: ${info.size}`);
                }
              } else {
                console.log(`%%% SERVER: No metadata file found for ${file}`);
              }
            } catch (error) {
              console.error(`%%% SERVER ERROR: Error processing file ${file}:`, error);
            }
          }
        }
      } else {
        console.log('%%% SERVER: No new files to process');
      }
    } else {
      console.log('%%% SERVER: No files found in tus uploads directory');
    }
  } catch (error) {
    console.error('%%% SERVER ERROR: Error checking for completed uploads:', error);
  }
  
  // Schedule the next check
  setTimeout(checkForCompletedUploads, 5000); // Check every 5 seconds
};

// Start the periodic check after a short delay
setTimeout(checkForCompletedUploads, 5000);

app.get('/', function (req, res) {
  res.json({ message: "Hello chai aur code" })
})

// Get video status
// Get video status and process if needed
app.get('/api/videos/:videoId', async (req, res) => {
  try {
    const videoId = req.params.videoId;
    const hlsPath = path.join(hlsDir, videoId, 'playlist.m3u8');
    
    const exists = await fs.access(hlsPath)
      .then(() => true)
      .catch(() => false);
    
    if (exists) {
      res.json({
        videoId,
        status: 'processed',
        hlsUrl: `/hls/${videoId}/playlist.m3u8`
      });
    } else {
      res.json({
        videoId,
        status: 'processing',
        hlsUrl: null
      });
    }
  } catch (error) {
    console.error('Error checking video status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle TUS errors
tusServer.on('error', (error) => {
  console.error('TUS error:', error);
});

// Process local video files in the uploads directory
const processLocalVideo = async (filename) => {
  try {
    const inputPath = path.join(uploadsDir, filename);
    const videoId = uuidv4();
    
    console.log(`%%% SERVER: Processing local video: ${filename} with ID: ${videoId}`);
    
    // Process the video to HLS format
    await processVideo(inputPath, videoId);
    
    // Return the video information
    return {
      id: videoId,
      filename,
      hlsUrl: `/hls/${videoId}/playlist.m3u8`,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`%%% SERVER ERROR: Failed to process local video ${filename}:`, error);
    throw error;
  }
};

// Store processed local videos
const processedLocalVideos = new Map();

// Scan for local videos in the uploads directory
const scanLocalVideos = async () => {
  try {
    console.log('%%% SERVER: Scanning for local videos in uploads directory...');
    
    // Get all files in the uploads directory
    const files = await fs.readdir(uploadsDir);
    
    // Filter for video files (common video extensions)
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return videoExtensions.includes(ext);
    });
    
    console.log(`%%% SERVER: Found ${videoFiles.length} local video files`);
    
    return videoFiles;
  } catch (error) {
    console.error('%%% SERVER ERROR: Failed to scan for local videos:', error);
    return [];
  }
};

// API endpoint to list all available local videos
app.get('/api/local-videos', async (req, res) => {
  try {
    // Get all video files in the uploads directory
    const videoFiles = await scanLocalVideos();
    
    // Return the list of videos with their status
    const videos = videoFiles.map(filename => {
      // Check if this video has already been processed
      if (processedLocalVideos.has(filename)) {
        return processedLocalVideos.get(filename);
      }
      
      // Return unprocessed video info
      return {
        filename,
        processed: false
      };
    });
    
    res.json(videos);
  } catch (error) {
    console.error('%%% SERVER ERROR: Error listing local videos:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to process a specific local video
app.post('/api/local-videos/process', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    // Check if the file exists
    const filePath = path.join(uploadsDir, filename);
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    
    if (!fileExists) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Check if already processed
    if (processedLocalVideos.has(filename)) {
      return res.json(processedLocalVideos.get(filename));
    }
    
    // Process the video
    const videoInfo = await processLocalVideo(filename);
    
    // Store the processed video info
    processedLocalVideos.set(filename, {
      ...videoInfo,
      processed: true
    });
    
    // Notify all connected clients about the new video
    clients.forEach((client, id) => {
      if (client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'localVideoProcessed',
          video: videoInfo
        }));
      }
    });
    
    res.json(videoInfo);
  } catch (error) {
    console.error('%%% SERVER ERROR: Error processing local video:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get all processed local videos
app.get('/api/local-videos/processed', (req, res) => {
  const videos = Array.from(processedLocalVideos.values());
  res.json(videos);
});

server.listen(8000, () => {
  console.log('Server listening at http://localhost:8000');
});