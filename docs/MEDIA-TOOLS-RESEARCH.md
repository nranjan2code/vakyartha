# Media tools: research baseline

Date: 2026-10-26. Status: retained research baseline. The subsequent user-authorized implementation is documented in [MEDIA-TOOLS.md](MEDIA-TOOLS.md); sections below preserve the original candidate evidence and gaps. Provider documentation establishes advertised API behavior, not measured output quality. No paid generation was exercised.

## Implementation scope authorized after research

The user requested three independent plugins, shared provider keys, provider/model choices per tool, current late-October model capabilities, and dedicated screen/voice projections where required. Direct adapters use the standard HTTP implementation and the existing voice adapter registry. No new SDK, server package, native runtime or paid run is authorized by implementation alone.

Framework gap record: existing public APIs provide built-in integration servers, tool approval policy, canonical session views, image projection, surface activation and the voice agenda. App composition is sufficient for provider selection, shared keys, bounded jobs and private files. The missing general capabilities are a dedicated audio/video result projection with local voice-addressable playback, authenticated resource resolution without saved credentials, and trusted canonical publication of a finished asynchronous result. The smallest additions are one media catalog component with text/channel lowering, a web resource resolver/local activation contract, and a trusted host publication method reusing the existing store/save/events path. Existing surfaces and action semantics remain compatible. Background authorization also needs a detached canonical integration configuration snapshot: using the full settings view repeatedly probes native credentials. A narrow public configuration reader supplies this without a parallel app store. Core/host/MCP regression tests and WebKit player/resource/voice checks are required before pin adoption.

## Scope and ownership

Image, audio and video creation, editing and inspection should be optional capabilities in the existing integrations catalog/lifecycle. The conversation model invokes tools; it does not need to generate the output modality itself. Keep the local conversation model as the primary authoring target. Enabling a media integration must not change the chat model, enable conversation recording, or authorize paid work implicitly.

Catalog selection, credentials, model choices, task/job recovery policy, media files, export, preview placement and accounting belong to the app. Installation, MCP transport, tool policy and general tool-result contracts remain framework responsibilities. Reuse public package exports. This research does not authorize a framework change or pin update.

## Capability inventory

Treat each row as a separately verified operation. A provider accepting a reference file does not necessarily support editing that file.

| Area | Operations to evaluate | Important distinctions |
| --- | --- | --- |
| Images | Generate; edit by instruction; edit a masked region; combine references; remove background; upscale; inspect/OCR | Mask support, actual alpha output, reference limits, dimensions and preservation behavior differ by model. Crop/resize/format conversion can be deterministic operations. |
| Audio | Narration/dialogue; sound effects; music; transcription; voice isolation; dubbing; section replacement | Music generation, audio reference conditioning, voice transformation and editing an existing recording are different capabilities. Conversation read-aloud/dictation stays separately controlled. |
| Video | Generate from text/images; edit source footage; extend; reframe; upscale; inspect; create captions | Generating the next clip is different from editing an uploaded clip. Native generated audio does not imply audio-reference input or voice editing. Trim/join/mux/format conversion need a separately reviewed processing capability. |

Keep any processing runtime optional and within the integration boundary. Do not adopt a media binary, inference runtime, SDK, custom-node system or model download under the assumption that it is already approved. Existing configured local services are candidates; hardware, model license, runtime provenance and actual performance still need verification.

## Integration evidence

