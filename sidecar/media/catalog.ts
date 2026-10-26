import { MEDIA_OPERATIONS, type MediaKind, type MediaModel, type MediaProvider } from "../../shared/media.ts";
export const PROVIDERS = [
  { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY" },
  { id: "gemini", label: "Google Gemini", keyVar: "GEMINI_API_KEY" },
  { id: "elevenlabs", label: "ElevenLabs", keyVar: "ELEVENLABS_API_KEY" },
  { id: "fal", label: "fal", keyVar: "FAL_KEY" },
  { id: "luma", label: "Luma", keyVar: "LUMA_AGENTS_API_KEY" },
] as const;
// Only app-specific providers are declared here; chat and voice own their keys.
export const MEDIA_KEYS = PROVIDERS.filter((p) => p.id === "fal" || p.id === "luma").map((p) => ({ name: p.keyVar, label: `${p.label} API key`, owner: p.id }));
const image = ["generate_image", "edit_image"] as const;
export const MODELS: MediaModel[] = [
  ...["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map((model) => ({ provider: "openai", model, label: model, note: "Generate or edit one image; PNG masks, true transparency and quality controls. Flare favors speed; Sunburst favors quality.", operations: [...image] })),
  ...["gemini-nano-banana-2.1", "gemini-3-pro-image"].map((model) => ({ provider: "gemini", model, label: model, note: "Generate or edit from one reference image. Aspect ratio control; no mask or alpha-output guarantee in this adapter.", operations: [...image] })),
  { provider: "fal", model: "fal-ai/flux-2-pro", label: "FLUX.2 Pro · Black Forest Labs", operations: ["generate_image"] },
  { provider: "fal", model: "fal-ai/flux-2-pro/edit", label: "FLUX.2 Pro Edit · Black Forest Labs", operations: ["edit_image"] },
  ...["music_v2_5", "music_v2"].map((model): MediaModel => ({ provider: "elevenlabs", model, label: model, operations: ["create_music"] })),
  { provider: "elevenlabs", model: "eleven_text_to_sound_v2", label: "Sound Effects v2", operations: ["create_sound_effect"] },
  { provider: "elevenlabs", model: "voice-isolation", label: "Voice isolation", operations: ["isolate_audio"] },
  { provider: "luma", model: "ray-3.2", label: "Ray 3.2", note: "720p, 5 or 10 seconds; source-video edits and reframing. Uploaded source footage must be 18 seconds or shorter.", operations: ["generate_video", "animate_image", "edit_video", "reframe_video"] },
  { provider: "fal", model: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling 3.0 Pro", note: "3–15 seconds; optional native audio, off by default. Native speech supports English and Chinese. Single-prompt generation.", operations: ["generate_video"] },
  { provider: "fal", model: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling 3.0 Pro", note: "Start and optional end frame; 3–15 seconds. Optional native audio, off by default; English and Chinese speech.", operations: ["animate_image"] },
];
export function providerViews(env: Record<string, string | undefined>): MediaProvider[] { return PROVIDERS.map((p) => ({ ...p, available: Boolean(env[p.keyVar]) })); }
export function operations(kind: MediaKind): [string, string][] { return Object.entries(MEDIA_OPERATIONS[kind]); }
