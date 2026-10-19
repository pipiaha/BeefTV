import { describe, expect, test } from "bun:test";
import { audioUsesForProfile, inferNativeComfyOutput, modelsForUsage, nativeComfyInputControls, prepareNativeComfyChannel, profileMatchesUsage, updateNativeComfyInput, withProfileUsage } from "../src/lib/model-settings-catalog";
import { serviceModelProfile } from "../src/lib/model-service-presets";
import { createModelChannel, defaultConfig, encodeChannelModel, normalizeConfigSnapshot, type ModelChannel } from "../src/stores/use-config-store";
import { parseNativeComfyApiGraph, type NativeComfyWorkflow } from "../src/lib/native-comfyui";

function workflow(): NativeComfyWorkflow {
    return {
        ...parseNativeComfyApiGraph({
            model: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "original.safetensors" } },
            sampler: { class_type: "KSampler", inputs: { steps: 20, cfg: 7, seed: 123, latent: ["latent", 0] } },
            save: { class_type: "SaveImage", inputs: { images: ["sampler", 0], filename_prefix: "test" } },
        }),
        outputNodeId: "save",
        outputField: "images",
        releaseModelsAfter: true,
    };
}
function channel(): ModelChannel {
    return createModelChannel({
        id: "shared",
        name: "Shared ComfyUI",
        baseUrl: "http://comfy.local:8188",
        apiKey: "retain-placeholder",
        credentialRef: "retain-reference",
        headers: [{ name: "X-Example", value: "retain-placeholder" }],
        models: ["stable-image", "stable-video", "stable-audio"],
        modelProfiles: (["image", "video", "audio"] as const).map((capability) => ({
            model: "stable-" + capability,
            displayName: capability,
            capability,
            protocol: ("comfyui-" + capability) as "comfyui-image",
            authType: "none",
            comfyui: workflow(),
        })),
    });
}
describe("model settings preserve shared service state", () => {
    test("audio output does not imply speech, music, or sound effects", () => {
        const original = channel();
        const audio = original.modelProfiles![2];
        expect(profileMatchesUsage(audio, "other-audio")).toBe(true);
        expect(profileMatchesUsage(audio, "speech")).toBe(false);
        expect(profileMatchesUsage({ ...audio, displayName: "voice music tts" }, "music")).toBe(false);
        const multi = { ...audio, audioUses: ["music", "sound"] as const };
        expect(audioUsesForProfile({ ...multi, audioUses: [...multi.audioUses] })).toEqual(["music", "sound"]);
        expect(profileMatchesUsage({ ...multi, audioUses: [...multi.audioUses] }, "speech")).toBe(false);
        const typed = { ...original, modelProfiles: [...original.modelProfiles!.slice(0, 2), withProfileUsage(audio, "music")] };
        expect(modelsForUsage(typed, "music")).toEqual(["stable-audio"]);
        expect(modelsForUsage(typed, "speech")).toEqual([]);
        expect(modelsForUsage(typed, "other-audio")).toEqual([]);
    });
    test("only an explicit speech contract supplies a speech purpose by default", () => {
        expect(audioUsesForProfile({ capability: "audio", protocol: "openai-audio" })).toEqual(["speech"]);
        expect(audioUsesForProfile({ capability: "audio", protocol: "async-audio" })).toEqual([]);
        expect(audioUsesForProfile({ capability: "audio", protocol: "openai-audio", audioUses: [] })).toEqual([]);
    });
    test("music intent never silently chooses the speech API; explicit protocols remain intact", () => {
        const source = createModelChannel({ models: ["music"], modelProfiles: [{ model: "music", capability: "audio", audioUses: ["music"] }] });
        const protocols = [{ value: "openai-audio", capability: "audio" as const, label: "Speech", create: "/audio/speech", contentType: "json", media: "audio" }];
        expect(serviceModelProfile(source, { id: "music" }, protocols).protocol).toBeUndefined();
        const explicit = { ...source, modelProfiles: [{ ...source.modelProfiles![0], protocol: "my-music-protocol" }] };
        expect(serviceModelProfile(explicit, { id: "music" }, protocols).protocol).toBe("my-music-protocol");
    });
    test("purpose metadata survives saving, normalization and JSON reload without changing workflow references", () => {
        const source = channel();
        const profiles = source.modelProfiles!.map((profile) => (profile.model === "stable-audio" ? withProfileUsage(profile, "music") : profile));
        const saved = prepareNativeComfyChannel(source, profiles);
        const reloaded = normalizeConfigSnapshot(JSON.parse(JSON.stringify({ config: { ...defaultConfig, channels: [saved], audioModel: "shared::stable-audio" } }))).config;
        expect(reloaded.channels[0].modelProfiles![2].audioUses).toEqual(["music"]);
        expect(reloaded.channels[0].modelProfiles![2].comfyui).toEqual(source.modelProfiles![2].comfyui);
        expect(reloaded.audioModel).toBe("shared::stable-audio");
    });
    test("usage filters expose each capability without changing the shared service", () => {
        const original = channel();
        const before = structuredClone(original);
        expect(modelsForUsage(original, "image")).toEqual(["stable-image"]);
        expect(modelsForUsage(original, "video")).toEqual(["stable-video"]);
        expect(modelsForUsage(original, "audio")).toEqual(["stable-audio"]);
        expect(modelsForUsage(original, "text")).toEqual([]);
        expect(modelsForUsage(original, "all")).toEqual(original.models);
        expect(original).toEqual(before);
    });
    test("rename and reload retain IDs, other workflows, credentials and default references", () => {
        const original = channel();
        const profiles = structuredClone(original.modelProfiles!);
        profiles[0].displayName = "Renamed";
        const saved = prepareNativeComfyChannel(original, profiles);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [saved], imageModel: encodeChannelModel(saved.id, "stable-image"), videoModel: encodeChannelModel(saved.id, "stable-video"), audioModel: encodeChannelModel(saved.id, "stable-audio") },
        }).config;
        expect(saved.models).toEqual(original.models);
        expect(saved.modelProfiles!.slice(1).map((profile) => profile.model)).toEqual(["stable-video", "stable-audio"]);
        expect(saved.modelProfiles![1].comfyui).toEqual(original.modelProfiles![1].comfyui);
        expect(saved.apiKey).toBe(original.apiKey);
        expect(saved.headers).toEqual(original.headers);
        expect(saved.credentialRef).toBe(original.credentialRef);
        expect(config.imageModel).toBe("shared::stable-image");
        expect(config.videoModel).toBe("shared::stable-video");
        expect(config.audioModel).toBe("shared::stable-audio");
        expect(config.channels[0].modelProfiles![0].comfyui).toEqual(profiles[0].comfyui);
    });
    test("a new workflow cannot steal a later saved workflow ID", () => {
        const original = channel();
        const profiles = [{ ...original.modelProfiles![0], model: "__draft-new", displayName: "stable-video" }, ...original.modelProfiles!];
        const saved = prepareNativeComfyChannel(original, profiles);
        expect(saved.models).toEqual(["stable-video-2", ...original.models]);
        expect(() => prepareNativeComfyChannel(original, [profiles[1], profiles[1]])).toThrow("标识重复");
    });
    test("mixed connection profiles and malformed origins are rejected before saving", () => {
        const original = channel();
        expect(() => prepareNativeComfyChannel({ ...original, modelProfiles: [...original.modelProfiles!, { model: "api", capability: "text", protocol: "openai-chat" }] }, original.modelProfiles!)).toThrow("其他接入方式");
        for (const baseUrl of ["ftp://comfy.local", "http://comfy.local/prompt", "http://user:pass@comfy.local", "http://comfy.local?key=x"]) {
            expect(() => prepareNativeComfyChannel({ ...original, baseUrl }, original.modelProfiles!)).toThrow();
        }
    });
});
describe("ComfyUI basic controls", () => {
    test("output inference follows ComfyUI file fields and requires an explicit choice for ambiguity", () => {
        for (const [class_type, field] of [
            ["SaveImage", "images"],
            ["SaveVideo", "images"],
            ["SaveAudioMP3", "audio"],
            ["VHS_VideoCombine", "gifs"],
        ]) {
            expect(inferNativeComfyOutput({ out: { class_type, inputs: {} } })).toEqual({ outputNodeId: "out", outputField: field });
        }
        expect(inferNativeComfyOutput({ a: { class_type: "SaveImage" }, b: { class_type: "SaveVideo" } }).outputNodeId).toBe("");
        expect(inferNativeComfyOutput({ a: { class_type: "CustomSave" } }).outputField).toBe("");
    });
    test("target node inventory provides model choices; edits retain links and input bindings", () => {
        const original = workflow();
        const before = structuredClone(original);
        const controls = nativeComfyInputControls(original, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["original.safetensors", "remote.safetensors"]] } } } });
        expect(controls.models[0].choices).toEqual(["original.safetensors", "remote.safetensors"]);
        const updated = updateNativeComfyInput(original, controls.models[0], "remote.safetensors");
        expect(updated.graph.model.inputs).toEqual({ ckpt_name: "remote.safetensors" });
        expect(updated.graph.sampler).toEqual(original.graph.sampler);
        expect(updated.fields.find((field) => field.fieldName === "ckpt_name")?.fieldValue).toBe("remote.safetensors");
        expect(updated.releaseModelsAfter).toBe(true);
        expect(original).toEqual(before);
    });
    test("explicit values are shown and runtime/random mappings cannot be overwritten by basic controls", () => {
        const flow = workflow();
        flow.fields = flow.fields.map((field) =>
            field.fieldName === "steps"
                ? { ...field, enabled: true, source: "", fieldValue: 12 }
                : field.fieldName === "cfg"
                  ? { ...field, enabled: true, source: "cfg" }
                  : field.fieldName === "seed"
                    ? { ...field, enabled: true, randomEnabled: true }
                    : field,
        );
        const controls = nativeComfyInputControls(flow);
        expect(controls.parameters.find((control) => control.fieldName === "steps")?.value).toBe(12);
        for (const name of ["cfg", "seed"]) {
            const input = controls.parameters.find((control) => control.fieldName === name)!;
            expect(input.bound).toBe(true);
            expect(() => updateNativeComfyInput(flow, input, 3)).toThrow("映射");
        }
    });
});
