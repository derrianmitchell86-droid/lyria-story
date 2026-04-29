/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";

import { html, LitElement, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { when } from "lit/directives/when.js";

import { urlargs } from "../utils/urlargs";
import { defineSystemPrompt } from "../utils/define_system_prompt";
import { LiveMusicHelper } from "../utils/live_music_helper";
import {
  DEFAULT_INTERVAL_PRESET,
  GEMINI_MODEL,
  IMAGE_MIME_TYPE,
  MAX_CAPTURE_DIM,
  PREFERRED_STREAM_PARAMS,
} from "../utils/constants";

import styles from "./lyria_camera_styles";

import type { ToastMessage } from "./toast_message";
import "./toast_message";

import type {
  PlaybackState,
  Prompt,
  AppState,
  FacingMode,
  IntervalPreset,
  StreamSource,
  Page,
} from "../utils/types";

defineSystemPrompt();

@customElement("lyria-camera")
export class LyriaCamera extends LitElement {
  static override styles = styles;

  private liveMusicHelper!: LiveMusicHelper;
  private ai!: GoogleGenAI;

  @state() private page: Page = "splash";
  @state() private appState: AppState = "idle";
  @state() private playbackState: PlaybackState = "stopped";

  @state() private prompts: Prompt[] = [];
  @state() private promptsStale = false;
  @state() private promptsLoading = false;

  @state() private story: string = "";
  @state() private interaction: string = "";
  @state() private recapStory: string = "";
  @state() private storySegments: string[] = [];
  @state() private fullStory: string = "";
  @state() private isSummarizing = false;

  @state() private isRecording = false;
  @state() private recordingUrl: string | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  @state() private hasAudioChunks = false;

  @state() private supportsScreenShare = false;
  @state() private hasMultipleCameras = false;

  @state() private isVideoFlipped = false;

  @state() private lastCapturedImage: string | null = null;
  @state() private currentFacingMode: FacingMode = "environment";
  @state() private currentSource: StreamSource = "none";
  @state() private intervalPreset = DEFAULT_INTERVAL_PRESET;
  @state() private captureCountdown = 0;

  @query("video") private videoElement!: HTMLVideoElement;
  @query("toast-message") private toastMessageElement!: ToastMessage;

  private canvasElement: HTMLCanvasElement = document.createElement("canvas");

  private nextCaptureTime = 0;
  private timerRafId: number | null = null;
  private crossfadeIntervalId: number | null = null;

  private currentWeightedPrompts: Prompt[] = [];

  override async connectedCallback() {
    super.connectedCallback();

    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || "" });

    this.liveMusicHelper = new LiveMusicHelper(this.ai, "lyria-realtime-exp");

    this.liveMusicHelper.addEventListener(
      "playback-state-changed",
      (e: CustomEvent<PlaybackState>) => this.handlePlaybackStateChange(e),
    );

    this.liveMusicHelper.addEventListener(
      "prompts-fresh",
      () => (this.promptsStale = false),
    );

    this.liveMusicHelper.addEventListener("error", (e: CustomEvent<string>) => {
      this.dispatchError(e.detail);
    });

    if (urlargs.debugPrompts) {
      this.prompts = [
        { text: "Ambient synth pads", weight: 1.0 },
        { text: "Lofi hip hop drums", weight: 1.0 },
        { text: "Jazzy piano chords", weight: 1.0 },
      ];
    }

    this.supportsScreenShare = !!navigator.mediaDevices?.getDisplayMedia;
    void this.updateCameraCapabilities();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTimer();
    this.stopCurrentStream();
  }

  private stopCurrentStream() {
    if (!this.videoElement.srcObject) return;
    (this.videoElement.srcObject as MediaStream)
      .getTracks()
      .forEach((track) => track.stop());
  }

  private async updateCameraCapabilities() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((d) => d.kind === "videoinput");
    this.hasMultipleCameras = videoDevices.length > 1;
  }

  private async setupCamera() {
    this.stopCurrentStream();

    const facingModesToTry: FacingMode[] = [
      this.currentFacingMode,
      this.currentFacingMode === "user" ? "environment" : "user",
    ];

    let stream: MediaStream | null = null;
    for (const facingMode of facingModesToTry) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...PREFERRED_STREAM_PARAMS,
            facingMode,
          },
        });
        this.currentFacingMode = facingMode;
        break;
      } catch (e) {
        console.warn(`Could not get ${facingMode} camera.`, e);
      }
    }

    if (!stream) {
      this.dispatchError("Could not access webcam. Please grant camera permission.");
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    const flipped = settings.facingMode !== "environment";
    this.setStream(stream, "camera", flipped);
  }

  private async switchCamera() {
    this.currentFacingMode =
      this.currentFacingMode === "user" ? "environment" : "user";
    await this.setupCamera();
  }

  private async setupScreenShare() {
    try {
      this.stopCurrentStream();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      this.setStream(stream, "screen", false);
    } catch (err) {
      this.dispatchError("Could not start screen sharing.");
    }
  }

  private setStream(
    stream: MediaStream,
    source: StreamSource,
    flipped: boolean,
  ) {
    if (!stream) return;
    this.isVideoFlipped = flipped;
    this.videoElement.srcObject = stream;
    this.videoElement.onloadedmetadata = async () => {
      await this.videoElement.play();
      this.currentSource = source;
      this.page = "main";
      void this.updateCameraCapabilities();
    };

    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => this.handleStreamEnded());
    });
  }

  private async handleStreamEnded() {
    await this.requestStop();
    this.currentSource = "none";
    this.page = "splash";
  }

  private startTimer() {
    this.stopTimer();
    this.nextCaptureTime =
      performance.now() + this.intervalPreset.captureSeconds * 1000;
    this.tick();
  }

  private tick = () => {
    const remainingMs = this.nextCaptureTime - performance.now();
    this.captureCountdown = Math.max(0, Math.ceil(remainingMs / 1000));

    if (remainingMs <= 0) {
      void this.captureAndGenerate();
    } else {
      this.timerRafId = requestAnimationFrame(this.tick);
    }
  };

  private stopTimer() {
    if (!this.timerRafId) return;
    cancelAnimationFrame(this.timerRafId);
    this.timerRafId = null;
  }

  private async captureAndGenerate() {
    if (this.promptsLoading || !["main", "interval"].includes(this.page))
      return;

    this.promptsLoading = true;

    const snapshotDataUrl = this.getStreamSnapshot();
    this.lastCapturedImage = snapshotDataUrl;
    const base64ImageData = snapshotDataUrl.split(",")[1];

    try {
      if (!this.ai) return;

      const contents = [
        {
          role: "user" as const,
          parts: [
            { inlineData: { mimeType: IMAGE_MIME_TYPE, data: base64ImageData } },
            { text: `CURRENT STORY CONTEXT: ${this.storySegments.slice(-5).join(" ")}` },
          ],
        },
      ];

      const response = await this.ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: window.systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              musicPrompts: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              story: { type: Type.STRING },
              interaction: { type: Type.STRING },
            },
            required: ["musicPrompts", "story"],
          },
        },
      });

      const json = JSON.parse(response.text || "{}");

      const newPromptTexts: string[] = json.musicPrompts;
      this.story = json.story;
      this.interaction = json.interaction || "";
      this.storySegments.push(this.story);
      
      this.speakStory(this.story);

      if (this.appState === "idle") return;

      this.prompts = newPromptTexts.map((text) => ({
        text,
        weight: 1.0,
        isNew: true,
      }));

      setTimeout(() => {
        this.prompts = this.prompts.map((p) => ({ ...p, isNew: false }));
      }, 1000);

      this.startCrossfade(newPromptTexts);

      if (this.appState === "pendingStart") {
        await this.liveMusicHelper.play();
        this.appState = "playing";
      }
    } catch (e) {
      console.error(e);
      this.dispatchError("Failed to generate adventure.");
    } finally {
      this.promptsLoading = false;
      if (this.appState === "pendingStart") {
        this.appState = "idle";
      }
      if (this.hasAudioChunks) {
        this.startTimer();
      }
    }
  }

  private getStreamSnapshot() {
    const { videoWidth, videoHeight } = this.videoElement;
    let drawWidth = videoWidth;
    let drawHeight = videoHeight;

    if (drawWidth > MAX_CAPTURE_DIM || drawHeight > MAX_CAPTURE_DIM) {
      const aspectRatio = drawWidth / drawHeight;
      if (drawWidth > drawHeight) {
        drawWidth = MAX_CAPTURE_DIM;
        drawHeight = MAX_CAPTURE_DIM / aspectRatio;
      } else {
        drawHeight = MAX_CAPTURE_DIM;
        drawWidth = MAX_CAPTURE_DIM * aspectRatio;
      }
    }

    this.canvasElement.width = drawWidth;
    this.canvasElement.height = drawHeight;
    const context = this.canvasElement.getContext("2d");
    context?.drawImage(this.videoElement, 0, 0, drawWidth, drawHeight);
    return this.canvasElement.toDataURL(IMAGE_MIME_TYPE);
  }

  private speakStory(text: string) {
    if (!window.speechSynthesis) return;
    
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // Try to find a mystical sounding voice (usually slower and lower pitch)
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.lang.includes('en') && (v.name.includes('Google') || v.name.includes('Premium')));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.rate = 0.9; // Slightly slower for dramatic effect
    utterance.pitch = 0.9;
    utterance.volume = 1.0;

    window.speechSynthesis.speak(utterance);
  }

  private async startRecording() {
    const videoStream = this.videoElement.srcObject as MediaStream;
    const audioDest = this.liveMusicHelper.audioContext.createMediaStreamDestination();
    this.liveMusicHelper.extraDestination = audioDest;

    const combinedStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDest.stream.getAudioTracks(),
    ]);

    this.mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: "video/webm;codecs=vp8,opus",
    });
    this.recordedChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: "video/webm" });
      this.recordingUrl = URL.createObjectURL(blob);
    };
    this.mediaRecorder.start();
    this.isRecording = true;
  }

  private async generateRecap() {
    try {
      if (!this.ai) return;
      const prompt = `Based on these story segments, write a final rhyming 4-line recap of the entire adventure. Keep it mystical and satisfying.
      Segments: ${this.storySegments.join(" ")}`;

      const response = await this.ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt
      });

      this.recapStory = response.text || "";
    } catch (e) {
      console.error("Failed to generate recap", e);
      this.recapStory = "Your adventure was grand, across the mystical land.";
    }
  }

  private stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this.liveMusicHelper.extraDestination = null;
    void this.generateRecap();
    this.page = "download";
  }

  private downloadRecording() {
    if (!this.recordingUrl) return;
    const a = document.createElement("a");
    a.href = this.recordingUrl;
    a.download = "story-tale.webm";
    a.click();
  }

  private copyStoryToClipboard() {
    navigator.clipboard.writeText(this.recapStory);
    this.dispatchError("Story copied to clipboard!");
  }

  private startCrossfade(newPromptTexts: string[]) {
    let crossfadeSeconds = this.intervalPreset.crossfadeSeconds;
    if (this.currentWeightedPrompts.length === 0) crossfadeSeconds = 0;
    
    this.stopCrossfade();

    const targetPrompts = newPromptTexts.map((text) => ({ text, weight: 0 }));
    const fromPrompts = [...this.currentWeightedPrompts];
    const startTime = performance.now();
    const durationMs = crossfadeSeconds * 1000;

    const update = () => this.updateCrossfade(fromPrompts, targetPrompts, startTime, durationMs);
    update();

    if (crossfadeSeconds > 0) {
      this.crossfadeIntervalId = window.setInterval(update, 2000);
    }
  }

  private stopCrossfade() {
    if (this.crossfadeIntervalId) {
      clearInterval(this.crossfadeIntervalId);
      this.crossfadeIntervalId = null;
    }
  }

  private updateCrossfade(fromPrompts: Prompt[], targetPrompts: Prompt[], startTime: number, durationMs: number) {
    const now = performance.now();
    const t = durationMs > 0 ? Math.min(1, (now - startTime) / durationMs) : 1;

    const blended = [
      ...fromPrompts.map((p) => ({ ...p, weight: p.weight * (1 - t) })),
      ...targetPrompts.map((p) => ({ ...p, weight: t }))
    ];
    this.currentWeightedPrompts = blended;
    void this.liveMusicHelper.setWeightedPrompts(blended);

    if (t >= 1 || this.appState === "idle") {
      this.stopCrossfade();
    }
  }

  private handlePlaybackStateChange(e: CustomEvent<PlaybackState>) {
    this.playbackState = e.detail;
    if (this.playbackState === "playing" && !this.hasAudioChunks) {
      this.hasAudioChunks = true;
      this.startTimer();
      void this.startRecording();
    }
    if (this.playbackState === "paused") {
      this.stopTimer();
      this.captureCountdown = 0;
    }
  }

  private async handlePlayPause() {
    if (this.page !== "main" && this.page !== "download") return;
    if (this.page === "download") {
      this.recordingUrl = null;
      this.page = "main";
      return;
    }
    switch (this.appState) {
      case "idle":
        this.appState = "pendingStart";
        this.storySegments = [];
        this.story = "";
        this.recapStory = "";
        await this.captureAndGenerate();
        return;
      case "playing":
        this.stopRecording();
        await this.requestStop();
        return;
    }
  }

  private async requestStop() {
    this.stopTimer();
    this.prompts = [];
    this.liveMusicHelper.stop();
    this.appState = "idle";
    this.hasAudioChunks = false;
    this.currentWeightedPrompts = [];
    this.lastCapturedImage = null;
    this.promptsLoading = false;
  }

  private dispatchError(message: string) {
    this.toastMessageElement?.show(message);
  }

  override render() {
    this.classList.toggle("screenshare", this.currentSource === "screen");
    return html`
      <div id="video-container">
        <video playsinline muted style=${styleMap({ transform: this.isVideoFlipped ? "scaleX(-1)" : "none" })}></video>
      </div>
      <div id="overlay" class=${classMap({ "has-played": this.hasAudioChunks })}>
        ${this.renderPage()}
      </div>
      <toast-message></toast-message>
    `;
  }

  private renderPage() {
    switch (this.page) {
      case "splash": return this.renderSplash();
      case "main": return this.renderMain();
      case "download": return this.renderDownloadPage();
      default: return nothing;
    }
  }

  private renderDownloadPage() {
    return html`
      <div id="download-page">
        <h2>Your Story Tale is Ready</h2>
        <div class="recap-story">${this.recapStory}</div>
        <video src=${this.recordingUrl || ""} controls></video>
        <div class="download-actions">
          <button class="control-button" @click=${this.downloadRecording}>
            <span class="material-icons-outlined">download</span> Download Video
          </button>
          <button class="control-button" @click=${this.copyStoryToClipboard}>
            <span class="material-icons-outlined">content_copy</span> Copy Story
          </button>
          <button class="control-button secondary" @click=${() => (this.page = "splash")}>
            <span class="material-icons-outlined">refresh</span> New Adventure
          </button>
        </div>
      </div>
    `;
  }

  private renderSplash() {
    return html`
      <div id="splash">
        <div class="theatrical-header">
          <h1>Theater of the Mind</h1>
          <p class="subtitle">A Magical Lyria Adventure</p>
        </div>
        
        <div class="splash-actions">
          <button class="control-button primary" @click=${this.setupCamera}>
            <span class="material-icons-round">videocam</span> Peer into the Veil
          </button>
          
          ${when(this.supportsScreenShare, () => html`
            <button class="control-button secondary" @click=${this.setupScreenShare}>
              <span class="material-icons-round">desktop_windows</span> Project a Vision
            </button>
          `)}
        </div>

        <div class="experience-info">
          <p>Turn everyday items into fantastical tales through the lens of Gemini and the heartbeat of Lyria.</p>
        </div>
      </div>
    `;
  }

  private renderMain() {
    return html`
      ${when(this.isRecording, () => html`<div id="recording-indicator"><div class="rec-dot"></div>REC</div>`)}
      <div id="story-container">
        <div class="story-text">${this.story}</div>
        ${when(this.interaction, () => html`<div class="interactive-hint">${this.interaction}</div>`)}
      </div>
      <div id="controls-container">
        <button class="playpause-button" @click=${this.handlePlayPause}>
          <div class="playpause-visual">
            <div class="playpause-ring"></div>
            <div class="playpause-inner ${this.appState === 'playing' ? 'square' : ''}"></div>
            ${when(this.appState !== 'playing', () => html`<span class="material-icons-round playpause-play-icon">play_arrow</span>`)}
          </div>
        </button>
      </div>
    `;
  }
}
