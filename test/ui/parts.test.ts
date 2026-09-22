// parts[] message format (pure functions, node env).
import { describe, it, expect } from "vitest";
import { textFromParts, toText } from "../../src/parts.js";

describe("parts", () => {
  it("textFromParts joins text parts and skips others", () => {
    expect(
      textFromParts([
        { type: "text", index: 0, text: "hello" },
        { type: "image", index: 1 },
        { type: "text", index: 2, text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("toText accepts string, parts array, or {parts}", () => {
    expect(toText("plain")).toBe("plain");
    expect(toText([{ type: "text", index: 0, text: "arr" }])).toBe("arr");
    expect(toText({ parts: [{ type: "text", index: 0, text: "obj" }] })).toBe("obj");
  });
});
