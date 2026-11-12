import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// spA — Pretendard Variable 번들 (SIL OFL 1.1, 네트워크 없이). 동적 서브셋이라 화면에 나온 글자 조각만 읽는다.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./index.css";
import { applyUiLayout } from "./utils/useUiLayout";

// v0.7.86 UI 3b단계 — 첫 렌더 전에 화면 배치를 박아 깜빡임 방지
applyUiLayout();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
