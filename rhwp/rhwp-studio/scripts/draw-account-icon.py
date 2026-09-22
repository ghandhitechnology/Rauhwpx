"""Extract the app mascot's silhouette and render it with smooth edges.
Run: uv run --with pillow python scripts/draw-account-icon.py
"""
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

root = Path(__file__).resolve().parents[1]
source = Image.open(root / 'public/icons/icon-512.png').convert('RGB')
width, height = source.size
# The mascot is white; the rounded blue application tile is excluded.
outline = {(x, y) for y in range(height) for x in range(width)
           if min(source.getpixel((x, y))) >= 210
           and max(source.getpixel((x, y))) - min(source.getpixel((x, y))) <= 30}
# Flood from outside: everything enclosed by the outer mascot contour is solid.
outside = set()
queue = deque([(x, y) for x in range(width) for y in (0, height - 1)]
              + [(x, y) for y in range(height) for x in (0, width - 1)])
while queue:
    x, y = queue.popleft()
    if not (0 <= x < width and 0 <= y < height) or (x, y) in outside or (x, y) in outline:
        continue
    outside.add((x, y))
    queue.extend(((x-1, y), (x+1, y), (x, y-1), (x, y+1)))
mask = Image.new('L', (width, height))
mask.putdata([0 if (x, y) in outside else 255 for y in range(height) for x in range(width)])
mask = mask.crop(mask.getbbox())
# Smooth the high-resolution contour and preserve transparent margins.
mask = mask.filter(ImageFilter.GaussianBlur(0.6))
mask.thumbnail((224, 224), Image.Resampling.LANCZOS)
canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
ink = Image.new('RGBA', mask.size, (0, 0, 0, 255))
canvas.paste(ink, ((256-mask.width)//2, (256-mask.height)//2), mask)
canvas.save(root / 'src/ui/agent-sidebar/assets/rauhwpx-silhouette.png')
