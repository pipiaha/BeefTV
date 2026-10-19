import { http } from "@/services/api/request";

export type NativeComfyInspection = {
    stats: { system?: { comfyui_version?: string } };
    nodes: Record<string, unknown>;
};

export function inspectNativeComfyUI(baseUrl: string, signal: AbortSignal) {
    return http.post<NativeComfyInspection>("/configured-providers/comfyui/inspect", { baseUrl, authType: "none" }, { signal, timeout: 30_000 });
}
