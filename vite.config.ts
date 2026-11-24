import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

const DEFAULT_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_QUESTION_CHARS = 500;
const ALLOWED_MODES = new Set(['initial', 'question', 'continuous']);
const SUPPORTED_LANGUAGES: Record<string, string> = {
  'en-US': 'English',
  'hi-IN': 'Hindi',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'ar-SA': 'Arabic',
  'zh-CN': 'Chinese (Simplified)',
  'ja-JP': 'Japanese',
  'pt-BR': 'Portuguese',
  'ru-RU': 'Russian',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
};

function visionPreviewMiddleware(): Plugin {
  return {
    name: 'vision-ai-preview-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = (req.url || '').split('?')[0];

        const blockedPaths = new Set([
          '/app.py',
          '/requirements.txt',
          '/README.md',
          '/.env',
          '/.env.example',
          '/vision-ai.zip',
          '/package.json',
          '/tsconfig.json',
          '/vite.config.ts',
          '/metadata.json',
        ]);
        if (blockedPaths.has(urlPath) || urlPath.startsWith('/vision-ai/')) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ok: false, error: 'Resource not found.'}));
          return;
        }

        if (req.method === 'GET' && urlPath === '/health') {
          const groqKey = (process.env.GROQ_API_KEY || '').trim();
          const model = (process.env.GROQ_VISION_MODEL || '').trim() || DEFAULT_VISION_MODEL;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              ok: true,
              status: groqKey ? 'healthy' : 'degraded_missing_api_key',
              groq_configured: Boolean(groqKey),
              model,
              max_image_bytes: MAX_IMAGE_BYTES,
              supported_languages: Object.keys(SUPPORTED_LANGUAGES),
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }

        if (req.method === 'POST' && urlPath === '/api/vision') {
          const groqKey = (process.env.GROQ_API_KEY || '').trim();
          if (!groqKey) {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  'Server configuration error: GROQ_API_KEY is not set. Configure GROQ_API_KEY in your environment variables.',
                code: 'MISSING_API_KEY',
              }),
            );
            return;
          }

          try {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            for await (const chunk of req) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              totalBytes += buf.length;
              if (totalBytes > 6 * 1024 * 1024) {
                res.statusCode = 413;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: 'Request payload is too large.',
                    code: 'PAYLOAD_TOO_LARGE',
                  }),
                );
                return;
              }
              chunks.push(buf);
            }

            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const image = typeof payload?.image === 'string' ? payload.image.trim() : '';
            const match = image.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
            if (!match) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'Invalid image format. Expected a base64 data URL for JPEG, PNG, or WebP.',
                  code: 'INVALID_IMAGE',
                }),
              );
              return;
            }

            const decoded = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
            if (decoded.length < 100 || decoded.length > MAX_IMAGE_BYTES) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'Image byte size is outside allowed bounds.',
                  code: 'INVALID_IMAGE',
                }),
              );
              return;
            }

            const mode = typeof payload?.mode === 'string' && ALLOWED_MODES.has(payload.mode) ? payload.mode : 'question';
            const rawQuestion = typeof payload?.question === 'string' ? payload.question.trim() : '';
            if (rawQuestion.length > MAX_QUESTION_CHARS) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Question exceeds maximum length of ${MAX_QUESTION_CHARS} characters.`,
                  code: 'QUESTION_TOO_LONG',
                }),
              );
              return;
            }

            const question = rawQuestion || 'What is in front of me?';
            const langCode = typeof payload?.language === 'string' ? payload.language.trim() : 'en-US';
            const languageName = SUPPORTED_LANGUAGES[langCode] || 'English';
            const model = (process.env.GROQ_VISION_MODEL || '').trim() || DEFAULT_VISION_MODEL;

            const systemPrompt =
              `You are VISION AI, a voice-first visual assistant helping a blind or low-vision user understand their surroundings. ` +
              `Respond naturally in ${languageName} in 1 to 3 concise spoken-friendly sentences without markdown or emojis. ` +
              `Never guarantee that a path is safe, never instruct the user to walk forward or cross a road, and use cautious phrasing for distances.`;

            const messages: Array<Record<string, unknown>> = [{role: 'system', content: systemPrompt}];
            if (Array.isArray(payload?.history)) {
              for (const turn of payload.history.slice(-4)) {
                if (
                  turn &&
                  (turn.role === 'user' || turn.role === 'assistant') &&
                  typeof turn.text === 'string' &&
                  turn.text.trim()
                ) {
                  messages.push({role: turn.role, content: turn.text.trim().slice(0, 300)});
                }
              }
            }
            messages.push({
              role: 'user',
              content: [
                {type: 'text', text: question},
                {type: 'image_url', image_url: {url: image}},
              ],
            });

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${groqKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model,
                messages,
                temperature: 0.3,
                max_completion_tokens: 240,
              }),
            });
            clearTimeout(timer);

            const groqData = (await groqResp.json()) as {
              choices?: Array<{message?: {content?: string}}>;
              error?: {message?: string};
            };

            if (!groqResp.ok) {
              res.statusCode = groqResp.status === 429 ? 429 : 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: groqData?.error?.message || `Groq API error (${groqResp.status}).`,
                  code: 'GROQ_API_ERROR',
                }),
              );
              return;
            }

            const answer = groqData?.choices?.[0]?.message?.content?.trim() || '';
            if (!answer) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'The AI vision model returned an empty response.',
                  code: 'EMPTY_MODEL_RESPONSE',
                }),
              );
              return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: true,
                answer,
                model,
                language: langCode,
                mode,
                timestamp: new Date().toISOString(),
              }),
            );
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'Unexpected preview server error.',
                code: 'INTERNAL_ERROR',
              }),
            );
          }
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      visionPreviewMiddleware(),
      {
        name: 'copy-flat-vision-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) {
            return;
          }
          const rootAssets = [
            'style.css',
            'camera.js',
            'voice.js',
            'assistant.js',
            'script.js',
          ];
          for (const fileName of rootAssets) {
            const srcPath = path.resolve(__dirname, fileName);
            const destPath = path.resolve(distDir, fileName);
            if (fs.existsSync(srcPath)) {
              fs.copyFileSync(srcPath, destPath);
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
