# docs/04 §E-7 手工回归（docs/07 #11）：导出的 CSV 用 Excel 打开——不乱码、公式列带 ' 前缀。
# 口径：取 export-real 目录里最新一对 csv/json → Excel COM 只读打开（不弹窗不保存）→
#   1) 行数 == JSON 记录数 + 1、9 列表头与中文表头逐字一致；
#   2) 前 20 条的 会话/群号/发送人/类型/内容 与同批 JSON **逐字段相等**（Excel 真读出的值，
#      有任何乱码/截断/类型错配在这里都会现形）；
#   3) 内容列无公式（CSV 注入被 ' 前缀挡住）且存在 '@ 开头文本样本（真数据自带）。
# 用法：pwsh scripts/csv-excel-check.ps1 [-RunDir <dir>] [-Stamp <iso前缀>]
param(
  [string]$RunDir = '',
  [string]$Stamp = ''
)
$ErrorActionPreference = 'Stop'
if (-not $RunDir) { $RunDir = Join-Path $PSScriptRoot '..\test-results\real-acceptance\export-real' }
$fail = 0
function Assert([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Output "PASS  $name$(if ($detail) { " — $detail" })" }
  else { Write-Output "FAIL  $name$(if ($detail) { " — $detail" })"; $script:fail++ }
}

$pairs = Get-ChildItem $RunDir -Filter 'export-*.json' | Sort-Object LastWriteTime -Descending
if ($Stamp) { $pairs = $pairs | Where-Object { $_.Name -like "*$Stamp*" } }
$jsonFile = $pairs | Select-Object -First 1
if (-not $jsonFile) { Write-Output "FAIL  找不到 export-*.json（$RunDir）"; exit 1 }
$stampKey = ($jsonFile.BaseName -replace '^export-', '')
$csvFile = Join-Path $RunDir "export-$stampKey.csv"
if (-not (Test-Path $csvFile)) { Write-Output "FAIL  同批 CSV 不存在: $csvFile"; exit 1 }

$recs = Get-Content $jsonFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
$expectRows = $recs.Count + 1
Write-Output ">> csv=$([System.IO.Path]::GetFileName($csvFile)) json=$($jsonFile.Name) 记录=$($recs.Count)"

$excel = New-Object -ComObject Excel.Application
$wb = $null
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  $wb = $excel.Workbooks.Open($csvFile, 0, $true)   # ReadOnly, 不改写
  $ws = $wb.Worksheets.Item(1)
  $rows = $ws.UsedRange.Rows.Count
  $cols = $ws.UsedRange.Columns.Count

  Assert 'E-7a 行数 == JSON 记录数 + 1' ($rows -eq $expectRows -and $cols -eq 9) "Excel=$rows×$cols 期望=$expectRows×9"

  $expectHeaders = @('时间', '日期', '会话', '群号', '发送人', '类型', '内容', '附件', '附件路径')
  $headers = @(1..9 | ForEach-Object { [string]$ws.Cells.Item(1, $_).Value2 })
  Assert 'E-7b 中文表头逐字一致（不乱码）' (($headers -join '|') -ceq ($expectHeaders -join '|')) ($headers -join ',')

  # 前 20 条逐字段比对（一次 Range 读整列，避免逐格 COM 往返）
  $n = [Math]::Min(20, $recs.Count)
  $map = @( @{ col = 3; key = 'chat' }, @{ col = 4; key = 'chat_id' }, @{ col = 5; key = 'sender' },
            @{ col = 6; key = 'type_label' }, @{ col = 7; key = 'text' } )
  $bad = @()
  for ($m = 0; $m -lt $map.Count; $m++) {
    $col = $map[$m].col; $key = $map[$m].key
    $rng = $ws.Range($ws.Cells.Item(2, $col), $ws.Cells.Item(1 + $n, $col))
    $vals = $rng.Value2
    for ($i = 1; $i -le $n; $i++) {
      $ev = [string]$vals[$i, 1]
      $jv = [string]$recs[$i - 1].$key
      # Excel 导入 CSV 不消耗前导撇号 → 防注入样本读作 "'"+原文；其余应逐字相等
      if ($ev -cne $jv -and $ev -cne ("'" + $jv)) {
        $bad += "row$($i + 1) $key json='$($jv.Substring(0, [Math]::Min(24, $jv.Length)))' excel='$($ev.Substring(0, [Math]::Min(24, $ev.Length)))'"
      }
    }
  }
  Assert 'E-7c 前 20 条 会话/群号/发送人/类型/内容 与 JSON 逐字段相等' ($bad.Count -eq 0) `
    $(if ($bad.Count) { ($bad[0..([Math]::Min(2, $bad.Count - 1))] -join ' ; ') } else { "$n 条 × 5 字段全等" })

  # 内容列：无公式（' 前缀挡住注入）+ 存在 '@ 开头样本
  $rng7 = $ws.Range($ws.Cells.Item(2, 7), $ws.Cells.Item($rows, 7))
  $hasFormula = $rng7.HasFormula
  $colVals = $rng7.Value2
  $atCount = 0
  for ($i = 1; $i -le ($rows - 1); $i++) {
    $v = [string]$colVals[$i, 1]
    if ($v -like '@*' -or $v -like "'@*") { $atCount++ }   # 撇号为字面字符（防注入前缀，Excel 不消耗）
  }
  Assert 'E-7d 内容列无公式注入（CSV '' 前缀生效）' ($hasFormula -eq $false) "HasFormula=$hasFormula"
  Assert 'E-7e 存在 ''@ 开头文本样本（Excel 读为文本）' ($atCount -gt 0) "命中 $atCount 个"
} catch {
  Assert 'E-7 Excel COM 打开' $false $_.Exception.Message
} finally {
  if ($wb) { $wb.Close($false) | Out-Null }
  $excel.Quit() | Out-Null
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}

Write-Output ''
if ($fail -eq 0) { Write-Output '# 结果：E-7 全部通过'; exit 0 }
Write-Output "# 结果：$fail 项失败"; exit 1
