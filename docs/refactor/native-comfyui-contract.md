# Native ComfyUI backend contract

This note records the backend-only contract introduced for the existing task/business generation path. It is intentionally independent of the settings UI.

## Interface and task configuration

Use one protocol per capability:

- image: `comfyui-image`
- video: `comfyui-video`
- audio: `comfyui-audio`

These are workflow-provider interfaces. They bypass ordinary cloud API-key/model validation and use the existing workflow executor, media hydration, task worker, receipt, result ingestion, and external business authorization paths.

A task's existing `input.config` accepts:

```json
{
  "interfaceType": "comfyui-image",
  "baseUrl": "http://127.0.0.1:8188",
  "authType": "none",
  "authHeader": "",
  "negativePrompt": "blurry",
  "seed": "7",
  "comfyui": {
    "graph": {
      "5": {
        "class_type": "LoadImage",
        "inputs": { "image": "placeholder.png" }
      },
      "15": {
        "class_type": "SaveImage",
        "inputs": { "images": ["5", 0], "filename_prefix": "beeftv" }
      }
    },
    "fields": [
      {
        "nodeId": "5",
        "fieldName": "image",
        "source": "referenceImage",
        "sourceIndex": 0
      }
    ],
    "outputNodeId": "15",
    "outputField": "images"
  }
}
```

`comfyUI` is accepted as a camel-case alias when decoding persisted JSON; canonical output is `comfyui`.

Recognized field sources include:

- `prompt`
- `negativePrompt`
- `seed`
- `referenceImage`, `referenceVideo`, `referenceAudio`
- `mask`
- existing scalar/workflow parameters such as size, count, duration, and quality
- a static `value` / `fieldValue`
- `randomEnabled` for seed-like integer fields

`sourceIndex` selects an input list entry. Disabled fields are retained but not applied. A prompt binding is optional; a loader-to-save transfer graph may omit the prompt entirely.

`graph` must be ComfyUI API JSON (not UI JSON), have at most 500 nodes, and every node must contain `class_type` and `inputs`. Only an explicitly mapped scalar input is overwritten. Existing links cannot be replaced.

## Target validation and inspection

The read-only business endpoint is:

```text
POST /api/configured-providers/comfyui/inspect
```

Its body accepts `baseUrl`, `authType`, `apiKey`, `authHeader`, and `headers`. It performs authenticated GET requests to the target's `/system_stats` and `/object_info`, and returns `{stats,nodes}`. It does not install nodes, upload files, submit prompts, restart the service, or mutate model storage.

Before a create, the executor reads target `/object_info`. It rejects:

- classes absent on that exact target;
- mapped inputs absent from the target node schema;
- enum/model values that are not in the target schema, except values produced by an explicitly mapped upload field.

The Mac's local model inventory is never used to judge a remote graph.

## Owned input upload

Inputs come through the existing BeefTV resource/task hydration path. The native connector requires local workspace mode and rejects URLs that are not hydrated inline bytes.

Native ComfyUI 0.33/0.37 exposes one generic file upload route, `/upload/image`, for its image, video, and audio loader widgets. The connector deliberately does not invent `/upload/audio` or `/upload/video`. It sends actual multipart bytes to `/upload/image` with:

- form file field: `image`
- unique filename: `beeftv-<uuid>.<ext>`
- `subfolder=beeftv`
- `type=input`
- `overwrite=false`

The returned target-relative `subfolder/name` is bound to the mapped loader input with the ` [input]` annotation. Local macOS paths, public URLs, resource IDs, and data URLs are never placed in the graph.

Mask is a distinct field role (`source=mask`). It is uploaded as an image file but is never silently reinterpreted as alpha or a grayscale channel. A `LoadImageMask` graph must explicitly map its file input to `mask`; the channel remains a separate scalar input and must be configured explicitly.

Upload bodies are bounded to 128 MiB per input in this backend slice.

For services sharing a GPU, `comfyui.releaseModelsAfter=true` releases that
service's model caches through the standard `/free` API after a successful
download, provided its running and pending queues are empty. It does not
restart or reconfigure ComfyUI, and skips cleanup when another job is queued.
This bounds cache residency between sequential jobs on separate endpoints;
it does not guarantee that every large model fits the available memory.

## Submission, resume, and uncertainty

Create flow:

1. verify the local receipt port is ready;
2. validate the persisted graph against target `/object_info`;
3. upload the provided owned input media;
4. bind API JSON;
5. revalidate model/enum values;
6. POST `/prompt` with `{prompt,client_id}`;
7. persist the returned `prompt_id` through the existing accepted receipt port;
8. only then query `/history/{prompt_id}`.

`client_id` uses the stable BeefTV task/request ID when available. ComfyUI still generates the authoritative `prompt_id`; BeefTV does not claim a client-supplied prompt ID.

Known receipt resume skips target schema discovery, upload, and `/prompt`. It only queries history/queue and downloads the original prompt's outputs. The failed-video query action uses the same native history path, without cloud plugin authorization or RunningHub requests.

Transport failure or a missing ID after `/prompt` is surfaced as create-uncertain. Such a task must not be blindly resubmitted: ComfyUI offers no exactly-once create key, and a lost HTTP response can conceal an accepted job. Definite HTTP validation/authentication failures are distinguished from uncertain transport outcomes. Accepted-but-not-recorded errors retain the prompt ID when available and instruct callers to reconcile the original ID.

If both history and queue lack a known prompt ID, the task fails explicitly rather than automatically creating a replacement.

Cancellation first tries the precise `/api/jobs/{prompt_id}/cancel` route. On older targets it can remove only that pending ID via `/queue`, accepting the standard empty 200 response. After verifying removal from both queues and checking for a completion race, the app persists the confirmed cancellation immediately: deleted pending prompts have no execution history. It never uses global `/interrupt`. A running job that lacks precise cancellation remains locally reconciled through its receipt. A crash after removal but before recording confirmation can leave an uncertain cancellation; missing history alone is not proof of cancellation.

## Outputs

The configured history selector may be `images`, `gifs`, `videos`, or `audio`. The selector is only a locator; actual BeefTV mode is determined from downloaded MIME/magic bytes. This is required because ComfyUI 0.33 `SaveVideo` reports MP4 under `images` with a parallel `animated` list.

For every output descriptor the connector requires:

- safe base filename;
- safe optional nested subfolder;
- `type=output` or `type=temp`.

It downloads only from the same target's `/view` endpoint with explicit `filename`, `subfolder`, and `type` query parameters. All native calls reject redirects, including schema reads and downloads, so custom authentication headers and request bodies cannot be forwarded to another origin. Configure the final service URL rather than a redirecting gateway. Empty, traversal, invalid-media, or failed downloads never produce success. Ogg/Opus containers are normalized to `audio/ogg` rather than rejected as `application/ogg`.

The result uses BeefTV's existing generation shapes:

- image: `{mode:"image",images:[...]}`
- video: `{mode:"video",video:{...}}`
- audio: `{mode:"audio",audio:{...}}`

The normal task result materializer turns those inline results into resources/assets. This first backend slice uses the existing bounded inline result path; downloads are limited to 256 MiB per response and should later move to direct resource streaming if production clips require larger bodies.
