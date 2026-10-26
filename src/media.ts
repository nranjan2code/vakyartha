import type { MediaResource } from "@vak/web";
import { engine } from "./core.ts";

/** Only the app's opaque media IDs can reach its authenticated file route. */
export async function resolveMedia(uri: string): Promise<MediaResource | undefined> {
  const id = /^media:([0-9a-f-]{36})$/.exec(uri)?.[1];
  if (!id) return undefined;
  const { url, token } = engine();
  const res = await fetch(`${url}/api/media/assets/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("The saved media file is unavailable");
  const blob = await res.blob();
  const source = URL.createObjectURL(blob);
  return { url: source, release: () => URL.revokeObjectURL(source) };
}
const players = new Set<HTMLMediaElement>();
globalThis.document?.addEventListener("vak-media-state", (event) => {
  const detail = (event as CustomEvent<{ player?: HTMLMediaElement }>).detail;
  if (detail?.player instanceof HTMLMediaElement) players.add(detail.player);
  for (const player of players) if (!player.isConnected) players.delete(player);
});
export function mediaPlaying(): boolean { return [...players].some((p) => p.isConnected && !p.paused && !p.muted && p.volume > 0); }
export function pauseMedia(): void { for (const player of players) if (player.isConnected) player.pause(); }
