# Image, audio and video plugins

Implemented 2026-10-26. These are three independent, optional entries in Settings → Integrations: **Images**, **Audio** and **Video**. Each is off initially. They use the existing integration policies, approvals and call log; no additional server package, SDK, native runtime or IPC is installed.

## Setup and supported tools

Save a provider key once in Settings → Providers. The media/voice providers without chat models have their own cards there. Existing chat and Voice keys are shared; the plugins do not create secret copies. Local speech and transcription reuse the existing Voice setup and installed packs.

Open a media plugin, select a provider and model for each desired operation, save the selection and enable the plugin. An operation set to Off is not offered to the model. The plugin exposes only reviewed model/operation combinations and their supported controls. Selections are saved in the existing integration journal. Model choices and capability notes are maintained in `sidecar/media/catalog.ts`; speech/transcription models and voices come from the canonical Voice adapters. The external model/API review date is 2026-10-26. Account access and rates can differ and are not guaranteed by a catalog entry.

| Plugin | Implemented tools | Controls and limits |
| --- | --- | --- |
| Images | Generate; edit a supplied image | One output; a selected direct adapter supports PNG masks, true transparent output and quality. Reference-editing adapters without those controls do not expose them. Supported output shapes are explicit. |
| Audio | Narration; transcription; music; sound effects; speech isolation | Narration uses the selected model's actual voice IDs; the expressive dialogue route is bounded to 2,000 characters. Music is 3–30 seconds, effects 0.5–30 seconds. Transcription reuses the Voice adapters and currently accepts WAV under 8 MB. |
| Video | Text-to-video; image animation; source-video editing; reframing | One adapter supports 3–15-second generation, optional final-frame guidance and native audio (off by default). The other uses 720p, supports 5/10-second generation and 5-second anchored animation; uploaded source edits are limited by the provider to 18 seconds. Unsupported combinations fail before submission where the limit is locally knowable. |

Some current models need a different API workflow, not a renamed model parameter. Deprecated direct speech models remain labelled in Voice for existing users but are excluded from new media narration choices. The plugin does not silently select another model, provider or paid fallback.

Ask in an ordinary chat to use an enabled tool. Tool approvals show the selected provider/model and supplied inputs/controls. **Try it** runs as an explicit user command and can incur provider charges. The primary local conversation model can call these tools even when the selected media generator is hosted.

## References, saved files and results

Attach supported images, audio or video in chat, or import a reference in the plugin to obtain an asset ID. Imported files are local until an approved tool uploads them. Inputs are limited to 20 MB; original image attachment formats remain available to the separate recognition integration. Media tools accept only their private library or canonical chat-attachment paths. File signatures, real paths, final symlinks, sizes and operation-specific input kinds are checked.

Edits create a new file and keep their source. Output files use opaque IDs, private permissions and detected media types, with a 100 MB output cap. Downloads validate public destinations at connection time and every redirect; provider credentials are never forwarded to output hosts. The app does not execute or install downloaded files.

Completed results publish through the host's canonical session/store and enter the existing chat, canvas and artifact paths. Images/video prefer the canvas; compact audio can stay inline. The dedicated media projection provides the player/image, description and optional transcript. Private asset URIs contain no credentials; the app resolves them through authenticated HTTP and temporary browser URLs. Text/channel targets receive a description/transcript fallback rather than an unusable private file URL. The plugin's Results page renders copies of canonical snapshots for review; it does not author or persist another surface store. Open in chat returns to the canonical source.

Reference imports and generated files live in `<data>/media/` and remain in the media library until explicitly deleted. Removing a job record leaves files; deleting a file makes surfaces using it unavailable. Deleting a source chat detaches its media job links and stops local waiting; it does not silently delete independently saved media or claim to cancel hosted work. Exported/downloaded copies are outside app deletion scope.

## Background work and recovery

The tool returns a job receipt promptly. This is provider I/O without a second agent/model loop. At most three jobs run at once, with a 15-minute local deadline. The versioned, atomically replaced media journal has one app writer and holds up to 200 job records/1,000 assets; remove old records/files when those bounds are reached.

Remote job IDs are persisted before polling. Status checks use the known provider and model, never arbitrary URLs from a response. Waiting and result downloads do no conversation-model work. Provider/model changes, plugin disablement or changed credentials stop further guarded requests. Already transmitted work may continue remotely.

After restart, a job with a remote ID is interrupted and can resume status/download checks explicitly with the same selected model. A submission without a known remote identity is unknown and is never automatically resubmitted. A saved result whose chat was busy can be published again with Show result without generating again. **Stop waiting** stops local requests; it does not promise remote cancellation or a refund. Unknown remote work retains its recovery record until reconciled. A malformed journal disables media operations while preserving files and core app behavior.

## Voice and cost

The dedicated projection contributes captions to spoken summaries; transcripts are read only on an explicit details request. Playback choices enter the existing voice agenda. Play, pause, restart, mute and unmute activate the projector's local controls and never become model/tool actions. Browser playback restrictions produce a visible explanation rather than triggering a fallback call.

In conversation mode, barge-in pauses audible media. The overlapping utterance and a short echo tail are discarded before transcription, so a clip cannot answer an approval. A person repeats the command after playback pauses. Normal screen/keyboard controls remain available. Live-microphone behavior still requires the existing hands-on voice evaluation; synthetic checks do not claim to replace it.

Hosted tools are billed separately from chat tokens. The plugin shows charges as unknown, retains bounded numeric usage where returned and makes no spending-ceiling claim. FinOps's chat estimate excludes these tool charges. Scheduled task admission retains its existing free-capability policy; these media plugins are not silently admitted as free scheduled work.

## Verification

`test/media.test.ts` checks independent toggles, shared keys, approvals, model/argument enforcement, scoped files/symlinks, saved results, provider job identity, restart recovery, range reads, malformed responses, current adapter routes, spoken summaries and local playback decisions. Full app/framework/native checks also run.

`scripts/media-authoring-check.ts` runs the primary local conversation model against mocked media-provider I/O. The 2026-10-26 check started exactly one configured image job successfully. `scripts/media-smoke.ts` supplies an isolated UI fixture with all outbound provider traffic mocked; WebKit checks the three dedicated media results and narrow layouts. Provider generation quality, real account entitlement and live microphone behavior are not established by these checks. No paid generation was run for this implementation.
