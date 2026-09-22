// AgentSky-style message "parts" — a multimodal-ready content format.
// A message body is { parts: [{ type, index, text?, ... }] }. We keep text as
// the first-class part type; the shape leaves room for images/files later.

export interface TextPart {
  type: "text";
  index: number;
  text: string;
}
export type Part = TextPart | { type: string; index: number; [k: string]: unknown };

/** Collapse parts down to a plain string (text parts joined). */
export function textFromParts(parts: Part[]): string {
  return parts
    .map((p) => (p.type === "text" ? (p as TextPart).text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Accept either a plain string or a parts array and normalize to text. */
export function toText(input: string | { parts?: Part[] } | Part[]): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return textFromParts(input);
  return textFromParts(input.parts ?? []);
}
