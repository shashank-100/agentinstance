import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth/mammoth.browser.js";

/** Extract reference data only; file contents never become agent instructions. */
export async function extractResume(name: string, bytes: Uint8Array): Promise<{ name: string; text: string }> {
  if (bytes.length > 5 * 1024 * 1024) throw new Error("Maximum resume size is 5 MB.");
  const extension = name.split(".").pop()?.toLowerCase();
  let text: string;
  if (extension === "pdf") {
    const pdf = await getDocumentProxy(bytes);
    try {
      if (pdf.numPages > 30) throw new Error("Maximum resume length is 30 pages.");
      text = (await extractText(pdf, { mergePages: true })).text;
    } finally { await pdf.loadingTask.destroy(); }
  } else if (extension === "docx") {
    text = (await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer })).value;
  } else if (["txt", "md", "csv"].includes(extension ?? "")) {
    text = new TextDecoder().decode(bytes);
  } else throw new Error("Use PDF, DOCX, TXT, Markdown, or CSV resumes.");
  if (!text.trim()) throw new Error("No readable text. Scanned resumes need OCR first.");
  if (text.length > 30_000) throw new Error("Maximum extracted resume text is 30,000 characters.");
  return { name, text };
}
