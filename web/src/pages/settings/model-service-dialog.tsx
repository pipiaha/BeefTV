import { useCallback, useMemo, useRef, useState } from "react";
import { Form, Select } from "antd";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";
import { MODEL_SERVICE_PRESETS, servicePresetFor } from "@/lib/model-service-presets";
import { isNativeComfyChannel, modelUsageCapability, type ModelUsage } from "@/lib/model-settings-catalog";
import { NativeComfySettingsModal } from "./native-comfy-settings-modal";
import { ModelServiceEditor } from "./model-service-editor";
import "./model-service-dialog.css";

type ServiceType = (typeof MODEL_SERVICE_PRESETS)[number]["id"] | "comfyui";

export function ModelServiceDialog({
    initial,
    initialUsage = "all",
    initialModel,
    onClose,
    onSave,
}: {
    initial: ModelChannel | null;
    initialUsage?: ModelUsage;
    initialModel?: string;
    onClose: () => void;
    onSave: (channel: ModelChannel) => Promise<void>;
}) {
    const [type, setType] = useState<ServiceType>(() => (initial && isNativeComfyChannel(initial) ? "comfyui" : initial ? servicePresetFor(initial) : "compatible"));
    const id = useRef(initial?.id || crypto.randomUUID());
    const drafts = useRef<Partial<Record<ServiceType, ModelChannel>>>({ [type]: initial ? structuredClone(initial) : { ...createModelChannel({ id: id.current }), name: "", baseUrl: "" } });
    const [busy, setBusy] = useState(false);
    const [jsonEditing, setJSONEditing] = useState(false);
    const onDraftChange = useCallback(
        (channel: ModelChannel) => {
            drafts.current[type] = channel;
        },
        [type],
    );
    const native = type === "comfyui";
    const initialForType = useMemo(() => drafts.current[type], [type]);
    const capability = modelUsageCapability(initialUsage);
    const chooseType = (next: ServiceType) => {
        if (busy || jsonEditing || next === type) return;
        const previous = drafts.current[type];
        if (previous && !initial) drafts.current[type] = { ...previous, apiKey: "", secretKey: "", credentialRef: undefined, hasApiKey: false, hasSecretKey: false };
        if (!drafts.current[next]) {
            const preset = MODEL_SERVICE_PRESETS.find((item) => item.id === next);
            drafts.current[next] = { ...createModelChannel({ id: id.current, apiFormat: preset?.apiFormat || "openai" }), name: preset?.name || "ComfyUI", baseUrl: preset?.baseUrl || "http://127.0.0.1:8188" };
        }
        setType(next);
    };
    const save = async (channel: ModelChannel) => {
        await onSave(channel);
        onClose();
    };
    return (
        <AppDrawer
            open
            flush
            size={native ? 1180 : 680}
            rootClassName="model-service-drawer"
            title={initial ? "管理服务" : "添加服务"}
            extra={initial ? <span className="service-type-label">{native ? "ComfyUI" : MODEL_SERVICE_PRESETS.find((preset) => preset.id === type)?.name}</span> : undefined}
            closable={!busy}
            keyboard={!busy}
            mask={{ closable: false }}
            onClose={() => {
                if (!busy) onClose();
            }}
        >
            {!initial && (
                <Form layout="vertical" requiredMark={false} className="service-type-field">
                    <Form.Item label="服务类型">
                        <Select
                            aria-label="服务类型"
                            value={type}
                            disabled={busy || jsonEditing}
                            options={[...MODEL_SERVICE_PRESETS.map((preset) => ({ value: preset.id, label: preset.id === "compatible" ? "OpenAI 兼容" : preset.name })), { value: "comfyui", label: "ComfyUI" }]}
                            onChange={chooseType}
                        />
                    </Form.Item>
                </Form>
            )}
            {native ? (
                <NativeComfySettingsModal
                    key={type}
                    initial={initialForType!}
                    initialCapability={capability && capability !== "text" ? capability : "image"}
                    initialUsage={initialUsage === "all" || initialUsage === "text" ? "image" : initialUsage}
                    initialModel={initialModel}
                    onClose={onClose}
                    onSave={save}
                    onDraftChange={onDraftChange}
                    onBusyChange={setBusy}
                    onJSONEditingChange={setJSONEditing}
                />
            ) : (
                <ModelServiceEditor key={type} initial={initialForType} initialCapability={capability} initialUsage={initialUsage} onClose={onClose} onSave={save} onDraftChange={onDraftChange} onBusyChange={setBusy} />
            )}
        </AppDrawer>
    );
}
