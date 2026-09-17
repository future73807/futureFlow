Add-Type -AssemblyName System.Drawing
$refDir = Get-ChildItem "D:\Desktop\futureFlow" -Directory | Where-Object { $_.Name -like "**" -and (Get-ChildItem $_.FullName -Filter "*.png" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*.png" }) } | Select-Object -First 1
$refFile = Get-ChildItem $refDir.FullName -Filter "*.png" | Where-Object { $_.Name -match "^\s*$" -or $true } | Select-Object -First 1
# find the specific file by pattern
$allPngs = Get-ChildItem "D:\Desktop\futureFlow" -Filter "*.png" -Recurse -Depth 1 | Where-Object { $_.Directory.Name -ne "gui-test-screenshots" -and $_.Directory.Name -ne "gui-full-screenshots" }
foreach ($f in $allPngs) { Write-Host "found: $($f.FullName) len=$($f.Name.Length)" }
# 目标文件名「数组是用来循环的，不是单独节点.png」共 19 个字符
$target = ($allPngs | Where-Object { $_.Name.Length -eq 19 } | Select-Object -First 1).FullName
if (-not $target) { $target = ($allPngs | Where-Object { $_.Name -match "^\d" } | Select-Object -First 1).FullName }
Write-Host "target: $target"
$img = [System.Drawing.Image]::FromFile($target)
Write-Host "Image size: $($img.Width) x $($img.Height)"
$bmp = New-Object System.Drawing.Bitmap($img)

function Crop($src, $dstPath, $sx, $sy, $sw, $sh) {
  $dest = New-Object System.Drawing.Bitmap($sw, $sh)
  $g = [System.Drawing.Graphics]::FromImage($dest)
  $srcRect = New-Object System.Drawing.Rectangle($sx, $sy, $sw, $sh)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)
  $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $dest.Save($dstPath)
  $dest.Dispose()
}

Crop $bmp "D:\Desktop\futureFlow\gui-test-screenshots\ref_loop_card.png" 350 280 1100 500
Crop $bmp "D:\Desktop\futureFlow\gui-test-screenshots\ref_loop_body.png" 250 780 1400 520
Crop $bmp "D:\Desktop\futureFlow\gui-test-screenshots\ref_loop_panel.png" 1950 200 600 700
Write-Host "crops saved"
