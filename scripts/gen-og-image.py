"""Generate public/img/og-image.png — 1200x630 dark-neon 'IOST Terminal' card."""
import math
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630
BG = (4, 6, 10)
CYAN = (0, 229, 255)
VIOLET = (124, 92, 255)
MINT = (34, 211, 170)
RED = (255, 92, 92)
TEXT = (232, 241, 248)
MUTED = (130, 148, 166)

MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# radial glows (layered ellipses, blurred once)
glow = Image.new("RGB", (W, H), BG)
gd = ImageDraw.Draw(glow)
gd.ellipse([-250, -300, 650, 350], fill=(0, 80, 100))            # cyan top-left
gd.ellipse([700, 250, 1500, 900], fill=(60, 30, 130))           # violet bottom-right
glow = glow.filter(ImageFilter.GaussianBlur(180))
img = Image.alpha_composite(img.convert("RGBA"), glow.convert("RGBA")).convert("RGB")
d = ImageDraw.Draw(img)

# horizon grid (faint)
for i in range(-1, 14):
    x = i * 96
    d.line([(x, 430), (x + 260, 630)], fill=(20, 34, 48), width=1)
for j in range(9):
    y = 430 + j * 25
    d.line([(0, y), (W, y)], fill=(12, 22, 32), width=1)

# candlestick row (market tape vibe)
rng = random.Random(7)
x = 60
for i in range(16):
    up = rng.random() > 0.45
    color = MINT if up else RED
    body_h = rng.randint(18, 52)
    body_y = 430 + rng.randint(0, 30)
    wick_h = rng.randint(10, 26)
    d.line([(x + 14, body_y - wick_h), (x + 14, body_y + body_h + wick_h)], fill=color, width=2)
    d.rectangle([x, body_y, x + 28, body_y + body_h], fill=color)
    x += 68

# accent rule
d.rectangle([60, 118, 320, 124], fill=CYAN)

# title
def font(path, size):
    return ImageFont.truetype(path, size)

d.text((60, 150), "\u25c7 IOST", font=font(MONO_B, 84), fill=TEXT)
d.text((60, 150), "\u25c7 ", font=font(MONO_B, 84), fill=CYAN)
# measure to place TERMINAL beside IOST
w_iost = d.textlength("\u25c7 IOST", font=font(MONO_B, 84))
d.text((60 + w_iost + 18, 150), "TERMINAL", font=font(MONO_B, 84), fill=CYAN)

d.text((62, 268), "AI REAL-TRADING PLATFORM", font=font(SANS_B, 34), fill=TEXT)
d.text((62, 322), "Live crypto & equities · 8 AI engines · on-chain intelligence", font=font(MONO_B, 22), fill=MUTED)
d.text((62, 362), "PAPER-FIRST EXECUTION · AGENT-READY API", font=font(MONO_B, 18), fill=VIOLET)

# corner tag
d.text((W - 380, H - 64), "iostcallister.com", font=font(MONO_B, 22), fill=(70, 90, 110))

img.save("/opt/data/iost-terminal/public/img/og-image.png", "PNG")
print("wrote /opt/data/iost-terminal/public/img/og-image.png", img.size)
