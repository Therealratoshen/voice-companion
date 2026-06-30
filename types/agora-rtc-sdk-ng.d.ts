/**
 * Type declarations for Agora RTC Web SDK loaded via CDN.
 * The SDK is loaded from: https://download.agora.io/sdk/web/agora-rtc-sdk-ng.js
 *
 * The SDK is attached to `window` as `window.AgoraRTC`.
 * This file tells TypeScript about it so `createClient()` etc. are typed.
 */

declare namespace AgoraRTC {
  interface IAgoraRTC {
    createClient(options?: ClientConfig): Client;
    createMicrophoneAudioTrack(options?: MicrophoneAudioTrackInitConfig): LocalAudioTrack;
    createCameraVideoTrack(options?: CameraVideoTrackInitConfig): LocalVideoTrack;
    createBufferSourceAudioTrack(options?: BufferSourceAudioTrackInitConfig): BufferSourceAudioTrack;
    getDevices(): Promise<MediaDeviceInfo[]>;
    getMicrophones(): Promise<MediaDeviceInfo[]>;
    getCameras(): Promise<MediaDeviceInfo[]>;
    getAudioPlaybackDevices(): Promise<MediaDeviceInfo[]>;
    checkSystemRequirements(): SystemRequirements;
    setLogLevel(level: LogLevel): void;
    enableLogUpload(): void;
    disableLogUpload(): void;
    createMediaStreamTrack(trackId: string): MediaStreamTrack;
  }

  type LogLevel = 0 | 1 | 2 | 3 | 4 | 5;

  interface SystemRequirements {
    supportWebAudio: boolean;
    supportBroadcastChannel: boolean;
    supportScreenShare: boolean;
  }

  interface ClientConfig {
    mode?: "rtc" | "live";
    codec?: "vp8" | "h264" | "vp9" | "av1";
    zone?: string;
  }

  interface MicrophoneAudioTrackInitConfig {
    AEC?: boolean;  // Acoustic Echo Cancellation
    ANS?: boolean;  // Automatic Noise Suppression
    AGC?: boolean;  // Automatic Gain Control
    voice_activity_detection?: boolean;
    noise_suppression?: boolean;
    echo_cancellation?: boolean;
    auto_gain_control?: boolean;
  }

  interface CameraVideoTrackInitConfig {
    encoderConfig?: VideoEncoderConfiguration | VideoDimensions;
    optimizationMode?: "motion" | "detail";
  }

  interface VideoEncoderConfiguration {
    width: number;
    height: number;
    frameRate?: number;
    bitrateMax?: number;
    bitrateMin?: number;
    orientationMode?: "adaptive" | "fixed" | "auto";
  }

  interface VideoDimensions {
    width: number;
    height: number;
  }

  interface BufferSourceAudioTrackInitConfig {
    sources: MediaStreamTrack[];
    cacheEnabled?: boolean;
    cacheFileCount?: number;
  }

  interface Client {
    join(
      appId: string,
      channel: string,
      token: string | null,
      uid: number | string | null,
      options?: ClientJoinOptions
    ): Promise<number | string>;

    leave(onLeave?: (params: { reason: number }) => void): Promise<void>;

    publish(track: LocalTrack | LocalTrack[]): Promise<void>;

    unpublish(track: LocalTrack | LocalTrack[]): Promise<void>;

    subscribe(user: RemoteUser, mediaType: "audio" | "video"): Promise<void>;

    unsubscribe(user: RemoteUser, mediaType: "audio" | "video"): Promise<void>;

    on(event: "user-published", callback: (user: RemoteUser, mediaType: "audio" | "video") => void): void;
    on(event: "user-unpublished", callback: (user: RemoteUser, mediaType: "audio" | "video") => void): void;
    on(event: "user-joined", callback: (user: RemoteUser) => void): void;
    on(event: "user-left", callback: (user: RemoteUser, reason: number) => void): void;
    on(event: "connection-state-change", callback: (curState: string, prevState: string) => void): void;
    on(event: "token-privilege-will-expire", callback: () => void): void;
    on(event: "token-privilege-did-expire", callback: () => void): void;
    on(event: "exception", callback: (event: { code: number; msg: string; uid: number | string }) => void): void;
    off(event: string, callback?: Function): void;

    remoteUsers: RemoteUser[];

    setClientRole(role: "host" | "audience"): Promise<void>;

    enableAudioVolumeIndicator(
      interval: number,
      strategy?: 0 | 1
    ): Promise<void>;
  }

  interface ClientJoinOptions {
    autoSubscribeVideo?: boolean;
    autoSubscribeAudio?: boolean;
    publishCameraTrack?: boolean;
    publishMicrophoneTrack?: boolean;
    publishScreenTrack?: boolean;
    publishScreenAudioTrack?: boolean;
    token?: string;
    uid?: number | string;
  }

  interface RemoteUser {
    uid: number | string;
    hasAudio: boolean;
    hasVideo: boolean;
    audioTrack?: RemoteAudioTrack;
    videoTrack?: RemoteVideoTrack;
  }

  interface LocalTrack {
    getMediaStreamTrack(): MediaStreamTrack;
    isPlaying: boolean;
    play(): void;
    stop(): void;
    setEnabled(enabled: boolean): Promise<void>;
    setVolume(volume: number): void;
    close(): void;
    on(event: string, callback?: Function): void;
    off(event: string, callback?: Function): void;
  }

  type LocalAudioTrack = LocalTrack;
  type LocalVideoTrack = LocalTrack;

  interface RemoteAudioTrack extends LocalTrack {
    getVolumeLevel(): number;
  }

  interface RemoteVideoTrack extends LocalTrack {
    getAvgBitrate(): number;
    getVideoStats(): VideoTrackStats;
    getDecoderBitrate(): number;
    getRecvBitrate(): number;
  }

  interface VideoTrackStats {
    bytesSent: number;
    bytesReceived: number;
    framesDecoded: number;
    packetsLost: number;
    packetsReceived: number;
    roundTripTime: number;
  }
}

interface Window {
  AgoraRTC: AgoraRTC.IAgoraRTC;
}

export {};
