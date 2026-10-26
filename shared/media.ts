// Shared capability names; provider wire formats stay in their adapters.
export const MEDIA_KINDS = ["image", "audio", "video"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const MEDIA_OPERATIONS = {
  image: { generate_image: "Generate an image", edit_image: "Edit an image" },
  audio: { create_speech: "Create narration", transcribe_audio: "Transcribe audio", create_music: "Create music", create_sound_effect: "Create a sound effect", isolate_audio: "Isolate speech" },
  video: { generate_video: "Generate a video", animate_image: "Animate an image", edit_video: "Edit a video", reframe_video: "Reframe a video" },
} as const;
export type MediaOperation = keyof typeof MEDIA_OPERATIONS.image | keyof typeof MEDIA_OPERATIONS.audio | keyof typeof MEDIA_OPERATIONS.video;
export interface MediaModel { provider: string; model: string; label: string; operations: MediaOperation[]; note?: string; local?: boolean; voices?: { id: string; name: string }[] }
export interface MediaProvider { id: string; label: string; keyVar?: string; available: boolean }
export interface MediaAsset { id: string; type: string; name: string; bytes: number; created: string; source?: string }
export type MediaJobState = "submitting" | "running" | "succeeded" | "failed" | "interrupted" | "unknown";
export interface MediaJob {
  id: string; kind: MediaKind; operation: MediaOperation; selection: string; created: string;
  state: MediaJobState; inputs: string[]; assets: string[]; remoteId?: string;
  error?: string; usage?: unknown;
  session?: string; surface?: string; projectionError?: string;
}
export interface MediaView { kind: MediaKind; models: MediaModel[]; providers: MediaProvider[]; jobs: MediaJob[]; assets: MediaAsset[] }
export const mediaSelection = (m: Pick<MediaModel, "provider" | "model">) => `${m.provider}|${m.model}`;
export const isMediaKind = (x: string): x is MediaKind => (MEDIA_KINDS as readonly string[]).includes(x);
export function operationKind(operation: string): MediaKind | undefined { return MEDIA_KINDS.find((kind) => Object.hasOwn(MEDIA_OPERATIONS[kind], operation)); }
