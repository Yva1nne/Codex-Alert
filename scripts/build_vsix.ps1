$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $root 'package.json'
$packageNlsPath = Join-Path $root 'package.nls.json'
$outputDir = Join-Path $root 'dist'
$extensionDirName = 'extension'
$includeFiles = @(
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json',
  'package.nls.zh-hans.json',
  'package.nls.zh.json',
  'README.md',
  'README.zh-CN.md',
  'extension.js',
  'scripts/query_codex_logs.py'
)

$contentTypesXml = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="py" ContentType="text/x-python" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'@

function Get-JsonPropertyValue {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)][string] $Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Resolve-LocalizedString {
  param(
    [AllowNull()][string] $Value,
    [AllowNull()] $Localized
  )

  if ([string]::IsNullOrEmpty($Value)) {
    return ''
  }

  if ($Value.Length -ge 3 -and $Value.StartsWith('%') -and $Value.EndsWith('%')) {
    $key = $Value.Substring(1, $Value.Length - 2)
    $localizedValue = Get-JsonPropertyValue -Object $Localized -Name $key
    if ($null -ne $localizedValue) {
      return [string] $localizedValue
    }
  }

  return $Value
}

function Escape-Xml {
  param([AllowNull()][string] $Value)
  if ($null -eq $Value) {
    return ''
  }

  return [System.Security.SecurityElement]::Escape($Value)
}

function Add-StringEntry {
  param(
    [Parameter(Mandatory = $true)] $Archive,
    [Parameter(Mandatory = $true)][string] $EntryName,
    [Parameter(Mandatory = $true)][string] $Content
  )

  $entry = $Archive.CreateEntry($EntryName)
  $stream = $entry.Open()
  try {
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
    try {
      $writer.Write($Content)
    } finally {
      $writer.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$pkg = Get-Content -Raw -Encoding UTF8 $packageJsonPath | ConvertFrom-Json
$localized = Get-Content -Raw -Encoding UTF8 $packageNlsPath | ConvertFrom-Json

$displayName = Resolve-LocalizedString -Value ([string](Get-JsonPropertyValue -Object $pkg -Name 'displayName')) -Localized $localized
$description = Resolve-LocalizedString -Value ([string](Get-JsonPropertyValue -Object $pkg -Name 'description')) -Localized $localized
$name = [string](Get-JsonPropertyValue -Object $pkg -Name 'name')
$publisher = [string](Get-JsonPropertyValue -Object $pkg -Name 'publisher')
$version = [string](Get-JsonPropertyValue -Object $pkg -Name 'version')
$engines = Get-JsonPropertyValue -Object $pkg -Name 'engines'
$vscodeEngine = [string](Get-JsonPropertyValue -Object $engines -Name 'vscode')
$keywords = Get-JsonPropertyValue -Object $pkg -Name 'keywords'
$categories = Get-JsonPropertyValue -Object $pkg -Name 'categories'
$keywordText = if ($keywords) { ($keywords | ForEach-Object { [string] $_ }) -join ',' } else { '' }
$categoryText = if ($categories) { ($categories | ForEach-Object { [string] $_ }) -join ',' } else { '' }

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape-Xml $name)" Version="$(Escape-Xml $version)" Publisher="$(Escape-Xml $publisher)" />
    <DisplayName>$(Escape-Xml $displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape-Xml $description)</Description>
    <Tags>$(Escape-Xml $keywordText)</Tags>
    <Categories>$(Escape-Xml $categoryText)</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Escape-Xml $vscodeEngine)" />
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
"@

if (-not (Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$outName = '{0}.{1}-{2}.vsix' -f $publisher, $name, $version
$outPath = Join-Path $outputDir $outName

if (Test-Path $outPath) {
  Remove-Item -Force $outPath
}

$archive = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Add-StringEntry -Archive $archive -EntryName '[Content_Types].xml' -Content $contentTypesXml
  Add-StringEntry -Archive $archive -EntryName 'extension.vsixmanifest' -Content $manifest

  foreach ($relative in $includeFiles) {
    $source = Join-Path $root $relative
    if (-not (Test-Path $source)) {
      throw "Missing required file: $source"
    }

    $entryName = '{0}/{1}' -f $extensionDirName, ($relative -replace '\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $source,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

Write-Output $outPath
