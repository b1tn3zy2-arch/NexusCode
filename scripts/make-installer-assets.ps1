
ъ# Generates branded NSIS installer bitmaps (24-bit BMP, NSIS-safe).
#   src-tauri/installer-assets/header.bmp  (150x57)  - installer pages header
#   src-tauri/installer-assets/sidebar.bmp (164x314) - welcome / finish pages
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "src-tauri\installer-assets"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-GradientBrush($g, $w, $h) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(26, 26, 35),
    [System.Drawing.Color]::FromArgb(49, 46, 129),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
  )
  return $brush
}

function Draw-Logo($g, $cx, $cy, $r) {
  # indigo rounded badge
  $badge = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(99, 102, 241))
  $rect = New-Object System.Drawing.Rectangle(($cx - $r), ($cy - $r), ($r * 2), ($r * 2))
  $g.FillEllipse($badge, $rect)
  $badge.Dispose()
  # white "N"
  $font = New-Object System.Drawing.Font("Segoe UI", ($r * 1.05), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $box = New-Object System.Drawing.RectangleF(($cx - $r), ($cy - $r - 2), ($r * 2), ($r * 2 + 4))
  $g.DrawString("N", $font, $white, $box, $fmt)
  $font.Dispose(); $white.Dispose(); $fmt.Dispose()
}

function Save-Bmp($bmp, $path) {
  # Force 24-bit BMP: NSIS classic bitmaps must not be 32-bit with alpha.
  $b24 = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($b24)
  $g.DrawImage($bmp, 0, 0)
  $g.Dispose()
  $bmp.Dispose()
  $b24.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $b24.Dispose()
  Write-Host "wrote $path"
}

# ---- sidebar 164x314 ----
$w = 164; $h = 314
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.FillRectangle((New-GradientBrush $g $w $h), 0, 0, $w, $h)
# soft glow circle behind logo
$glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 99, 102, 241))
$g.FillEllipse($glow, -40, 20, 244, 244)
$glow.Dispose()
Draw-Logo $g 82 105 44
# product name
$font = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("NexusCode", $font, $white, (New-Object System.Drawing.RectangleF(0, 168, $w, 30)), $fmt)
$font.Dispose()
$font2 = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 170, 190))
$g.DrawString("AI-native code editor", $font2, $dim, (New-Object System.Drawing.RectangleF(0, 194, $w, 20)), $fmt)
$font2.Dispose(); $white.Dispose(); $dim.Dispose(); $fmt.Dispose()
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "sidebar.bmp")

# ---- header 150x57 ----
$w = 150; $h = 57
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.FillRectangle((New-GradientBrush $g $w $h), 0, 0, $w, $h)
Draw-Logo $g 28 28 17
$font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawString("NexusCode", $font, $white, 52, 14)
$font.Dispose()
$font2 = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 170, 190))
$g.DrawString("Setup", $font2, $dim, 53, 33)
$font2.Dispose(); $white.Dispose(); $dim.Dispose()
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "header.bmp")
