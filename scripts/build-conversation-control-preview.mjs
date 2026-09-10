import { build } from "esbuild";
import fs from "node:fs";
const dir = "evidence/conversation-control-ui";
fs.mkdirSync(dir, { recursive: true });
await build({ entryPoints: ["scripts/conversation-control-preview.tsx"], bundle: true, outfile: dir + "/preview.js", format: "iife", jsx: "automatic" });
fs.writeFileSync(dir + "/index.html", '<!doctype html><html lang="ko"><meta charset="utf-8"><link rel="stylesheet" href="preview.css"><div id="root"></div><script src="preview.js"></script></html>');
