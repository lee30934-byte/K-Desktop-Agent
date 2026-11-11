import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyUiLayout } from "./utils/useUiLayout";

// v0.7.86 UI 3b단계 — 첫 렌더 전에 화면 배치를 박아 깜빡임 방지
applyUiLayout();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
