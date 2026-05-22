// Phase 68 (v0.6.12) — MCP 도구 자발적 emit 회귀 테스트.
//
// 목적:
//   v0.6.5~v0.6.11 chain 의 진짜 layer 가 "sidecar 는 64 tools 캐시했지만 frontend 가 안 받음"
//   이었음. v0.6.2 부터 Phase 67a 의 list_mcp_tools / mcp_tools event 흐름이 박혀있지만 K 의 PC 에서
//   안 트리거된 경로가 있었음. v0.6.12 의 fix 는:
//     1. sidecar ping handler 가 자발적 mcp_tools emit (cause="auto")
//     2. emitMcpToolsListing helper 가 통합 진입점
//     3. emit payload 에 serverName/serverVersion/cause 추가 — UI tooltip 의 source 표시
//     4. Settings.tsx 의 5초 timeout 시 friendly warning + 재시도 안내
//     5. mcp_tools event 의 type 에 새 필드 정의
//
// 이 테스트는 위 다섯이 코드 레벨에 박혀 있는지 검증. 실제 sidecar spawn 은 K-Personal-MCP server.py
// 의존성을 필요로 해 CI 환경에서 어려우므로 file-system + static analysis 만 수행.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sidecarRoot = __dirname;
const projectRoot = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`✅ ${msg}`); }
function ng(msg, detail) {
  fail++;
  console.log(`❌ ${msg}`);
  if (detail) console.log(`   ${detail}`);
}

function readFile(p) {
  if (!existsSync(p)) {
    ng(`파일 없음: ${p}`);
    return null;
  }
  return readFileSync(p, "utf-8");
}

// ─── 1. types.ts 의 mcp_tools event 에 serverName/serverVersion/cause 필드 ───
{
  const p = path.join(projectRoot, "src", "types.ts");
  const src = readFile(p);
  if (src) {
    // mcp_tools event 블록 안에 새 필드들이 박혀있는지 (간단한 substring 검증으로 충분)
    const hasMcpTools = src.includes('type: "mcp_tools"');
    const hasServerName = src.includes("serverName?: string");
    const hasServerVersion = src.includes("serverVersion?: string");
    const hasCause = src.match(/cause\?:\s*"request"\s*\|\s*"auto"/);
    if (hasMcpTools && hasServerName && hasServerVersion && hasCause) {
      ok("types.ts: mcp_tools event 에 Phase 68 필드 (serverName/serverVersion/cause) 정의됨");
    } else {
      ng("types.ts: Phase 68 필드 누락", `mcp_tools=${hasMcpTools} serverName=${hasServerName} serverVersion=${hasServerVersion} cause=${!!hasCause}`);
    }
  }
}

