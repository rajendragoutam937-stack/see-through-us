(function (global) {
  "use strict";

  // Add new languages by appending an object with code, label, nativeLabel, and speechLang.
  const SUPPORTED_LANGUAGES = [
    { code: "en-US", label: "English", nativeLabel: "English", speechLang: "en-US" },
    { code: "hi-IN", label: "Hindi", nativeLabel: "हिन्दी", speechLang: "hi-IN" },
    { code: "es-ES", label: "Spanish", nativeLabel: "Español", speechLang: "es-ES" },
    { code: "fr-FR", label: "French", nativeLabel: "Français", speechLang: "fr-FR" },
    { code: "de-DE", label: "German", nativeLabel: "Deutsch", speechLang: "de-DE" },
    { code: "ar-SA", label: "Arabic", nativeLabel: "العربية", speechLang: "ar-SA" },
    { code: "zh-CN", label: "Chinese (Mandarin)", nativeLabel: "中文", speechLang: "zh-CN" },
    { code: "ja-JP", label: "Japanese", nativeLabel: "日本語", speechLang: "ja-JP" },
    { code: "pt-BR", label: "Portuguese", nativeLabel: "Português", speechLang: "pt-BR" },
    { code: "ru-RU", label: "Russian", nativeLabel: "Русский", speechLang: "ru-RU" },
    { code: "bn-IN", label: "Bengali", nativeLabel: "বাংলা", speechLang: "bn-IN" },
    { code: "ta-IN", label: "Tamil", nativeLabel: "தமிழ்", speechLang: "ta-IN" },
    { code: "te-IN", label: "Telugu", nativeLabel: "తెలుగు", speechLang: "te-IN" },
  ];

  class VisionVoice {
    constructor(options) {
      this.onFinalTranscript =
        typeof options.onFinalTranscript === "function" ? options.onFinalTranscript : function () {};
      this.onInterimTranscript =
        typeof options.onInterimTranscript === "function" ? options.onInterimTranscript : function () {};
      this.onListeningStateChange =
        typeof options.onListeningStateChange === "function"
          ? options.onListeningStateChange
          : function () {};
      this.onSpeechStateChange =
        typeof options.onSpeechStateChange === "function" ? options.onSpeechStateChange : function () {};
      this.onVoiceError =
        typeof options.onVoiceError === "function" ? options.onVoiceError : function () {};
      this.onVoicesUpdated =
        typeof options.onVoicesUpdated === "function" ? options.onVoicesUpdated : function () {};

      this.language = "en-US";
      this.volume = 1.0;
      this.shouldListen = false;
      this.listeningActive = false;
      this.speakingActive = false;
      this.recognitionBlocked = false;
      this.recognition = null;
      this.voices = [];
      this.restartTimer = null;
      this.resumeAfterSpeechTimer = null;
      this.speechWatchdogTimer = null;

      this.loadVoices();
      if (this.isSynthesisSupported() && typeof global.speechSynthesis.addEventListener === "function") {
        global.speechSynthesis.addEventListener("voiceschanged", () => {
          this.loadVoices();
        });
      }
    }

    getSupportedLanguages() {
      return SUPPORTED_LANGUAGES.slice();
    }

    isRecognitionSupported() {
      return Boolean(global.SpeechRecognition || global.webkitSpeechRecognition);
    }

    isSynthesisSupported() {
      return Boolean(global.speechSynthesis && typeof global.SpeechSynthesisUtterance === "function");
    }

    isMicrophoneSupported() {
      return Boolean(
        global.navigator &&
          global.navigator.mediaDevices &&
          typeof global.navigator.mediaDevices.getUserMedia === "function"
      );
    }

    isSpeaking() {
      return this.speakingActive;
    }

    loadVoices() {
      if (!this.isSynthesisSupported()) {
        this.voices = [];
        return;
      }
      try {
        this.voices = global.speechSynthesis.getVoices() || [];
      } catch (_err) {
        this.voices = [];
      }
      this.onVoicesUpdated(this.getCompatibilitySummary(this.language));
    }

    findBestVoice(langCode) {
      if (!this.voices.length) {
        return null;
      }
      const lower = langCode.toLowerCase();
      const base = lower.split("-")[0];

      const exact = this.voices.find(function (v) {
        return v.lang && v.lang.toLowerCase() === lower;
      });
      if (exact) {
        return exact;
      }

      const prefix = this.voices.find(function (v) {
        return v.lang && v.lang.toLowerCase().split("-")[0] === base;
      });
      return prefix || null;
    }

    getCompatibilitySummary(langCode) {
      const lang = langCode || this.language;
      const recOk = this.isRecognitionSupported();
      const ttsOk = this.isSynthesisSupported();
      const matchedVoice = this.findBestVoice(lang);

      if (!recOk && !ttsOk) {
        return "Browser speech recognition and spoken output are unavailable here. You can still use typed questions and read responses on screen.";
      }
      if (!recOk) {
        return "Voice input (SpeechRecognition) is not supported in this browser; typed questions work normally. Spoken output is active.";
      }
      if (!ttsOk) {
        return "Voice input is supported, but browser text-to-speech is unavailable on this device.";
      }
      if (this.voices.length > 0 && !matchedVoice) {
        return "No dedicated voice for this language was found on your device; the AI will answer in your chosen language, and speech voice quality depends on your browser and OS.";
      }
      if (matchedVoice) {
        return (
          "Using device voice \"" +
          matchedVoice.name +
          "\". Available languages and voice quality depend on your browser and device."
        );
      }
      return "Speech recognition and spoken voice quality depend on your browser and device.";
    }

    setLanguage(langCode) {
      const found = SUPPORTED_LANGUAGES.find(function (item) {
        return item.code === langCode;
      });
      this.language = found ? found.code : "en-US";
      this.onVoicesUpdated(this.getCompatibilitySummary(this.language));

      if (this.shouldListen && this.recognition && !this.speakingActive) {
        this.pauseRecognitionTemporarily();
        this.scheduleRecognitionRestart(150);
      }
    }

    setVolume(volumeFloat) {
      const clamped = Math.min(1, Math.max(0, Number(volumeFloat)));
      this.volume = Number.isFinite(clamped) ? clamped : 1.0;
    }

    async requestMicrophonePermission() {
      if (!this.isMicrophoneSupported()) {
        return {
          ok: false,
          code: "MIC_UNSUPPORTED",
          message:
            "Microphone access is unavailable in this browser or requires a secure HTTPS connection.",
        };
      }

      try {
        const probeStream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
        probeStream.getTracks().forEach(function (track) {
          track.stop();
        });
        this.recognitionBlocked = false;
        return { ok: true };
      } catch (err) {
        const name = err && err.name ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          return {
            ok: false,
            code: "MIC_PERMISSION_DENIED",
            message:
              "Microphone permission was denied. Allow microphone access to ask questions by voice, or type questions below.",
          };
        }
        if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          return {
            ok: false,
            code: "MIC_NOT_FOUND",
            message:
              "No microphone was found on this device. You can still type questions below.",
          };
        }
        if (name === "NotReadableError" || name === "TrackStartError") {
          return {
            ok: false,
            code: "MIC_IN_USE",
            message:
              "Microphone could not be opened because another app is using it.",
          };
        }
        return {
          ok: false,
          code: "MIC_ERROR",
          message:
            "Microphone initialization failed: " +
            (err && err.message ? err.message : "Unknown microphone error."),
        };
      }
    }

    startListening() {
      if (!this.isRecognitionSupported()) {
        this.shouldListen = false;
        this.onListeningStateChange(false, "Voice recognition unsupported in this browser.");
        return {
          ok: false,
          code: "SPEECH_RECOGNITION_UNSUPPORTED",
          message:
            "Speech recognition is not supported in this browser. Type your questions in the text box instead.",
        };
      }

      this.shouldListen = true;
      this.recognitionBlocked = false;
      if (!this.speakingActive) {
        this.beginRecognitionSession();
      }
      return { ok: true };
    }

    beginRecognitionSession() {
      if (!this.shouldListen || this.speakingActive || this.recognitionBlocked) {
        return;
      }

      const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
      if (!SpeechRec) {
        return;
      }

      this.clearRestartTimers();

      if (this.recognition) {
        try {
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.abort();
        } catch (_err) {
          // Ignore cleanup errors.
        }
        this.recognition = null;
      }

      const recognition = new SpeechRec();
      recognition.lang = this.language;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        this.listeningActive = true;
        this.onListeningStateChange(true, "Listening in " + this.language + "...");
      };

      recognition.onresult = (event) => {
        if (this.speakingActive) {
          return;
        }
        let interim = "";
        let finalText = "";

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result || !result[0]) {
            continue;
          }
          const transcript = String(result[0].transcript || "").trim();
          if (!transcript) {
            continue;
          }
          if (result.isFinal) {
            finalText += (finalText ? " " : "") + transcript;
          } else {
            interim += (interim ? " " : "") + transcript;
          }
        }

        if (interim) {
          this.onInterimTranscript(interim);
        }

        if (finalText) {
          this.onInterimTranscript("");
          this.onFinalTranscript(finalText);
        }
      };

      recognition.onerror = (event) => {
        const errCode = event && event.error ? event.error : "unknown";
        if (errCode === "aborted" || errCode === "no-speech") {
          return;
        }
        if (errCode === "not-allowed" || errCode === "service-not-allowed") {
          this.recognitionBlocked = true;
          this.shouldListen = false;
          this.listeningActive = false;
          const msg =
            "Voice recognition permission was denied or blocked by the browser. You can still type questions below.";
          this.onListeningStateChange(false, msg);
          this.onVoiceError(msg);
          return;
        }
        if (errCode === "audio-capture") {
          this.recognitionBlocked = true;
          this.shouldListen = false;
          this.listeningActive = false;
          const msg = "No working microphone audio capture device is available.";
          this.onListeningStateChange(false, msg);
          this.onVoiceError(msg);
          return;
        }
        if (errCode === "network") {
          this.onVoiceError(
            "Browser speech recognition encountered a network issue and will retry."
          );
        }
      };

      recognition.onend = () => {
        this.listeningActive = false;
        if (this.recognition === recognition) {
          this.recognition = null;
        }
        if (this.shouldListen && !this.speakingActive && !this.recognitionBlocked) {
          this.onListeningStateChange(false, "Reconnecting microphone listener...");
          this.scheduleRecognitionRestart(300);
        } else if (!this.shouldListen) {
          this.onListeningStateChange(false, "Microphone listener stopped.");
        }
      };

      this.recognition = recognition;
      try {
        recognition.start();
      } catch (_err) {
        this.scheduleRecognitionRestart(450);
      }
    }

    scheduleRecognitionRestart(delayMs) {
      this.clearRestartTimers();
      if (!this.shouldListen || this.speakingActive || this.recognitionBlocked) {
        return;
      }
      this.restartTimer = global.setTimeout(() => {
        this.restartTimer = null;
        this.beginRecognitionSession();
      }, delayMs);
    }

    pauseRecognitionTemporarily() {
      this.clearRestartTimers();
      this.listeningActive = false;
      if (this.recognition) {
        try {
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.abort();
        } catch (_err) {
          // Ignore abort failure.
        }
        this.recognition = null;
      }
      this.onListeningStateChange(false, "Paused while assistant speaks.");
    }

    clearRestartTimers() {
      if (this.restartTimer) {
        global.clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      if (this.resumeAfterSpeechTimer) {
        global.clearTimeout(this.resumeAfterSpeechTimer);
        this.resumeAfterSpeechTimer = null;
      }
    }

    clearSpeechWatchdog() {
      if (this.speechWatchdogTimer) {
        global.clearTimeout(this.speechWatchdogTimer);
        this.speechWatchdogTimer = null;
      }
    }

    stopListening() {
      this.shouldListen = false;
      this.clearRestartTimers();
      this.listeningActive = false;
      if (this.recognition) {
        try {
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.stop();
        } catch (_err) {
          // Ignore stop failure.
        }
        this.recognition = null;
      }
      this.onInterimTranscript("");
      this.onListeningStateChange(false, "Microphone listener stopped.");
    }

    speak(text, options) {
      const opts = options || {};
      const cleanText = String(text || "").trim();
      if (!cleanText) {
        return Promise.resolve();
      }

      this.interruptSpeech({ skipResume: true });

      if (!this.isSynthesisSupported() || this.volume <= 0) {
        if (this.shouldListen && !opts.skipResume) {
          this.scheduleRecognitionRestart(200);
        }
        return Promise.resolve();
      }

      // Pause voice recognition before speaking so assistant audio does not trigger itself.
      if (this.shouldListen) {
        this.pauseRecognitionTemporarily();
      }

      return new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) {
            return;
          }
          finished = true;
          this.clearSpeechWatchdog();
          this.speakingActive = false;
          this.onSpeechStateChange(false);

          if (this.shouldListen && !opts.skipResume && !this.recognitionBlocked) {
            this.resumeAfterSpeechTimer = global.setTimeout(() => {
              this.resumeAfterSpeechTimer = null;
              this.beginRecognitionSession();
            }, 220);
          }
          resolve();
        };

        const utterance = new global.SpeechSynthesisUtterance(cleanText);
        utterance.lang = this.language;
        utterance.volume = this.volume;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        const voice = this.findBestVoice(this.language);
        if (voice) {
          utterance.voice = voice;
        }

        utterance.onstart = () => {
          this.speakingActive = true;
          this.onSpeechStateChange(true);
        };
        utterance.onend = finish;
        utterance.onerror = finish;

        const estimatedMs = Math.min(45000, Math.max(6000, cleanText.length * 110));
        this.speechWatchdogTimer = global.setTimeout(finish, estimatedMs);

        try {
          this.speakingActive = true;
          this.onSpeechStateChange(true);
          global.speechSynthesis.speak(utterance);
        } catch (_err) {
          finish();
        }
      });
    }

    interruptSpeech(options) {
      const opts = options || {};
      this.clearSpeechWatchdog();
      if (this.isSynthesisSupported()) {
        try {
          global.speechSynthesis.cancel();
        } catch (_err) {
          // Ignore synthesis cancel failure.
        }
      }
      const wasSpeaking = this.speakingActive;
      this.speakingActive = false;
      this.onSpeechStateChange(false);

      if (wasSpeaking && this.shouldListen && !opts.skipResume && !this.recognitionBlocked) {
        this.scheduleRecognitionRestart(180);
      }
    }
  }

  global.VisionVoice = VisionVoice;
})(window);
