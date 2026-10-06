export type TaskFile = { name: string; text: string };
export async function readTaskFile(file: File): Promise<TaskFile> {
  if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name}: maximum file size is 5 MB.`);
  const extension = file.name.split('.').pop()?.toLowerCase();
  let text = '';
  if (extension === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdf = await loading.promise;
    try {
      if (pdf.numPages > 30) throw new Error(`${file.name}: maximum 30 pages.`);
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
      }
      text = pages.join('\n');
    } finally { await loading.destroy(); }
  } else if (extension === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser');
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  } else if (['txt', 'md', 'csv'].includes(extension ?? '')) {
    text = await file.text();
  } else throw new Error(`${file.name}: use PDF, DOCX, TXT, Markdown, or CSV.`);
  if (!text.trim()) throw new Error(`${file.name}: no readable text. Scanned PDFs need OCR first.`);
  if (text.length > 30_000) throw new Error(`${file.name}: too much text (maximum 30,000 characters).`);
  return { name: file.name, text };
}
