import { Button, Checkbox, InputNumber, Select, Switch } from "antd";
import { useState } from "react";
import { sourceOptions, sourcePatch, WorkflowFieldMappingEditor } from "@/components/workflow-field-mapping-editor";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

export function NativeComfyMappings({ fields, onChange }: { fields: WorkflowFieldMapping[]; onChange: (fields: WorkflowFieldMapping[]) => void }) {
    const [all, setAll] = useState(false);
    const update = (index: number, patch: Partial<WorkflowFieldMapping>) => onChange(fields.map((field, offset) => (offset === index ? { ...field, ...patch } : field)));
    const visible = fields.flatMap((field, index) => (all || (field.enabled !== false && (field.source || field.randomEnabled || field.bindPrompt)) ? [{ field, index }] : []));
    return (
        <section className="native-comfy-mappings">
            <div className="native-comfy-group-heading">
                <h3>输入映射</h3>
                <Button size="small" type="text" onClick={() => setAll(!all)}>
                    {all ? "仅看已映射" : "显示全部字段"}
                </Button>
            </div>
            {!visible.length && <p className="native-comfy-help">尚无动态输入，可从全部字段添加。</p>}
            <div className="native-comfy-mapping-list">
                {visible.map(({ field, index }) => {
                    const disabled = field.safeToOverride === false;
                    const source = field.randomEnabled ? "__random" : field.bindPrompt ? "prompt" : field.source || "";
                    const media = ["referenceImage", "referenceVideo", "referenceAudio"].includes(source);
                    return (
                        <div key={field.id || `${field.nodeId}:${field.fieldName}`} className="native-comfy-mapping-row">
                            <div className="native-comfy-mapping-identity">
                                <strong>{field.label || field.fieldName}</strong>
                                <small>
                                    {field.nodeId} / {field.classType} / {field.fieldName}
                                </small>
                            </div>
                            <Switch size="small" aria-label={`启用映射 ${field.nodeId}:${field.fieldName}`} checked={field.enabled !== false} disabled={disabled} onChange={(enabled) => update(index, { enabled })} />
                            <Select
                                aria-label={`输入来源 ${field.nodeId}:${field.fieldName}`}
                                disabled={disabled || field.enabled === false}
                                value={source}
                                options={[
                                    ...sourceOptions.map((option) => ({ ...option })),
                                    ...(typeof field.fieldValue === "number" ? [{ value: "__random", label: "每次随机" }] : []),
                                    ...(!["__random", "", ...sourceOptions.map((option) => option.value)].includes(source) ? [{ value: source, label: source }] : []),
                                ]}
                                onChange={(value) => update(index, value === "__random" ? { source: "", bindPrompt: false, randomEnabled: true } : { ...sourcePatch(field, value), randomEnabled: false })}
                            />
                            {media && (
                                <div className="native-comfy-mapping-options">
                                    <label>
                                        素材槽位
                                        <InputNumber
                                            aria-label={`素材槽位 ${field.nodeId}:${field.fieldName}`}
                                            min={1}
                                            precision={0}
                                            value={source === "referenceImage" ? field.imageOrder || 1 : (field.sourceIndex || 0) + 1}
                                            onChange={(value) => update(index, source === "referenceImage" ? { imageOrder: value || 1 } : { sourceIndex: Math.max(0, (value || 1) - 1) })}
                                        />
                                    </label>
                                    <Checkbox checked={field.required === true} onChange={(event) => update(index, { required: event.target.checked })}>
                                        必需
                                    </Checkbox>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <details className="native-comfy-details">
                <summary>字段约束与显示选项</summary>
                <WorkflowFieldMappingEditor fields={fields} onChange={onChange} />
            </details>
        </section>
    );
}
