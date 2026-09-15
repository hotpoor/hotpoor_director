"""Derive dark-theme assets from the supplied transparent original (Pillow)."""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]

def main():
    source = Image.open(ROOT / 'assets/logo-original.png').convert('RGBA')
    # Ignore nearly invisible export noise when finding the artwork bounds.
    bounds = source.getchannel('A').point(lambda a: 255 if a >= 16 else 0).getbbox()
    logo = source.crop(bounds)
    logo.save(ROOT / 'assets/logo.png')
    white = Image.new('RGBA', logo.size, 'white')
    white.putalpha(logo.getchannel('A'))
    white.save(ROOT / 'assets/logo-white.png')
    icon = ImageOps.pad(white, (1024, 1024), Image.Resampling.LANCZOS, color=(0, 0, 0, 0))
    icon.save(ROOT / 'assets/icon.png')
    icon.save(ROOT / 'assets/icon.ico', sizes=[(n, n) for n in (16,24,32,48,64,128,256)])
    white.thumbnail((640,640), Image.Resampling.LANCZOS)
    web = ROOT / 'backend/web/brand'
    white.save(web / 'logo.png')
    logo.save(web / 'favicon-black.png')
    icon.save(web / 'favicon.ico', sizes=[(n,n) for n in (16,32,48,64)])
    icon.resize((180,180), Image.Resampling.LANCZOS).save(web / 'apple-touch-icon.png')
    print('Transparent brand assets regenerated:', bounds)

if __name__ == '__main__':
    main()
