"""
把 .tmp-logos/*.bin (PNG/ICO 真实 favicon) 转成「嵌入 base64 位图的 SVG」。
保留原 logo 形状 (不做 flood-fill 矩形近似, 那会把真实 logo 变成实心块)。
avatar 容器是白底 + object-fit:contain, 透明 favicon 直接显示。

另外把 .tmp-logos 里已经是真矢量 SVG 的 (zhipu/longcat/empero) 直接拷贝。
"""
import base64
import struct
from io import BytesIO
from pathlib import Path
from PIL import Image

SRC = Path('.tmp-logos')
DST = Path('assets/logos')
DST.mkdir(exist_ok=True)

# 位图 favicon -> 厂商名 (VENDOR_LOGOS key)
RASTERS = {
    'cohere': 'cohere.bin',
    'kilo': 'kilo.bin',
    'llm7': 'llm7.bin',
    'modelscope': 'modelscope.bin',
    'siliconflow': 'siliconflow.bin',
    'volc': 'volc.bin',
    'bai': 'bai.bin',
    'aionlabs': 'aionlabs.bin',
    'cerebras': 'cerebras.bin',
}

# 已存在的真矢量 SVG, 直接拷贝
REAL_SVG = {
    'zhipu': 'zhipu.svg',
    'longcat': 'longcat.svg',
    'empero': 'empero.svg',
}

def load_image(path):
    """支持 PNG 和 ICO (取最大尺寸那张)"""
    if path.suffix.lower() == '.ico':
        with open(path, 'rb') as f:
            data = f.read()
        count = struct.unpack('<H', data[4:6])[0]
        best_off, best_area = 0, 0
        for i in range(count):
            off = 6 + i * 16
            w, h = struct.unpack('<BB', data[off:off + 2])
            area = (w or 256) * (h or 256)
            if area > best_area:
                best_area = area
                best_off = struct.unpack('<I', data[off + 12:off + 16])[0]
        return Image.open(BytesIO(data[best_off:best_off + 64 * 1024 * 1024]))
    return Image.open(path)

def embed_raster(name, src_path, max_side=64):
    img = load_image(src_path).convert('RGBA')
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    nw, nh = img.size
    buf = BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {nw} {nh}" width="64" height="64">\n'
        f'  <image width="{nw}" height="{nh}" href="data:image/png;base64,{b64}"/>\n'
        f'</svg>\n'
    )
    out = DST / f'{name}.svg'
    out.write_text(svg)
    kb = len(svg) / 1024
    print(f'✓ {name}: {src_path.name} {w}x{h} -> {nw}x{nh} svg ({kb:.1f}KB)')

for name, fname in RASTERS.items():
    p = SRC / fname
    if not p.exists():
        print(f'✗ {name}: {fname} not found')
        continue
    try:
        embed_raster(name, p)
    except Exception as e:
        print(f'✗ {name}: {e}')

for name, fname in REAL_SVG.items():
    p = SRC / fname
    if p.exists():
        (DST / f'{name}.svg').write_text(p.read_text())
        print(f'✓ {name}: copy real svg ({len(p.read_text())}B)')
    else:
        print(f'✗ {name}: {fname} not found')
