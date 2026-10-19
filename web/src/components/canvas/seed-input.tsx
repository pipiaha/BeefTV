import { Dices, Lock, LockOpen } from "lucide-react";
import { useMemo } from "react";

export const SEED_INPUT_MAX_LENGTH = 12;
export const SEED_UPPER_BOUND = 1_000_000_000_000;

/** 规范化种子输入：仅数字、去前导零、封顶 12 位。 */
export function formatSeedInput(raw: string): string {
    const digits = raw.replace(/\D+/g, "");
    if (!digits) return "";
    const trimmed = digits.replace(/^0+(?=\d)/, "");
    return trimmed.slice(0, SEED_INPUT_MAX_LENGTH);
}

/** 生成一个 12 位以内随机种子。 */
export function randomSeedValue(): string {
    return String(Math.floor(Math.random() * SEED_UPPER_BOUND));
}

export function isValidSeedValue(value: string): boolean {
    return value === "" || (/^\d{1,12}$/.test(value) && Number(value) < SEED_UPPER_BOUND);
}

type Props = {
    value?: string;
    locked: boolean;
    onValueChange?: (value: string) => void;
    onReroll: () => void;
    onLockChange: (locked: boolean) => void;
    disabled?: boolean;
};

/** 参数条种子控件（设计规范 v1 §4.2）：等宽 12 位、空=随机、重掷/锁定两枚图标钮。 */
export function SeedInput({ value = "", locked, onValueChange, onReroll, onLockChange, disabled = false }: Props) {
    const displayValue = useMemo(() => formatSeedInput(value), [value]);
    return (
        <span className="canvas-seed-input" data-locked={locked || undefined} data-disabled={disabled || undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
                type="text"
                inputMode="numeric"
                aria-label="种子（留空为随机）"
                placeholder="随机"
                value={displayValue}
                disabled={disabled}
                spellCheck={false}
                style={{ width: 96, fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em" }}
                onChange={(event) => onValueChange?.(formatSeedInput(event.target.value))}
            />
            <button
                type="button"
                aria-label="重掷种子"
                title="重掷种子"
                disabled={disabled}
                onClick={onReroll}
                style={{ width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
                <Dices size={14} />
            </button>
            <button
                type="button"
                aria-label={locked ? "解锁种子" : "锁定种子"}
                title={locked ? "解锁种子（重生成时换新种子）" : "锁定种子（同参数复用）"}
                disabled={disabled}
                aria-pressed={locked}
                onClick={() => onLockChange(!locked)}
                style={{ width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
                {locked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
        </span>
    );
}
