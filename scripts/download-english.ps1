$ErrorActionPreference = 'Stop'
$rawDirectory = Join-Path $PSScriptRoot '..\data\english\raw'
[System.IO.Directory]::CreateDirectory($rawDirectory) | Out-Null
foreach ($sourceSplit in @('train', 'validation', 'test')) {
    $sourceCount = if ($sourceSplit -eq 'train') { 500 } else { 200 }
    $sourceRows = [System.Collections.Generic.List[object]]::new()
    for ($sourceOffset = 0; $sourceOffset -lt $sourceCount; $sourceOffset += 100) {
        $sourceUrl = "https://datasets-server.huggingface.co/rows?dataset=ehovy%2Frace&config=middle&split=$sourceSplit&offset=$sourceOffset&length=100"
        for ($sourceAttempt = 1; ; $sourceAttempt++) {
            try {
                $sourcePage = Invoke-RestMethod -Uri $sourceUrl -TimeoutSec 30
                if ($sourcePage.rows.Count -ne 100) { throw 'Unexpected RACE-M page length' }
                break
            } catch { if ($sourceAttempt -ge 3) { throw } }
        }
        foreach ($sourceItem in $sourcePage.rows) {
            $sourceRow = $sourceItem.row
            $sourceRow | Add-Member -NotePropertyName 'row' -NotePropertyValue $sourceItem.row_idx -Force
            $sourceRows.Add($sourceRow)
        }
    }
    $sourceText = @{ dataset = 'ehovy/race'; config = 'middle'; split = $sourceSplit; source = 'https://huggingface.co/datasets/ehovy/race'; rows = $sourceRows.ToArray() } | ConvertTo-Json -Depth 10 -Compress
    $sourcePath = Join-Path $rawDirectory "$sourceSplit.json"
    [System.IO.File]::WriteAllText($sourcePath, $sourceText, [System.Text.UTF8Encoding]::new($false))
    (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content -LiteralPath (Join-Path $rawDirectory "$sourceSplit.sha256") -NoNewline -Encoding utf8
    @{ split = $sourceSplit; rows = $sourceRows.Count } | ConvertTo-Json -Compress
}
