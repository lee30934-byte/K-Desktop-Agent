"""Headless static-file verification; no dev server and no user browser interaction."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
out = root / "evidence" / "conversation-control-ui"
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1200, "height": 850})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((out / "index.html").as_uri())
    textarea = page.locator("textarea")
    expect(page.get_by_role("button", name="추가 지시 · 질문", exact=True)).to_have_attribute("aria-pressed", "true")
    textarea.fill("A 대화 작성 중")
    page.get_by_role("button", name="회귀 테스트 검토", exact=True).click()
    expect(textarea).to_have_value("")
    textarea.fill("B 대화 작성 중")
    page.get_by_role("button", name="KDA 기능 구현", exact=True).click()
    expect(textarea).to_have_value("A 대화 작성 중")
    checks.append("conversation drafts isolated and restored")
    page.get_by_role("button", name="완료 후 예약", exact=True).click()
    textarea.press("Enter")
    textarea.fill("A 두 번째 예약")
    textarea.press("Enter")
    expect(page.locator(".queue-chip-label")).to_contain_text("2개")
    checks.append("multiple reservations preserved")
    page.get_by_role("button", name="회귀 테스트 검토", exact=True).click()
    expect(page.locator(".queue-chip")).to_have_count(0)
    expect(textarea).to_have_value("B 대화 작성 중")
    textarea.press("Enter")
    page.wait_for_function("window.preview.calls.length === 3")
    calls = page.evaluate("window.preview.calls")
    assert [call["conversationId"] for call in calls] == ["a", "a", "b"]
    assert [call["mode"] for call in calls] == ["queue", "queue", "steer"]
    checks.append("question/steering and queued send modes dispatched to originating chat")
    page.locator(".task-activity-toggle").click()
    expect(page.locator(".task-activity-row")).to_have_count(3)
    page.screenshot(path=str(out / "desktop.png"), full_page=True)
    checks.append("three conversation task panel rendered")
    page.evaluate("window.preview.stop()")
    expect(page.get_by_role("button", name="지금 반영", exact=True).last).to_be_disabled()
    expect(page.locator(".composer-steering-bar")).to_contain_text("실제 종료")
    checks.append("new steering disabled until actual stop acknowledgement")
    page.set_viewport_size({"width": 720, "height": 900})
    page.screenshot(path=str(out / "compact.png"), full_page=True)
    assert not errors, errors
    checks.append("no browser runtime errors")
    browser.close()
(out / "result.json").write_text(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"UI smoke: {len(checks)}/{len(checks)} PASS")
