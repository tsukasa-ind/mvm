import { describe, expect, it } from "vitest";
import { CLICK_MOVE_TOLERANCE_PX, isBackdropClick } from "./backdropClick";

const at = (x: number, y: number, onBackdrop = true) => ({ x, y, onBackdrop });

describe("isBackdropClick", () => {
  it("背景で押して、その場で離したら閉じる", () => {
    expect(isBackdropClick(at(100, 100), at(100, 100))).toBe(true);
    expect(isBackdropClick(at(100, 100), at(100 + CLICK_MOVE_TOLERANCE_PX, 100))).toBe(true);
  });

  it("背景でのパン (ドラッグ) の後は閉じない", () => {
    expect(isBackdropClick(at(100, 100), at(100 + CLICK_MOVE_TOLERANCE_PX + 1, 100))).toBe(false);
    expect(isBackdropClick(at(100, 100), at(300, 250))).toBe(false);
  });

  it("パネルから背景へ、または背景からパネルへのドラッグでは閉じない", () => {
    expect(isBackdropClick(at(100, 100, false), at(100, 100))).toBe(false);
    expect(isBackdropClick(at(100, 100), at(100, 100, false))).toBe(false);
  });

  it("押した記録がなければ閉じない", () => {
    expect(isBackdropClick(null, at(100, 100))).toBe(false);
  });
});
