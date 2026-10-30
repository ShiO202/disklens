Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [double]($size * 0.03)
  $side = $size - $pad * 2
  $r = [double]($side * 0.23)

  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc($pad, $pad, $r * 2, $r * 2, 180, 90)
  $gp.AddArc($pad + $side - $r * 2, $pad, $r * 2, $r * 2, 270, 90)
  $gp.AddArc($pad + $side - $r * 2, $pad + $side - $r * 2, $r * 2, $r * 2, 0, 90)
  $gp.AddArc($pad, $pad + $side - $r * 2, $r * 2, $r * 2, 90, 90)
  $gp.CloseFigure()

  $rect = New-Object System.Drawing.RectangleF([single]$pad, [single]$pad, [single]$side, [single]$side)
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 43, 108, 255),
    [System.Drawing.Color]::FromArgb(255, 132, 92, 255),
    45.0
  )
  $g.FillPath($br, $gp)

  # treemap 方块布局（归一化）
  $blocks = @(
    @(0.17, 0.17, 0.36, 0.36, 240),
    @(0.56, 0.17, 0.27, 0.21, 205),
    @(0.56, 0.41, 0.27, 0.42, 225),
    @(0.17, 0.56, 0.36, 0.27, 215)
  )
  foreach ($b in $blocks) {
    $x = $pad + $side * [double]$b[0]
    $y = $pad + $side * [double]$b[1]
    $bw = $side * [double]$b[2]
    $bh = $side * [double]$b[3]
    $a = [int]$b[4]
    $rr = [Math]::Max([double]($size * 0.02), 0.8)
    $p2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p2.AddArc($x, $y, $rr * 2, $rr * 2, 180, 90)
    $p2.AddArc($x + $bw - $rr * 2, $y, $rr * 2, $rr * 2, 270, 90)
    $p2.AddArc($x + $bw - $rr * 2, $y + $bh - $rr * 2, $rr * 2, $rr * 2, 0, 90)
    $p2.AddArc($x, $y + $bh - $rr * 2, $rr * 2, $rr * 2, 90, 90)
    $p2.CloseFigure()
    $sb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, 255, 255, 255))
    $g.FillPath($sb, $p2)
    $sb.Dispose(); $p2.Dispose()
  }

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
  return , $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) { $pngs += , (New-IconPng $s) }

$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\icon.ico'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]$dim)
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngs[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($out, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

# 同时导出一张 256 PNG 给网页 favicon 用
$pngOut = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\favicon.png'
[System.IO.File]::WriteAllBytes($pngOut, (New-IconPng 256))

Write-Host "icon.ico: $((Get-Item $out).Length) bytes"
Write-Host "favicon.png: $((Get-Item $pngOut).Length) bytes"
