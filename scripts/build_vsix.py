import json
import os
import shutil
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / 'package.json'
PACKAGE_NLS = ROOT / 'package.nls.json'
OUTPUT_DIR = ROOT / 'dist'
EXTENSION_DIR_NAME = 'extension'
INCLUDE_FILES = [
    'package.json',
    'package.nls.json',
    'package.nls.zh-cn.json',
    'package.nls.zh-hans.json',
    'package.nls.zh.json',
    'README.md',
    'README.zh-CN.md',
    'extension.js',
    'scripts/query_codex_logs.py',
]

CONTENT_TYPES_XML = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="py" ContentType="text/x-python" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'''


def build_manifest(pkg: dict) -> str:
    identity_id = escape(pkg['name'])
    publisher = escape(pkg['publisher'])
    version = escape(pkg['version'])
    localized = load_localization_map()
    display_name = escape(resolve_localized_string(pkg.get('displayName', pkg['name']), localized))
    description = escape(resolve_localized_string(pkg.get('description', ''), localized))
    tags = escape(','.join(pkg.get('keywords', [])))
    categories = escape(','.join(pkg.get('categories', [])))
    engine = escape(pkg['engines']['vscode'])

    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{identity_id}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Tags>{tags}</Tags>
    <Categories>{categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="zh-CN,zh-Hans,zh" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
'''


def load_localization_map() -> dict:
    if not PACKAGE_NLS.exists():
        return {}

    return json.loads(PACKAGE_NLS.read_text(encoding='utf-8-sig'))


def resolve_localized_string(value: str, localized: dict) -> str:
    if not isinstance(value, str):
        return str(value)

    if len(value) >= 3 and value.startswith('%') and value.endswith('%'):
        return str(localized.get(value[1:-1], value))

    return value


def main() -> int:
    pkg = json.loads(PACKAGE_JSON.read_text(encoding='utf-8-sig'))
    OUTPUT_DIR.mkdir(exist_ok=True)
    out_name = f"{pkg['publisher']}.{pkg['name']}-{pkg['version']}.vsix"
    out_path = OUTPUT_DIR / out_name

    if out_path.exists():
        out_path.unlink()

    with zipfile.ZipFile(out_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
        zf.writestr('extension.vsixmanifest', build_manifest(pkg))

        for relative in INCLUDE_FILES:
            src = ROOT / relative
            if not src.exists():
                raise FileNotFoundError(f'Missing required file: {src}')
            arcname = f"{EXTENSION_DIR_NAME}/{relative.replace(os.sep, '/')}"
            zf.write(src, arcname)

    print(out_path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
