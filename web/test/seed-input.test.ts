import { describe, expect, test } from "bun:test";

import { formatSeedInput, isValidSeedValue, randomSeedValue } from "../src/components/canvas/seed-input";

describe("formatSeedInput", () => {
    test("丢弃非数字字符", () => {
        expect(formatSeedInput("12a3-4")).toBe("1234");
    });
    test("去掉前导零但保留单个 0", () => {
        expect(formatSeedInput("007")).toBe("7");
        expect(formatSeedInput("0")).toBe("0");
    });
    test("封顶 12 位", () => {
        expect(formatSeedInput("1234567890123456")).toBe("123456789012");
    });
    test("空输入保持空", () => {
        expect(formatSeedInput("")).toBe("");
        expect(formatSeedInput("--")).toBe("");
    });
});

describe("isValidSeedValue", () => {
    test("空串合法（表示随机）", () => {
        expect(isValidSeedValue("")).toBe(true);
    });
    test("12 位以内数字合法", () => {
        expect(isValidSeedValue("123456789012")).toBe(true);
    });
    test("超 12 位或非数字非法", () => {
        expect(isValidSeedValue("1234567890123")).toBe(false);
        expect(isValidSeedValue("12a3")).toBe(false);
    });
});

describe("randomSeedValue", () => {
    test("始终是 12 位以内纯数字", () => {
        for (let i = 0; i < 50; i += 1) {
            const value = randomSeedValue();
            expect(/^[1-9]\d{0,11}$/.test(value)).toBe(true);
        }
    });
});