// ─── 2. sidecar/src/index.ts 의 emitMcpToolsListing helper 정의 + ping/recheck/list_mcp_tools 호출 ───
{
  const p = path.join(sidecarRoot, "src", "index.ts");
  const src = readFile(p);
  if (src) {
    const hasHelper = src.match(/async function emitMcpToolsListing\(\s*cause:\s*"request"\s*\|\s*"auto"/);
    if (hasHelper) {
      ok("sidecar/src/index.ts: emitMcpToolsListing helper 정의됨");
    } else {
      ng("sidecar/src/index.ts: emitMcpToolsListing helper 누락");
    }

    // ping case 에서 호출
    const pingCall = src.match(/case\s+"ping":[\s\S]{0,1200}emitMcpToolsListing\("auto"\)/);
    if (pingCall) {
      ok('sidecar/src/index.ts: ping handler 가 emitMcpToolsListing("auto") 호출');
    } else {
      ng('sidecar/src/index.ts: ping handler 에 emitMcpToolsListing("auto") 호출 없음');
    }

    // recheck_mcp case 에서 호출
    const recheckCall = src.match(/case\s+"recheck_mcp":[\s\S]{0,1200}emitMcpToolsListing\("auto"\)/);
    if (recheckCall) {
      ok('sidecar/src/index.ts: recheck_mcp handler 가 emitMcpToolsListing("auto") 호출');
    } else {
      ng('sidecar/src/index.ts: recheck_mcp handler 에 emitMcpToolsListing("auto") 호출 없음');
    }

    // list_mcp_tools case 에서 호출 + 명시 로깅
    const listCall = src.match(/case\s+"list_mcp_tools":[\s\S]{0,1200}emitMcpToolsListing\("request"/);
    const listLog = src.match(/list_mcp_tools handler invoked/);
    if (listCall && listLog) {
      ok('sidecar/src/index.ts: list_mcp_tools handler 가 emitMcpToolsListing("request") + 명시 로깅');
    } else {
      ng("sidecar/src/index.ts: list_mcp_tools handler fix 누락", `call=${!!listCall} log=${!!listLog}`);
    }

    // emit 시 serverName/serverVersion 박음
    const emitFields = src.match(/serverName:\s*info\.name[\s\S]{0,80}serverVersion:\s*info\.version/);
    if (emitFields) {
      ok("sidecar/src/index.ts: emitMcpToolsListing 이 getServerInfo() 결과로 serverName/serverVersion 박음");
    } else {
      ng("sidecar/src/index.ts: emit 시 serverName/serverVersion 필드 안 박힘");
    }
  }
}

// ─── 3. mcpClient.ts 의 getServerInfo() 메서드 ───
{
  const p = path.join(sidecarRoot, "src", "mcpClient.ts");
  const src = readFile(p);
  if (src) {
    const hasGetter = src.match(/getServerInfo\(\):\s*\{\s*name\?:\s*string;\s*version\?:\s*string\s*\}/);
    if (hasGetter) {
      ok("sidecar/src/mcpClient.ts: getServerInfo() 메서드 존재");
    } else {
      ng("sidecar/src/mcpClient.ts: getServerInfo() 메서드 누락");
    }
  }
}

// ─── 4. Settings.tsx 의 mcpServerInfo state + tooltip UI + 5초 fallback ───
{
  const p = path.join(projectRoot, "src", "components", "Settings.tsx");
  const src = readFile(p);
  if (src) {
    const hasState = src.includes("setMcpServerInfo");
    if (hasState) {
      ok("Settings.tsx: mcpServerInfo state 정의됨");
    } else {
      ng("Settings.tsx: mcpServerInfo state 누락");
    }

    const hasTooltip = src.match(/mcpServerInfo\s*&&\s*\(mcpServerInfo\.name\s*\|\|\s*mcpServerInfo\.version\)/);
    if (hasTooltip) {
      ok("Settings.tsx: tooltip 의 server@version 표시 UI 박힘");
    } else {
      ng("Settings.tsx: tooltip 의 server@version 표시 UI 누락");
    }

    const hasFallback = src.match(/sidecar 가 5초 안에 응답하지 않았습니다/);
    if (hasFallback) {
      ok("Settings.tsx: 5초 timeout 시 friendly warning 박힘");
    } else {
      ng("Settings.tsx: 5초 timeout warning 누락");
    }

    const hasListenerFields = src.match(/serverName\?:\s*string;\s*serverVersion\?:\s*string;\s*cause\?:\s*"request"\s*\|\s*"auto"/);
    if (hasListenerFields) {
      ok("Settings.tsx: event listener 의 payload 타입에 새 필드 정의됨");
    } else {
      ng("Settings.tsx: event listener 의 payload 타입에 새 필드 누락");
    }
  }
}

// ─── 결과 ───
console.log();
if (fail === 0) {
  console.log(`\x1b[32m✅ Phase 68 회귀 테스트 모두 통과 (${pass}/${pass})\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m❌ Phase 68 회귀 테스트 실패: ${fail} / 통과 ${pass}\x1b[0m`);
  process.exit(1);
}
