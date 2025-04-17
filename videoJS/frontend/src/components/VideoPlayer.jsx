import { useEffect, useRef } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import '@videojs/http-streaming';

export const VideoPlayer = ({ url }) => {
  const videoRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => {
    if (!playerRef.current && videoRef.current) {
      const videoJsOptions = {
        autoplay: false,
        controls: true,
        responsive: true,
        fluid: true,
        html5: {
          vhs: {
            enableLowInitialPlaylist: true,
            smoothQualityChange: true,
            overrideNative: true
          }
        },
        controlBar: {
          children: [
            'playToggle',
            'volumePanel',
            'currentTimeDisplay',
            'timeDivider',
            'durationDisplay',
            'progressControl',
            'liveDisplay',
            'customControlSpacer',
            'playbackRateMenuButton',
            'qualitySelector',
            'fullscreenToggle'
          ]
        },
        playbackRates: [0.5, 1, 1.5, 2],
        userActions: {
          hotkeys: true
        }
      };

      // Initialize the player
      const player = videojs(videoRef.current, videoJsOptions);
      
      // Add quality selector plugin
      player.ready(() => {
        console.log('Player is ready');
        
        // Only set source if we have a URL
        if (url) {
          player.src({
            src: url,
            type: 'application/x-mpegURL'
          });
        }
        
        // Setup quality selection
        player.on('loadedmetadata', () => {
          console.log('Video metadata loaded');
          const qualities = player.qualityLevels();
          
          if (qualities && qualities.length > 0) {
            console.log(`Found ${qualities.length} quality levels`);
            
            // Add quality selector if not already added
            if (!player.controlBar.getChild('QualitySelector')) {
              try {
                const QualitySelector = videojs.getComponent('QualitySelector');
                player.controlBar.addChild('QualitySelector', {});
                console.log('Quality selector added to player');
              } catch (error) {
                console.error('Error adding quality selector:', error);
              }
            }
          }
        });
        
        // Add city theme class
        player.addClass('vjs-theme-city');
      });
      
      // Save player reference
      playerRef.current = player;
    } else if (playerRef.current && url) {
      // If player exists but URL changes, update the source
      playerRef.current.src({
        src: url,
        type: 'application/x-mpegURL'
      });
    }

    // Cleanup
    return () => {
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [url]);

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div data-vjs-player>
        <video ref={videoRef} className="video-js vjs-big-play-centered" />
      </div>
    </div>
  );
};
