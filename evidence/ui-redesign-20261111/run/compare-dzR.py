# dzR 비교 이미지: 행 = 화면, 열 = spB 캡처 | 승인 목업 v2.1 | dzC 구현.  usage: py -3 compare-dzR.py
from PIL import Image, ImageDraw, ImageFont
P = "C:/Users/lee30/.kda/previews/"
ROWS = [
    ("메인 (메시지)", "ui-spB-main-20261112.png", "ui-mk21-main-20261112.png", "ui-dzC-main-20261112.png"),
    ("도구·코드 콘텐츠", None, "ui-mk2-content-20261112.png", "ui-dzC-content-20261112.png"),
    ("슬라이드오버", "ui-spB-session-20261112.png", "ui-mk21-slideover-20261112.png", "ui-dzC-session-20261112.png"),
    ("설정 · 권한과 안전", "ui-spB-settings-safety-20261112.png", "ui-mk21-settings-20261112.png", "ui-dzC-settings-safety-20261112.png"),
    ("명령 팔레트", "ui-spB-palette-20261112.png", "ui-mk2-palette-20261112.png", "ui-dzC-palette-query-20261112.png"),
]
HEAD = ["spB (고도화 전)", "승인 목업 v2.1", "dzC 구현 (현재)"]
W, H, PAD, LBL, TOP = 720, 450, 16, 190, 56
font = ImageFont.truetype("C:/Windows/Fonts/malgunbd.ttf", 22)
small = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 18)
out = Image.new("RGB", (LBL + 3 * (W + PAD) + PAD, TOP + len(ROWS) * (H + PAD) + PAD), (6, 7, 9))
d = ImageDraw.Draw(out)
for c, t in enumerate(HEAD):
    d.text((LBL + PAD + c * (W + PAD), 16), t, fill=(236, 238, 242), font=font)
for r, (label, *cells) in enumerate(ROWS):
    y = TOP + r * (H + PAD)
    d.text((16, y + 8), label, fill=(166, 173, 185), font=small)
    for c, name in enumerate(cells):
        x = LBL + PAD + c * (W + PAD)
        if name is None:
            d.rectangle([x, y, x + W, y + H], fill=(16, 18, 23), outline=(40, 44, 52))
            d.text((x + 24, y + H // 2 - 12), "spB 단계엔 이 화면 캡처가 없음 (콘텐츠 픽스처는 dzB 에서 추가)", fill=(131, 139, 153), font=small)
            continue
        im = Image.open(P + name).convert("RGB")
        im = im.resize((W, int(im.height * W / im.width)), Image.LANCZOS).crop((0, 0, W, H))
        out.paste(im, (x, y))
out.save(P + "ui-dzR-compare-20261112.png")
print("saved", out.size)
