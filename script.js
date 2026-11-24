(function (global, doc) {
  "use strict";

  const STORAGE_KEYS = {
    language: "vision_ai_language",
    volume: "vision_ai_volume",
  };

  function safeStorageGet(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (_err) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(key, value);
      }
    } catch (_err) {
      // Ignore storage failures in restricted contexts.
    }
  }

  function formatTimeNow() {
    try {
      return new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_err) {
      return "";
    }
  }

  doc.addEventListener("DOMContentLoaded", function () {
    const startStopBtn = doc.getElementById("start-stop-btn");
    const startStopLabel = doc.getElementById("start-stop-label");
    const startStopIcon = doc.getElementById("start-stop-icon");
    const interruptBtn = doc.getElementById("interrupt-btn");
    const analyzeNowBtn = doc.getElementById("analyze-now-btn");
    const switchCameraBtn = doc.getElementById("switch-camera-btn");
    const statusBanner = doc.getElementById("status-banner");
    const statusStateLabel = doc.getElementById("status-state-label");
    const statusMessage = doc.getElementById("status-message");
    const backendNotice = doc.getElementById("backend-notice");
    const cameraPreview = doc.getElementById("camera-preview");
    const cameraFallback = doc.getElementById("camera-fallback");
    const cameraFallbackText = doc.getElementById("camera-fallback-text");
    const cameraResolution = doc.getElementById("camera-resolution");
    const languageSelect = doc.getElementById("language-select");
    const voiceCompatNote = doc.getElementById("voice-compat-note");
    const volumeSlider = doc.getElementById("volume-slider");
    const volumeValue = doc.getElementById("volume-value");
    const awarenessToggle = doc.getElementById("awareness-toggle");
    const transcriptText = doc.getElementById("transcript-text");
    const questionForm = doc.getElementById("question-form");
    const questionInput = doc.getElementById("question-input");
    const clearHistoryBtn = doc.getElementById("clear-history-btn");
    const conversationLog = doc.getElementById("conversation-log");
    const emptyLogState = doc.getElementById("empty-log-state");
    const quickButtons = doc.querySelectorAll(".btn-quick");

    const PLAY_SVG =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
    const STOP_SVG =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>';

    function updateStatus(tone, stateTitle, detailText) {
      statusBanner.className = "status-banner status-" + tone;
      statusStateLabel.textContent = stateTitle;
      statusMessage.textContent = detailText;
    }

    function appendLogEntry(type, speaker, text) {
      if (emptyLogState && emptyLogState.parentNode === conversationLog) {
        emptyLogState.hidden = true;
      }

      const entry = doc.createElement("article");
      entry.className = "log-entry entry-" + type;

      const meta = doc.createElement("div");
      meta.className = "log-entry-meta";

      const speakerSpan = doc.createElement("span");
      speakerSpan.className = "log-entry-speaker";
      speakerSpan.textContent = speaker;

      const timeSpan = doc.createElement("time");
      timeSpan.className = "mono-meta tabular-nums";
      timeSpan.textContent = formatTimeNow();

      meta.appendChild(speakerSpan);
      meta.appendChild(timeSpan);

      const body = doc.createElement("p");
      body.className = "log-entry-text";
      body.textContent = text;

      entry.appendChild(meta);
      entry.appendChild(body);
      conversationLog.appendChild(entry);
      conversationLog.scrollTop = conversationLog.scrollHeight;
    }

    function updateCameraUI(active) {
      if (active && camera.isReady()) {
        cameraFallback.hidden = true;
        cameraResolution.textContent = camera.getResolutionLabel();
        switchCameraBtn.hidden = !camera.hasMultipleCameras();
      } else {
        cameraFallback.hidden = false;
        cameraResolution.textContent = "Camera off";
        switchCameraBtn.hidden = true;
      }
    }

    const camera = new global.VisionCamera({
      videoEl: cameraPreview,
      onDisconnect: function () {
        cameraFallbackText.textContent =
          "Camera disconnected. Press START ASSISTANT to reconnect.";
        updateCameraUI(false);
        assistant.handleCameraDisconnected();
      },
      onDevicesChanged: function (devices) {
        switchCameraBtn.hidden = !(assistant.isActive() && devices.length > 1);
      },
    });

    const voice = new global.VisionVoice({
      onFinalTranscript: function (transcript) {
        assistant.setUserSpeakingInterim(false);
        assistant.askQuestion(transcript, "voice");
      },
      onInterimTranscript: function (interim) {
        if (interim) {
          assistant.setUserSpeakingInterim(true);
          transcriptText.textContent = "Hearing: \"" + interim + "\"";
        } else {
          assistant.setUserSpeakingInterim(false);
        }
      },
      onListeningStateChange: function (_listening, label) {
        transcriptText.textContent = label;
      },
      onSpeechStateChange: function (speaking) {
        interruptBtn.disabled = !speaking;
      },
      onVoiceError: function (msg) {
        appendLogEntry("error", "Voice Notice", msg);
      },
      onVoicesUpdated: function (compatNote) {
        voiceCompatNote.textContent = compatNote;
      },
    });

    const assistant = new global.VisionAssistant({
      camera: camera,
      voice: voice,
      onStatusChange: updateStatus,
      onActiveChange: function (isActive, isStarting) {
        startStopBtn.disabled = Boolean(isStarting);
        startStopBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
        startStopBtn.classList.toggle("is-active", isActive);
        startStopLabel.textContent = isStarting
          ? "STARTING..."
          : isActive
          ? "STOP ASSISTANT"
          : "START ASSISTANT";
        startStopIcon.innerHTML = isActive ? STOP_SVG : PLAY_SVG;
        analyzeNowBtn.disabled = !isActive;

        if (!isActive && !isStarting) {
          cameraFallbackText.textContent =
            "Camera preview will appear here after you press START ASSISTANT and allow access.";
        }
        updateCameraUI(isActive);
      },
      onLogEntry: appendLogEntry,
      onAutoAwarenessChange: function (enabled) {
        awarenessToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
        awarenessToggle.textContent = enabled ? "Auto: On" : "Auto: Paused";
      },
    });

    // Populate language selector dynamically from VisionVoice registry.
    const languages = voice.getSupportedLanguages();
    languages.forEach(function (lang) {
      const option = doc.createElement("option");
      option.value = lang.code;
      option.textContent = lang.label + " (" + lang.nativeLabel + ")";
      languageSelect.appendChild(option);
    });

    const savedLanguage = safeStorageGet(STORAGE_KEYS.language);
    if (
      savedLanguage &&
      languages.some(function (lang) {
        return lang.code === savedLanguage;
      })
    ) {
      languageSelect.value = savedLanguage;
    } else {
      languageSelect.value = "en-US";
    }
    voice.setLanguage(languageSelect.value);

    const savedVolume = safeStorageGet(STORAGE_KEYS.volume);
    if (savedVolume !== null && !Number.isNaN(Number(savedVolume))) {
      const clampedVol = Math.min(100, Math.max(0, Number(savedVolume)));
      volumeSlider.value = String(clampedVol);
    }
    const syncVolume = function () {
      const pct = Number(volumeSlider.value);
      volumeValue.textContent = pct + "%";
      volumeSlider.setAttribute("aria-valuenow", String(pct));
      voice.setVolume(pct / 100);
      safeStorageSet(STORAGE_KEYS.volume, String(pct));
    };
    syncVolume();

    // Event wiring.
    startStopBtn.addEventListener("click", function () {
      if (assistant.isActive()) {
        assistant.stop();
      } else {
        assistant.start();
      }
    });

    interruptBtn.addEventListener("click", function () {
      voice.interruptSpeech();
      if (assistant.isActive()) {
        updateStatus("active", "Listening", "Speech interrupted. Listening for your question...");
      }
    });

    analyzeNowBtn.addEventListener("click", function () {
      assistant.analyzeNow();
    });

    switchCameraBtn.addEventListener("click", async function () {
      if (!assistant.isActive()) {
        return;
      }
      switchCameraBtn.disabled = true;
      updateStatus("active", "Switching Camera", "Switching camera input...");
      const res = await camera.switchCamera();
      switchCameraBtn.disabled = false;
      if (res.ok) {
        updateCameraUI(true);
        updateStatus("active", "Camera Switched", "Active resolution: " + res.resolution);
      } else {
        updateStatus("error", "Camera Error", res.message);
        appendLogEntry("error", "Camera Error", res.message);
      }
    });

    languageSelect.addEventListener("change", function () {
      const selected = languageSelect.value;
      voice.setLanguage(selected);
      safeStorageSet(STORAGE_KEYS.language, selected);
    });

    volumeSlider.addEventListener("input", syncVolume);

    awarenessToggle.addEventListener("click", function () {
      assistant.setAutoAwareness(!assistant.isAutoAwarenessEnabled());
    });

    questionForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const text = questionInput.value.trim();
      if (!text) {
        questionInput.focus();
        return;
      }
      questionInput.value = "";
      assistant.askQuestion(text, "text");
    });

    questionInput.addEventListener("input", function () {
      if (voice.isSpeaking() && questionInput.value.trim().length > 0) {
        voice.interruptSpeech();
      }
    });

    quickButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const promptText = button.getAttribute("data-question");
        if (promptText) {
          assistant.askQuestion(promptText, "text");
        }
      });
    });

    clearHistoryBtn.addEventListener("click", function () {
      assistant.clearHistory();
      const entries = conversationLog.querySelectorAll(".log-entry");
      entries.forEach(function (node) {
        node.remove();
      });
      if (emptyLogState) {
        emptyLogState.hidden = false;
      }
    });

    doc.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && voice.isSpeaking()) {
        event.preventDefault();
        voice.interruptSpeech();
        if (assistant.isActive()) {
          updateStatus("active", "Listening", "Speech interrupted. Listening for your question...");
        }
      } else if (event.altKey && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        startStopBtn.click();
      } else if (event.altKey && (event.key === "a" || event.key === "A")) {
        if (!analyzeNowBtn.disabled) {
          event.preventDefault();
          analyzeNowBtn.click();
        }
      }
    });

    global.addEventListener("beforeunload", function () {
      assistant.stop();
    });

    // Check backend health transparently on startup.
    global
      .fetch("/health")
      .then(function (res) {
        return res.json();
      })
      .then(function (health) {
        if (!health || !health.ok) {
          return;
        }
        if (!health.groq_configured) {
          backendNotice.hidden = false;
          backendNotice.textContent =
            "Backend notice: GROQ_API_KEY is not configured on the server yet. Camera and microphone controls will work, and AI vision analysis will start working once GROQ_API_KEY is set.";
        } else {
          backendNotice.hidden = true;
        }
      })
      .catch(function () {
        backendNotice.hidden = false;
        backendNotice.textContent =
          "Backend notice: Could not reach /health endpoint. Make sure the Flask backend server is running.";
      });
  });
})(window, document);
