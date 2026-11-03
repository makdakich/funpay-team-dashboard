import struct
import zlib
import os

def create_png(width, height, r, g, b):
    # Minimal valid PNG generator without external libraries
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    # Header
    png = b'\x89PNG\r\n\x1a\n'
    # IHDR
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    png += chunk(b'IHDR', ihdr)

    # Raw image data: filter byte (0) + RGB for each pixel
    raw_data = bytearray()
    center_x, center_y = width / 2.0, height / 2.0
    radius = min(width, height) / 2.0 - 1.0

    for y in range(height):
        raw_data.append(0) # filter type 0
        for x in range(width):
            dx = x - center_x
            dy = y - center_y
            dist = (dx*dx + dy*dy) ** 0.5
            
            # Rounded squircle or circle icon
            # Emerald green background #0e9f6e (14, 159, 110)
            if dist <= radius:
                # Lightning bolt approximate mask in the center
                nx = (x - center_x) / radius
                ny = (y - center_y) / radius
                is_bolt = False
                # Simple lightning bolt geometric region
                if -0.4 <= nx <= 0.4 and -0.7 <= ny <= 0.7:
                    if (-0.3 <= nx <= 0.2 and ny <= 0.0) or (-0.1 <= nx <= 0.35 and ny >= -0.1 and nx > ny * 0.5):
                        is_bolt = True
                
                if is_bolt:
                    raw_data.extend([255, 230, 0]) # gold lightning
                else:
                    raw_data.extend([16, 185, 129]) # emerald base
            else:
                raw_data.extend([17, 24, 39]) # dark background

    # IDAT
    compressed = zlib.compress(bytes(raw_data))
    png += chunk(b'IDAT', compressed)
    # IEND
    png += chunk(b'IEND', b'')
    return png

assets_dir = os.path.join(os.path.dirname(__file__), "..", "assets")
os.makedirs(assets_dir, exist_ok=True)

for size in [16, 48, 128]:
    data = create_png(size, size, 16, 185, 129)
    filepath = os.path.join(assets_dir, f"icon{size}.png")
    with open(filepath, "wb") as f:
        f.write(data)
    print(f"Generated {filepath}")