1. A hosted multi-model MCP service documents model discovery/schema/pricing tools, file upload, synchronous execution, asynchronous submission and status/result/cancellation. Its bearer-header connection shape resembles an existing catalog entry. This is the strongest first compatibility candidate, not proof that it can be shipped unchanged. [Hosted connector documentation](https://blog.fal.ai/connect-your-ai-to-1-000-models-with-the-fal-mcp-server/).
2. That service's account-level model restrictions are enterprise-only. A normal account cannot be assumed to enforce the app's selected-model list. The app must validate permitted model/operation combinations at dispatch unless equivalent account enforcement is independently verified. [Access-control documentation](https://fal.ai/docs/documentation/organizations/access-controls).
3. A second hosted multi-model service documents a legacy SSE endpoint and browser authorization. The pinned client supports Streamable HTTP, including SSE POST responses; this does not establish compatibility with legacy SSE transport. Do not install a floating local bridge to work around it. [Hosted connector documentation](https://mcp.replicate.com/).
4. A hosted specialist creative connector documents browser authorization and media capabilities. The pinned catalog supports secret headers, not an OAuth login lifecycle. A direct API adapter or a general authorization addition requires separate evaluation. Avoid enabling unrelated account/agent-management tools. [Specialist connector documentation](https://elevenlabs.io/mcp).
5. A video service distinguishes its developer/account-management MCP from its media-generation MCP. Documentation access or account management must not be mistaken for a generation integration. [Connector distinction](https://docs.dev.runwayml.com/guides/mcp/).
6. Direct image, audio and video APIs are alternatives when hosted connectors cannot provide the required control. Standard HTTP can avoid an SDK dependency, but every service remains an adoption decision. Current documentation includes reference editing, masked editing, music composition, source-video editing and reframing. [Image API](https://developers.openai.com/api/docs/guides/image-generation), [image API](https://ai.google.dev/gemini-api/docs/image-generation), [music API](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music), [video API](https://docs.agents.lumalabs.ai/guides/model/).
7. An existing local workflow service exposes submit, queue, history, upload and WebSocket routes. These are an integration candidate, not permission to install the runtime, arbitrary workflows or extensions. Local execution is not automatically free of hosted API calls. [Local service routes](https://docs.comfy.org/development/comfyui-server/comms_routes).

## Selected-model contract

A configured capability identifies its integration, serving provider, model publisher, exact endpoint/model identifier, revision when exposed, operation, supported inputs/outputs, bounded parameters and verification date. Publisher and serving provider are distinct: access, pricing, retention and controls can differ for the same model.

Expose only reviewed operations and selected models to the conversation. Validate at execution, not just in descriptions or UI options. A generic tool policy grants access to a tool name; it does not restrict the model argument. Chat-wide permission for a generic executor is therefore insufficient for a selected-model guarantee.

Discovery can suggest candidates but cannot silently enable models, install dependencies, pick a paid fallback or expand allowed inputs. Changed model schemas fail closed for unsupported combinations. Local package pins, remote server behavior, model versions and price snapshots have separate lifecycles; a remote connection cannot be described as immutable merely because its URL is fixed.

Prefer a small explicit tool surface with bounded schemas for the local conversation model. Evaluate whether selected endpoints can use the existing server unchanged before designing an adapter. Owned adapters, if needed, remain integrations rather than a parallel plugin runtime.

## Jobs, files and cost

Long work should submit promptly and return an opaque job reference. Track provider job identity, task/session/run linkage, input asset references, selected model/parameters, authorization identity, state, output references and known usage in app-owned local records. Reuse the task dispatcher rather than creating another agent loop. Waiting/polling should not consume repeated conversation generations. Status checks remain subject to existing network authorization.

Distinguish queued, running, succeeded, failed, cancellation-requested, cancelled and unknown submission outcome. Stopping the local request does not prove the remote job stopped or was unbilled. Reconcile uncertain submissions by provider identity; do not resubmit paid work blindly. Provider queues may also retry internally. A missing provider idempotency or lookup guarantee must be visible in recovery behavior. [Queue lifecycle](https://fal.ai/docs/documentation/model-apis/inference/queue), [cancellation billing](https://replicate.com/docs/topics/billing).

Keep asset metadata separate from rendered surfaces: app-owned input/output references and lineage link to the existing session and surface identities. Do not introduce a second rendered-artifact store. Edits create a new asset version and preserve the source. Define import scope, export, retention and chat/task deletion explicitly.

Download authorized results into the app's private data area before treating them as durable. One service deletes API input/output data after an hour by default; another returns signed media URLs expiring after an hour. A transcript containing a URL is not a saved output. A remote server cannot open a local attachment path; uploads need an explicit byte-transfer mechanism and approval. [Retention](https://replicate.com/docs/topics/predictions/data-retention), [signed output lifetime](https://docs.agents.lumalabs.ai/guides/model/).

Validate downloads and redirects, destinations, media types, byte limits and file names. Do not leak credentials to output hosts, retain signed URLs in public logs, or make arbitrary local paths available through a media endpoint. Preview playable formats in WebKit; support seeking/range requests where needed. Keep multiple result/reference surfaces and their controls interactive.

Approve the actual upload/generation/edit destination, selected model, files and billable parameters. Estimates need dated rates, billing units and currency, with unknown values explicit. Record actual charges separately when supplied; estimates are not a monetary ceiling. Current token-based FinOps excludes external tool charges. [Programmatic media pricing](https://fal.ai/docs/documentation/model-apis/pricing).

## Concrete gaps in the pinned baseline

- `sidecar/attachments.ts` accepts only images, through base64 JSON, capped at 20 MB. Audio/video import, bounded streaming and durable output serving are not established.
- The public `McpClient.callTool` returns text/error only. Image/audio content becomes a marker; resource links become text links, and structured content is used only when the content list contributes no parts. A typed media result cannot be assumed to survive this boundary.
- MCP requests default to 60 seconds; notifications/server requests are currently ignored. The settings test-call path also has a 60-second abort. Prefer asynchronous tools over simply increasing timeouts.
- The catalog supports stdio, npm, built-in and Streamable HTTP sources with configured secret headers. Browser authorization and legacy SSE compatibility are not available contracts.
- The reviewed surface catalog/projector provides images and galleries; it does not establish audio/video playback components. App preview chrome may be sufficient initially; model-authored reusable players would be a general projector/catalog requirement.

These are observations from source inspection, not requests to change all these interfaces. For each actual blocker, record the existing public API, the smallest missing general behavior, why app composition cannot supply it, compatibility and tests before changing the framework in its own repository.

## Freshness and evaluation gates

Do not select endpoints from search snippets or an old tutorial. Current retirement notices remove one video API from service on 2026-09-24 and a set of preview video endpoints on 2026-10-22; other serving providers may still offer different supported routes to a related model family. Recheck the exact provider/endpoint before implementation. [Retirement notice](https://developers.openai.com/api/docs/deprecations), [video endpoint migration notice](https://ai.google.dev/gemini-api/docs/video).

Before adoption, verify authenticated tool discovery, schemas, transport, credential handling, uploads, selected-model enforcement, job reconciliation and output retrieval without paid generation. Provider/account access and quality remain untested. Before any paid benchmark, prepare exact prompts, source assets, endpoint/model IDs, quantities and estimated charges for approval.

The initial outcome evaluation should cover one generated image; an edit that preserves requested details; narration or a sound effect; music only if selected; image-to-video; an uploaded-video edit; denied upload; unsupported model/parameter rejection; cancellation/unknown submission; app restart during work; expired output; actual versus estimated cost; durable download and versioned edit. Run authoring with the local conversation model, and verify previews/controls in WebKit, including multiple surfaces and narrow layouts. A successful API response does not establish acceptable output quality.

Suggested evaluation order: one broad connector with a deliberately small model set, one specialist audio connector if necessary, then direct-provider and local-service candidates for demonstrated gaps. This order is provisional and approves no external service or dependency.
