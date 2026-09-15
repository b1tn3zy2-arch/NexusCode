# Generates the NexusCode logo (1024x1024 PNG) via GDI+:
# indigo->violet gradient rounded square, two connected nodes forming an N-C link.
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$g.Clear([System.Drawing.Color]::Transparent)

# rounded-square background
$r = 220
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0,0,$r*2,$r*2,180,90)
$path.AddArc($size-$r*2,0,$r*2,$r*2,270,90)
$path.AddArc($size-$r*2,$size-$r*2,$r*2,$r*2,0,90)
$path.AddArc(0,$size-$r*2,$r*2,$r*2,90,90)
$path.CloseFigure()

$rect = New-Object System.Drawing.Rectangle(0,0,$size,$size)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255,79,70,229),   # indigo-600
    [System.Drawing.Color]::FromArgb(255,139,92,246),  # violet-500
    35.0)
$g.FillPath($grad, $path)

# subtle inner glow circle
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(180,180,664,664)
$g.FillEllipse([System.Drawing.Brushes]::White.Clone(), 0,0,1,1) | Out-Null
$semi = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28,255,255,255))
$g.FillPath($semi, $glow)

# connection line between nodes
$penW = 46
$linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
$linePen.StartCap = 'Round'
$linePen.EndCap = 'Round'
$n1 = New-Object System.Drawing.Point(300,700)   # N node (bottom-left)
$n2 = New-Object System.Drawing.Point(724,324)   # C node (top-right)
$g.DrawLine($linePen, $n1, $n2)

# diagonal accent stroke of the "N"
$diagPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200,238,242,255), 40)
$diagPen.StartCap='Round'; $diagPen.EndCap='Round'
$g.DrawLine($diagPen, 300,324, 300,700)
$g.DrawLine($diagPen, 724,324, 724,700)

# nodes
$nodeBrush = [System.Drawing.Brushes]::White
$g.FillEllipse($nodeBrush, $n1.X-95, $n1.Y-95, 190, 190)
$g.FillEllipse($nodeBrush, $n2.X-95, $n2.Y-95, 190, 190)

# letters inside nodes
$fnt = New-Object System.Drawing.Font('Segoe UI', ([float]96), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$indigoText = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255,79,70,229))

$fmtN = New-Object System.Drawing.StringFormat
$fmtN.Alignment='Center'; $fmtN.LineAlignment='Center'
$rectN = New-Object System.Drawing.RectangleF(($n1.X-95), ($n1.Y-100), 190, 200)
$g.DrawString('N', $fnt, $indigoText, $rectN, $fmtN)

$rectC = New-Object System.Drawing.RectangleF(($n2.X-95), ($n2.Y-100), 190, 200)
$g.DrawString('C', $fnt, $indigoText, $rectC, $fmtN)

$out = Join-Path $PSScriptRoot "app-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "saved $out"
