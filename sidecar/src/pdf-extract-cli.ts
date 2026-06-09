import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import process from "node:process";
import type { PdfTextResult } from "./pdfText.js";

type CliOptions = {
  files: string[];
  outDir?: string;
  json: boolean;
  charLimit: number;
};

const DEFAULT_PDF_TEXT_CHAR_LIMIT = 60000;

function resolveCliCharLimit(value: unknown = process.env.KDA_PDF_TEXT_CHAR_LIMIT): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PDF_TEXT_CHAR_LIMIT;
}

function usage(): string {
  return [
    "Usage: node dist/pdf-extract-cli.js [--json] [--out <dir>] [--limit <chars>] <file.pdf> [...]",
    "",
    "Examples:",
    "  node dist/pdf-extract-cli.js sample.pdf",
    "  node dist/pdf-extract-cli.js --out extracted sample.pdf other.pdf",
    "  node dist/pdf-extract-cli.js --json --limit 120000 sample.pdf",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const files: string[] = [];
  let outDir: string | undefined;
  let json = false;
  let charLimit = resolveCliCharLimit();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a directory");
      outDir = value;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[++i];
      if (!value) throw new Error("--limit requires a positive number");
      charLimit = resolveCliCharLimit(value);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    files.push(arg);
  }

  if (files.length === 0) throw new Error("at least one PDF file is required");
  return { files, outDir, json, charLimit };
}

function outputPathFor(outDir: string, filePath: string): string {
  const parsed = path.parse(filePath);
  const base = parsed.name || "pdf-extract";
  return path.join(outDir, `${base}.txt`);
}

async function main(): Promise<number> {
  process.env.PDF2JSON_DISABLE_LOGS ??= "1";
  const { extractPdfText, formatPdfTextBlock } = await import("./pdfText.js");

  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error("");
    console.error(usage());
    return 2;
  }

  if (options.outDir) mkdirSync(options.outDir, { recursive: true });

  const results = [];
  let failed = false;
  for (const file of options.files) {
    const filePath = path.resolve(file);
    if (!existsSync(filePath)) {
      failed = true;
      results.push({ file: filePath, ok: false, error: "file not found" } satisfies { file: string } & PdfTextResult);
      continue;
    }

    const result = await extractPdfText(filePath, { charLimit: options.charLimit });
    if (!result.ok) failed = true;
    const record = { file: filePath, ...result };
    results.push(record);

    if (options.outDir && result.ok && result.text) {
      writeFileSync(outputPathFor(options.outDir, filePath), result.text, "utf8");
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const record of results) {
      const name = path.basename(record.file);
      console.log(formatPdfTextBlock(name, record, options.charLimit));
      console.log("");
    }
  }

  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
