/** A surface ID is only unique inside its owner. Detached previews and app
 * surfaces can share IDs with a chat without acquiring that chat's authority. */
export function ownsSurfaceEvent(event: Event, owners: ReadonlyMap<string, EventTarget>, surface: string): boolean {
  const owner = owners.get(surface);
  return Boolean(owner && event.composedPath().includes(owner));
}
