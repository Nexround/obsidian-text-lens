param([string]$Version)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
        $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
    } | Select-Object -First 1
    if ($null -eq $asTask) { throw 'WinRT AsTask bridge unavailable' }
    function Wait-WinRt($Operation, [Type]$ResultType) {
        $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        # The parent enforces one 30-second deadline for the whole image.
        $task.Wait()
        return $task.Result
    }
    function Write-Response($Value) {
        [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
        [Console]::Out.Flush()
    }
    $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
    $defaultEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $defaultLanguage = $null
    if ($null -ne $defaultEngine) { $defaultLanguage = $defaultEngine.RecognizerLanguage.LanguageTag }
    $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $line | ConvertFrom-Json
        if ($request.kind -eq 'info') {
            Write-Response @{ kind = 'info'; version = $Version; languages = $available; defaultLanguage = $defaultLanguage; autoDetection = $false; maxImageDimension = $limit }
            continue
        }
        if ($request.kind -ne 'recognize') { throw 'Unknown protocol request' }
        $bitmap = $null
        $stream = $null
        $code = 'recognize'
        try {
            if ($request.language -eq 'auto') { $engine = $defaultEngine }
            else {
                $language = New-Object Windows.Globalization.Language($request.language)
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            }
            if ($null -eq $engine) { throw "OCR language unavailable: $($request.language)" }
            $code = 'decode'
            $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
            $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
            $scale = [Math]::Min(1.0, $limit / [double][Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
            $resized = $scale -lt 1.0
            if ($resized) {
                $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
                $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
            }
            $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync(
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
                $transform,
                [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
                [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb
            )) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $code = 'recognize'
            $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($result.Lines | ForEach-Object { $_.Text })
            Write-Response @{ kind = 'result'; index = $request.index; ok = $true; lines = $lines; resized = $resized }
        } catch {
            Write-Response @{ kind = 'result'; index = $request.index; ok = $false; error = $_.Exception.Message; code = $code }
        } finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
