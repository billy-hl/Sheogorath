const { Porcupine } = require('@picovoice/porcupine-node');
const { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const path = require('path');

class WakeWordDetector {
  constructor() {
    this.activeConnections = new Map(); // channelId -> { connection, porcupine, subscribers }
    this.wakeWordCallbacks = new Map(); // channelId -> callback function
  }

  /**
   * Start listening for wake word in a voice channel
   * @param {VoiceChannel} voiceChannel - Discord voice channel
   * @param {Function} onWakeWord - Callback when wake word is detected: (userId) => {}
   * @param {String} accessKey - Picovoice access key
   */
  async startListening(voiceChannel, onWakeWord, accessKey) {
    const channelId = voiceChannel.id;

    // If already listening in this channel, ignore
    if (this.activeConnections.has(channelId)) {
      console.log(`Already listening in channel ${channelId}`);
      return;
    }

    try {
      // Join voice channel
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true
      });

      await new Promise((resolve, reject) => {
        connection.on(VoiceConnectionStatus.Ready, resolve);
        connection.on(VoiceConnectionStatus.Disconnected, () => reject(new Error('Connection failed')));
        setTimeout(() => reject(new Error('Connection timeout')), 10000);
      });

      // Initialize Porcupine with custom "Hey Fred" wake word
      const keywordPath = path.join(__dirname, '../../wake-words/fred_mac.ppn');
      const porcupine = new Porcupine(
        accessKey,
        [keywordPath], // Use custom wake word file
        [0.7] // Sensitivity (0.0 to 1.0, higher = more sensitive but more false positives)
      );

      console.log(`Wake word detection started in channel ${voiceChannel.name}`);
      console.log(`Listening for wake word "Porcupine" (say "Hey Fred" to activate)`);

      const receiver = connection.receiver;
      const subscribers = new Map(); // userId -> audio processor

      // Store connection info
      this.activeConnections.set(channelId, {
        connection,
        porcupine,
        subscribers
      });
      this.wakeWordCallbacks.set(channelId, onWakeWord);

      // Listen for users speaking
      receiver.speaking.on('start', (userId) => {
        if (subscribers.has(userId)) return; // Already subscribed

        console.log(`Monitoring user ${userId} for wake word`);

        // Subscribe to user's audio
        const opusStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.Manual
          }
        });

        // Decode opus to PCM
        const decoder = new prism.opus.Decoder({
          rate: 16000, // Porcupine requires 16kHz
          channels: 1, // Mono
          frameSize: 512
        });

        const audioProcessor = opusStream.pipe(decoder);

        // Process audio frames for wake word detection
        let frameCount = 0;
        audioProcessor.on('data', (pcmData) => {
          try {
            // Porcupine expects Int16Array
            const int16Data = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
            
            // Debug: Log frame processing every 100 frames
            frameCount++;
            if (frameCount % 100 === 0) {
              console.log(`Processing audio frames from user ${userId}: ${frameCount} frames, ${int16Data.length} samples`);
            }
            
            // Process frame (must be exactly 512 samples for 16kHz)
            if (int16Data.length === 512) {
              const keywordIndex = porcupine.process(int16Data);
              
              if (keywordIndex >= 0) {
                console.log(`🎤 Wake word detected from user ${userId}! (keyword index: ${keywordIndex})`);
                
                // Trigger callback
                const callback = this.wakeWordCallbacks.get(channelId);
                if (callback) {
                  callback(userId);
                }
              }
            } else {
              // Debug: Log incorrect frame sizes
              if (frameCount <= 10) {
                console.log(`Frame size mismatch: got ${int16Data.length}, expected 512`);
              }
            }
          } catch (err) {
            console.error('Wake word processing error:', err.message);
          }
        });

        audioProcessor.on('error', (err) => {
          // Ignore corrupted data errors (common during stream initialization)
          if (err.message && err.message.includes('corrupted')) {
            return;
          }
          console.error(`Audio processor error for user ${userId}:`, err);
          subscribers.delete(userId);
        });

        subscribers.set(userId, audioProcessor);
      });

      receiver.speaking.on('end', (userId) => {
        const processor = subscribers.get(userId);
        if (processor) {
          processor.destroy();
          subscribers.delete(userId);
        }
      });

    } catch (err) {
      console.error('Failed to start wake word detection:', err);
      throw err;
    }
  }

  /**
   * Stop listening in a voice channel
   */
  stopListening(channelId) {
    const connectionInfo = this.activeConnections.get(channelId);
    if (!connectionInfo) {
      return false;
    }

    const { connection, porcupine, subscribers } = connectionInfo;

    // Clean up all subscribers
    for (const processor of subscribers.values()) {
      processor.destroy();
    }
    subscribers.clear();

    // Release Porcupine resources
    porcupine.release();

    // Disconnect from voice
    connection.destroy();

    this.activeConnections.delete(channelId);
    this.wakeWordCallbacks.delete(channelId);

    console.log(`Wake word detection stopped in channel ${channelId}`);
    return true;
  }

  /**
   * Check if currently listening in a channel
   */
  isListening(channelId) {
    return this.activeConnections.has(channelId);
  }

  /**
   * Get all active channels
   */
  getActiveChannels() {
    return Array.from(this.activeConnections.keys());
  }

  /**
   * Stop all listeners
   */
  stopAll() {
    for (const channelId of this.activeConnections.keys()) {
      this.stopListening(channelId);
    }
  }
}

// Singleton instance
const wakeWordDetector = new WakeWordDetector();

module.exports = wakeWordDetector;
