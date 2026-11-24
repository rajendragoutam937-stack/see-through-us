(function (global) {
  "use strict";

  const MAX_CAPTURE_WIDTH = 960;
  const CAPTURE_QUALITY = 0.78;
  const VIDEO_READY_TIMEOUT_MS = 8000;

  class VisionCamera {
    constructor(options) {
      this.videoEl = options.videoEl;
      this.onDisconnect = typeof options.onDisconnect === "function" ? options.onDisconnect : function () {};
      this.onDevicesChanged =
        typeof options.onDevicesChanged === "function" ? options.onDevicesChanged : function () {};

      this.stream = null;
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d");
      this.facingMode = "environment";
      this.videoDevices = [];
      this.activeDeviceId = null;
    }

    isSupported() {
      return Boolean(
        global.navigator &&
          global.navigator.mediaDevices &&
          typeof global.navigator.mediaDevices.getUserMedia === "function"
      );
    }

    isReady() {
      return Boolean(
        this.stream &&
          this.videoEl &&
          this.videoEl.srcObject &&
          this.videoEl.readyState >= 2 &&
          this.videoEl.videoWidth > 0 &&
          this.videoEl.videoHeight > 0
      );
    }

    getResolutionLabel() {
      if (!this.isReady()) {
        return "Camera off";
      }
      return this.videoEl.videoWidth + " x " + this.videoEl.videoHeight;
    }

    hasMultipleCameras() {
      return this.videoDevices.length > 1;
    }

    async refreshDeviceList() {
      if (!this.isSupported() || typeof global.navigator.mediaDevices.enumerateDevices !== "function") {
        this.videoDevices = [];
        this.onDevicesChanged(this.videoDevices);
        return this.videoDevices;
      }
      try {
        const devices = await global.navigator.mediaDevices.enumerateDevices();
        this.videoDevices = devices.filter(function (device) {
          return device.kind === "videoinput";
        });
        this.onDevicesChanged(this.videoDevices);
      } catch (_err) {
        this.videoDevices = [];
        this.onDevicesChanged(this.videoDevices);
      }
      return this.videoDevices;
    }

    mapCameraError(err) {
      const name = err && err.name ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        return {
          code: "CAMERA_PERMISSION_DENIED",
          message:
            "Camera permission was denied. Allow camera access in your browser settings and press START ASSISTANT again.",
        };
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return {
          code: "CAMERA_NOT_FOUND",
          message: "No camera device was detected on this device.",
        };
      }
      if (name === "NotReadableError" || name === "TrackStartError") {
        return {
          code: "CAMERA_IN_USE",
          message:
            "Your camera is currently in use by another application or could not be opened.",
        };
      }
      if (name === "SecurityError") {
        return {
          code: "CAMERA_INSECURE_CONTEXT",
          message: "Camera access requires a secure HTTPS connection or localhost.",
        };
      }
      return {
        code: "CAMERA_ERROR",
        message:
          "Unable to start camera: " + (err && err.message ? err.message : "Unknown camera error."),
      };
    }

    async waitForVideoReady() {
      const video = this.videoEl;
      if (!video) {
        throw new Error("Video element is missing.");
      }

      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        return;
      }

      await new Promise(function (resolve, reject) {
        let settled = false;
        const timer = global.setTimeout(function () {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("Camera stream started, but video frames did not arrive in time."));
          }
        }, VIDEO_READY_TIMEOUT_MS);

        function checkReady() {
          if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !settled) {
            settled = true;
            cleanup();
            resolve();
          }
        }

        function onError() {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("Video preview element failed to load the camera stream."));
          }
        }

        function cleanup() {
          global.clearTimeout(timer);
          video.removeEventListener("loadedmetadata", checkReady);
          video.removeEventListener("loadeddata", checkReady);
          video.removeEventListener("canplay", checkReady);
          video.removeEventListener("error", onError);
        }

        video.addEventListener("loadedmetadata", checkReady);
        video.addEventListener("loadeddata", checkReady);
        video.addEventListener("canplay", checkReady);
        video.addEventListener("error", onError);
        checkReady();
      });
    }

    async start(preferredDeviceId) {
      if (!this.isSupported()) {
        return {
          ok: false,
          code: "CAMERA_UNSUPPORTED",
          message:
            "Camera access is not supported in this browser or requires HTTPS.",
        };
      }

      this.stop();

      const videoConstraints = preferredDeviceId
        ? { deviceId: { exact: preferredDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: this.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } };

      let stream = null;
      try {
        stream = await global.navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (err) {
        if (err && (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError")) {
          try {
            stream = await global.navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } catch (fallbackErr) {
            const mappedFallback = this.mapCameraError(fallbackErr);
            return { ok: false, code: mappedFallback.code, message: mappedFallback.message };
          }
        } else {
          const mapped = this.mapCameraError(err);
          return { ok: false, code: mapped.code, message: mapped.message };
        }
      }

      this.stream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = typeof videoTrack.getSettings === "function" ? videoTrack.getSettings() : {};
        this.activeDeviceId = settings.deviceId || preferredDeviceId || null;
        videoTrack.addEventListener("ended", () => {
          if (this.stream === stream) {
            this.stop();
            this.onDisconnect();
          }
        });
      }

      try {
        this.videoEl.srcObject = stream;
        await this.videoEl.play();
        await this.waitForVideoReady();
      } catch (playErr) {
        this.stop();
        return {
          ok: false,
          code: "CAMERA_PLAY_FAILED",
          message: playErr && playErr.message ? playErr.message : "Could not display camera feed.",
        };
      }

      await this.refreshDeviceList();

      return {
        ok: true,
        resolution: this.getResolutionLabel(),
      };
    }

    async switchCamera() {
      await this.refreshDeviceList();
      if (this.videoDevices.length > 1) {
        const currentIndex = this.videoDevices.findIndex(
          (device) => device.deviceId === this.activeDeviceId
        );
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % this.videoDevices.length : 0;
        const nextDevice = this.videoDevices[nextIndex];
        return this.start(nextDevice.deviceId);
      }

      this.facingMode = this.facingMode === "environment" ? "user" : "environment";
      return this.start(null);
    }

    captureFrame() {
      if (!this.isReady() || !this.ctx) {
        return {
          ok: false,
          code: "CAMERA_NOT_READY",
          message: "Camera is not active or frame is not ready yet.",
        };
      }

      const sourceWidth = this.videoEl.videoWidth;
      const sourceHeight = this.videoEl.videoHeight;
      if (!sourceWidth || !sourceHeight) {
        return {
          ok: false,
          code: "EMPTY_VIDEO_DIMENSIONS",
          message: "Camera frame dimensions are unavailable.",
        };
      }

      const scale = sourceWidth > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / sourceWidth : 1;
      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.ctx.drawImage(this.videoEl, 0, 0, targetWidth, targetHeight);

      const dataUrl = this.canvas.toDataURL("image/jpeg", CAPTURE_QUALITY);
      if (!dataUrl || dataUrl.indexOf("data:image/jpeg;base64,") !== 0 || dataUrl.length < 200) {
        return {
          ok: false,
          code: "FRAME_CAPTURE_FAILED",
          message: "Failed to encode a valid JPEG frame from the camera.",
        };
      }

      return {
        ok: true,
        dataUrl: dataUrl,
        width: targetWidth,
        height: targetHeight,
      };
    }

    stop() {
      if (this.stream) {
        this.stream.getTracks().forEach(function (track) {
          try {
            track.stop();
          } catch (_err) {
            // Ignore cleanup errors on already-stopped tracks.
          }
        });
        this.stream = null;
      }
      if (this.videoEl) {
        try {
          this.videoEl.pause();
        } catch (_err) {
          // Ignore pause error.
        }
        this.videoEl.srcObject = null;
      }
      this.activeDeviceId = null;
    }
  }

  global.VisionCamera = VisionCamera;
})(window);
