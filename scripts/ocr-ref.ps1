# Windows 自带 OCR：提取整图文字 + 词级坐标（zh-CN 优先，失败退 en-US）
param(
    [string]$ImagePath = "D:\Desktop\futureFlow\参考图\loopref.png",
    [string]$OutJson = "D:\Desktop\futureFlow\scripts\ocr-result.json"
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]

# 语言选择
$lang = $null
try { $lang = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]::new("zh-CN") } catch {}
$engine = $null
if ($lang) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw "没有可用 OCR 引擎" }
Write-Host ("OCR 语言: " + $engine.RecognizerLanguage.LanguageTag)

# 异步等待封装
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$words = @()
foreach ($line in $result.Lines) {
    foreach ($w in $line.Words) {
        $words += [PSCustomObject]@{
            text = $w.Text
            x = [int]$w.BoundingRect.X; y = [int]$w.BoundingRect.Y
            w = [int]$w.BoundingRect.Width; h = [int]$w.BoundingRect.Height
            line = $line.Text
        }
    }
}
$words | ConvertTo-Json -Depth 3 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host ("行数: " + $result.Lines.Count + "  词数: " + $words.Count)
$result.Lines | ForEach-Object { Write-Host ($_.Text) }
