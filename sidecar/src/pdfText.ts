import process from "node:process";
import PDFParser, { type Output as PdfJsonOutput } from "pdf2json";

export type PdfTextResult = {
  ok: boolean;
  text?: string;
  pages?: number;
  chars?: number;
  truncated?: boolean;
  error?: string;
};

export type PdfTextOptions = {
  charLimit?: number;
};

export const DEFAULT_PDF_TEXT_CHAR_LIMIT = 60000;

export function resolvePdfTextCharLimit(value: unknown = process.env.KDA_PDF_TEXT_CHAR_LIMIT): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PDF_TEXT_CHAR_LIMIT;
}

export function isPdfAttachment(name: string, type: string | undefined): boolean {
  return /\.pdf$/i.test(name) || (type ?? "").toLowerCase().includes("pdf");
}

function decodePdfToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function textFromPdfJson(pdfData: PdfJsonOutput): string {
  const pages = Array.isArray(pdfData.Pages) ? pdfData.Pages : [];
  return pages
    .map((page, idx) => {
      const text = (page.Texts ?? [])
        .slice()
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
        .map((item) => (item.R ?? []).map((run) => decodePdfToken(run.T ?? "")).join(""))
        .filter(Boolean)
        .join(" ");
      return `--- page ${idx + 1} ---\n${text}`;
    })
    .join("\n\n")
    .trim();
}

export async function extractPdfText(
  filePath: string,
  options: PdfTextOptions = {},
): Promise<PdfTextResult> {
  return await new Promise((resolve) => {
    const parser = new PDFParser(null, true);
    let settled = false;
    const done = (result: PdfTextResult) => {
      if (settled) return;
      settled = true;
      try { parser.destroy(); } catch {}
      resolve(result);
    };

    parser.on("pdfParser_dataError", (errData) => {
      const err = errData instanceof Error ? errData : errData?.parserError;
      done({ ok: false, error: err instanceof Error ? err.message : String(errData) });
    });
    parser.on("pdfParser_dataReady", (pdfData) => {
      try {
        const raw = parser.getRawTextContent().trim();
        const extracted = raw || textFromPdfJson(pdfData);
        const normalized = extracted.replace(/\r\n/g, "\n").trim();
        const pages = Array.isArray(pdfData.Pages) ? pdfData.Pages.length : undefined;
        if (!normalized) {
          done({ ok: false, pages, error: "no extractable text (possibly scanned/image-only PDF)" });
          return;
        }
        const limit = resolvePdfTextCharLimit(options.charLimit);
        const truncated = normalized.length > limit;
        done({
          ok: true,
          text: truncated ? normalized.slice(0, limit) : normalized,
          pages,
          chars: normalized.length,
          truncated,
        });
      } catch (e) {
        done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

    parser.loadPDF(filePath, 0).catch((e) => {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
}

export function formatPdfTextBlock(name: string, result: PdfTextResult, charLimit?: number): string {
  if (result.ok && result.text) {
    const pageInfo = result.pages ? `${result.pages}p, ` : "";
    const limit = resolvePdfTextCharLimit(charLimit);
    const truncInfo = result.truncated ? `, truncated to ${limit} chars` : "";
    return [
      `### ${name} (${pageInfo}${result.chars ?? result.text.length} chars${truncInfo})`,
      result.text,
    ].join("\n");
  }

  const reason = result.error ?? "unknown error";
  return `### ${name}\n[PDF text extraction failed: ${reason}]`;
}
