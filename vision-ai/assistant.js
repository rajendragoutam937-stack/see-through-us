(function (global) {
  "use strict";

  const CONTINUOUS_INTERVAL_MS = 12000;
  const API_TIMEOUT_MS = 28000;
  const MAX_CLIENT_HISTORY = 6;
  const MAX_CONSECUTIVE_AUTO_ERRORS = 3;

  class VisionAssistant {
    constructor(options) {
      this.camera = options.camera;
      this.voice = options.voice;
      this.onStatusChange =
        typeof options.onStatusChange === "function" ? options.onStatusChange : function () {};
      this.onActiveChange =
        typeof options.onActiveChange === "function" ? options.onActiveChange : function () {};
      this.onLogEntry =
        typeof options.onLogEntry === "function" ? options.onLogEntry : function () {};
      this.onAutoAwarenessChange =
        typeof options.onAutoAwarenessChange === "function"
          ? options.onAutoAwarenessChange
          : function () {};

      this.active = false;
      this.starting = false;
      this.autoAwarenessEnabled = true;
      this.continuousTimer = null;
      this.inFlightController = null;
      this.inFlightMode = null;
      this.isAnalyzing = false;
      this.consecutiveAutoErrors = 0;
      this.history = [];
      this.userSpeakingInterim = false;
    }

    isActive() {
      return this.active;
    }

    isAutoAwarenessEnabled() {
      return this.autoAwarenessEnabled;
    }

    setUserSpeakingInterim(speaking) {
      this.userSpeakingInterim = Boolean(speaking);
    }

    setAutoAwareness(enabled) {
      this.autoAwarenessEnabled = Boolean(enabled);
      this.onAutoAwarenessChange(this.autoAwarenessEnabled);

      if (!this.active) {
        return;
      }

      if (this.autoAwarenessEnabled) {
        this.consecutiveAutoErrors = 0;
        this.startContinuousLoop();
        this.onStatusChange("active", "Active", "Continuous visual awareness resumed (every 12 seconds).");
      } else {
        this.stopContinuousLoop();
        this.onStatusChange("active", "Active", "Continuous visual awareness paused. Voice and text questions remain active.");
      }
    }

    clearHistory() {
      this.history = [];
    }

    pushHistory(role, text) {
      this.history.push({ role: role, text: text });
      if (this.history.length > MAX_CLIENT_HISTORY) {
        this.history = this.history.slice(-MAX_CLIENT_HISTORY);
      }
    }

    async start() {
      if (this.active || this.starting) {
        return;
      }

      this.starting = true;
      this.consecutiveAutoErrors = 0;
      this.onActiveChange(false, true);
      this.onStatusChange("idle", "Starting", "Requesting camera permission...");

      const camResult = await this.camera.start(null);
      if (!camResult.ok) {
        this.starting = false;
        this.active = false;
        this.onActiveChange(false, false);
        this.onStatusChange("error", "Camera Blocked", camResult.message);
        this.onLogEntry("error", "System", camResult.message);
        await this.voice.speak(camResult.message, { skipResume: true });
        return;
      }

      this.onStatusChange("idle", "Starting", "Requesting microphone permission...");
      const micResult = await this.voice.requestMicrophonePermission();
      let voiceReady = false;
      if (micResult.ok) {
        const listenResult = this.voice.startListening();
        voiceReady = listenResult.ok;
        if (!listenResult.ok) {
          this.onLogEntry("error", "Voice Notice", listenResult.message);
        }
      } else {
        this.onLogEntry("error", "Microphone Notice", micResult.message);
      }

      this.active = true;
      this.starting = false;
      this.onActiveChange(true, false);

      this.onStatusChange(
        "active",
        "Analyzing",
        "Capturing initial scene and asking VISION AI to describe your surroundings..."
      );

      await this.analyzeFrame({
        mode: "initial",
        question: "Describe what is currently in front of me for initial orientation.",
        speakResult: true,
        logQuestion: false,
      });

      if (this.active) {
        if (this.autoAwarenessEnabled) {
          this.startContinuousLoop();
        }
        const readyMsg = voiceReady
          ? "Assistant active. Speak a question anytime or type below."
          : "Camera active, voice input unavailable. Type questions below anytime.";
        this.onStatusChange(voiceReady ? "active" : "warning", "Listening", readyMsg);
      }
    }

    stop(reasonMessage) {
      this.active = false;
      this.starting = false;
      this.stopContinuousLoop();
      this.abortInFlight();
      this.voice.interruptSpeech({ skipResume: true });
      this.voice.stopListening();
      this.camera.stop();
      this.onActiveChange(false, false);

      const message =
        reasonMessage ||
        "Assistant stopped. Press START ASSISTANT to resume camera and voice assistance.";
      this.onStatusChange("idle", "Stopped", message);
    }

    handleCameraDisconnected() {
      if (!this.active) {
        return;
      }
      const msg = "Camera connection was lost or stopped. Stopping assistant.";
      this.onLogEntry("error", "Camera Disconnected", msg);
      this.stop(msg);
      this.voice.speak(msg, { skipResume: true });
    }

    startContinuousLoop() {
      this.stopContinuousLoop();
      if (!this.active || !this.autoAwarenessEnabled) {
        return;
      }
      this.continuousTimer = global.setInterval(() => {
        this.runContinuousCheck();
      }, CONTINUOUS_INTERVAL_MS);
    }

    stopContinuousLoop() {
      if (this.continuousTimer) {
        global.clearInterval(this.continuousTimer);
        this.continuousTimer = null;
      }
    }

    abortInFlight() {
      if (this.inFlightController) {
        try {
          this.inFlightController.abort();
        } catch (_err) {
          // Ignore abort errors.
        }
        this.inFlightController = null;
        this.inFlightMode = null;
      }
      this.isAnalyzing = false;
    }

    async runContinuousCheck() {
      if (
        !this.active ||
        !this.autoAwarenessEnabled ||
        this.isAnalyzing ||
        this.voice.isSpeaking() ||
        this.userSpeakingInterim ||
        !this.camera.isReady()
      ) {
        return;
      }

      await this.analyzeFrame({
        mode: "continuous",
        question: "Briefly summarize what is currently visible ahead.",
        speakResult: true,
        logQuestion: false,
      });
    }

    async askQuestion(rawQuestion, source) {
      const question = String(rawQuestion || "").trim();
      if (!question) {
        return;
      }

      // Immediately interrupt assistant speech so user can take control at any moment.
      this.voice.interruptSpeech({ skipResume: true });

      if (!this.active || !this.camera.isReady()) {
        const notReadyMsg =
          "The assistant camera is not active yet. Press START ASSISTANT first so I can see your surroundings.";
        this.onLogEntry("user", source === "voice" ? "You (Voice)" : "You (Typed)", question);
        this.onLogEntry("error", "VISION AI", notReadyMsg);
        this.onStatusChange("warning", "Camera Off", notReadyMsg);
        await this.voice.speak(notReadyMsg, { skipResume: true });
        return;
      }

      // Prioritize user's explicit question over any background continuous scan.
      if (this.isAnalyzing && this.inFlightMode === "continuous") {
        this.abortInFlight();
      }

      await this.analyzeFrame({
        mode: "question",
        question: question,
        source: source || "text",
        speakResult: true,
        logQuestion: true,
      });
    }

    async analyzeNow() {
      if (!this.active || !this.camera.isReady()) {
        return;
      }
      this.voice.interruptSpeech({ skipResume: true });
      if (this.isAnalyzing && this.inFlightMode === "continuous") {
        this.abortInFlight();
      }
      await this.analyzeFrame({
        mode: "question",
        question: "What is in front of me right now?",
        source: "manual",
        speakResult: true,
        logQuestion: true,
      });
    }

    async analyzeFrame(params) {
      if (this.isAnalyzing && params.mode === "continuous") {
        return;
      }
      if (this.isAnalyzing && params.mode === "question") {
        this.abortInFlight();
      }

      const frame = this.camera.captureFrame();
      if (!frame.ok) {
        this.onStatusChange("error", "Camera Error", frame.message);
        this.onLogEntry("error", "Camera Error", frame.message);
        if (params.mode === "continuous") {
          this.consecutiveAutoErrors += 1;
        }
        return;
      }

      if (params.logQuestion) {
        const speakerLabel =
          params.source === "voice"
            ? "You (Voice)"
            : params.source === "manual"
            ? "You (Manual Scan)"
            : "You (Typed)";
        this.onLogEntry("user", speakerLabel, params.question);
      }

      this.isAnalyzing = true;
      this.inFlightMode = params.mode;
      const controller = new AbortController();
      this.inFlightController = controller;

      const timeoutId = global.setTimeout(() => {
        controller.abort();
      }, API_TIMEOUT_MS);

      this.onStatusChange(
        "active",
        "Analyzing",
        params.mode === "continuous"
          ? "Updating visual awareness from latest camera frame..."
          : "Analyzing camera view with VISION AI..."
      );

      try {
        const response = await global.fetch("/api/vision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            image: frame.dataUrl,
            question: params.question,
            language: this.voice.language,
            mode: params.mode,
            history: this.history,
          }),
        });

        let data = null;
        try {
          data = await response.json();
        } catch (_jsonErr) {
          data = null;
        }

        if (!response.ok || !data || !data.ok) {
          const errorMessage =
            (data && data.error) ||
            "Vision API returned status " + response.status + ".";
          const errorCode = (data && data.code) || "API_ERROR";

          if (params.mode === "continuous") {
            this.consecutiveAutoErrors += 1;
          }

          if (
            errorCode === "MISSING_API_KEY" ||
            errorCode === "GROQ_AUTH_ERROR" ||
            this.consecutiveAutoErrors >= MAX_CONSECUTIVE_AUTO_ERRORS
          ) {
            if (this.autoAwarenessEnabled && params.mode === "continuous") {
              this.setAutoAwareness(false);
            }
          }

          this.onStatusChange("error", "Analysis Failed", errorMessage);
          this.onLogEntry("error", "VISION AI Error", errorMessage);
          if (params.speakResult && params.mode !== "continuous") {
            await this.voice.speak(errorMessage);
          }
          return;
        }

        this.consecutiveAutoErrors = 0;
        const answer = String(data.answer || "").trim();
        if (!answer) {
          const emptyMsg = "The AI returned an empty description.";
          this.onStatusChange("warning", "Empty Response", emptyMsg);
          return;
        }

        if (params.logQuestion) {
          this.pushHistory("user", params.question);
        }
        this.pushHistory("assistant", answer);

        const label =
          params.mode === "continuous"
            ? "VISION AI (Scene Update)"
            : params.mode === "initial"
            ? "VISION AI (Initial Scan)"
            : "VISION AI";

        this.onLogEntry("assistant", label, answer);

        if (this.active && params.speakResult) {
          this.onStatusChange("active", "Speaking", "Speaking response. Press Escape or Stop Speaking to interrupt.");
          await this.voice.speak(answer);
        }

        if (this.active) {
          this.onStatusChange(
            "active",
            "Listening",
            this.voice.shouldListen
              ? "Listening for your next question..."
              : "Camera active. Type a question below anytime."
          );
        }
      } catch (err) {
        if (err && err.name === "AbortError") {
          return;
        }
        const networkMsg =
          "Could not reach the VISION AI backend. Check your connection and server status.";
        if (params.mode === "continuous") {
          this.consecutiveAutoErrors += 1;
          if (this.consecutiveAutoErrors >= MAX_CONSECUTIVE_AUTO_ERRORS) {
            this.setAutoAwareness(false);
          }
        }
        this.onStatusChange("error", "Network Error", networkMsg);
        this.onLogEntry("error", "Network Error", networkMsg);
        if (params.speakResult && params.mode !== "continuous") {
          await this.voice.speak(networkMsg);
        }
      } finally {
        global.clearTimeout(timeoutId);
        if (this.inFlightController === controller) {
          this.inFlightController = null;
          this.inFlightMode = null;
          this.isAnalyzing = false;
        }
      }
    }
  }

  global.VisionAssistant = VisionAssistant;
})(window);
