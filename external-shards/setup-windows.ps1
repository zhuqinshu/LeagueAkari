# 在 Windows 上把 match-sync shard 装进 League Akari 安装目录。
#
# 为什么要用脚本：League Akari 只扫描「LeagueAkari.exe 同级目录下的 shards\」，
# 而官方发行包里没有这个目录（代码里是 existsSync 判断，不存在就跳过），
# 所以要自己新建。手工做要翻安装路径、建目录、新建 JSON 再填 token，容易出错。
#
# 用法（把本文件与 match-sync.js 放在同一个目录，一起拷到 Windows）：
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Token <SYNC_TOKEN>
#   # 应用没在运行、自动定位不到 exe 时，显式指定：
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Token <SYNC_TOKEN> -ExePath "D:\league-akari\LeagueAkari.exe"
#
# SYNC_TOKEN 在服务器上取：ssh tx "grep '^SYNC_TOKEN' /opt/lol-match/.env"
# 令牌只写进本机的配置文件，不要提交到任何仓库。

param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$ExePath,
    [string]$Endpoint = 'https://lol-api.yichuang.store/api/v1/sync/matches',
    [int]$IntervalSeconds = 180
)

$ErrorActionPreference = 'Stop'

# 1. 定位安装目录：优先用显式传入的 exe，其次从正在运行的进程里取
if (-not $ExePath) {
    $process = Get-Process -Name 'LeagueAkari' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($process) { $ExePath = $process.Path }
}

if (-not $ExePath) {
    throw '没找到 LeagueAkari.exe。先启动一次 League Akari，或用 -ExePath 指定 exe 的完整路径。'
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "指定的 exe 不存在: $ExePath"
}

$appDir = Split-Path -Parent $ExePath
Write-Host "安装目录: $appDir"

# 2. 放 shard。目录扫描不递归，文件必须直接位于 shards\ 下
$shardsDir = Join-Path $appDir 'shards'
New-Item -ItemType Directory -Path $shardsDir -Force | Out-Null

$shardSource = Join-Path $PSScriptRoot 'match-sync.js'
if (-not (Test-Path -LiteralPath $shardSource)) {
    throw "同目录下找不到 match-sync.js，请把本脚本和它一起拷过来。查找位置: $shardSource"
}

$shardTarget = Join-Path $shardsDir 'match-sync.js'
Copy-Item -LiteralPath $shardSource -Destination $shardTarget -Force
Write-Host "已放入 shard: $shardTarget"

# 3. 写配置。必须写成不带 BOM 的 UTF-8：
#    shard 用 JSON.parse 读这个文件，BOM 会让解析失败并退回默认值，
#    表现是「看起来装好了但一局都不上报」，排查成本很高
$configPath = Join-Path $shardsDir 'match-sync.config.json'
$config = [ordered]@{
    endpoint            = $Endpoint
    token               = $Token
    intervalSeconds     = $IntervalSeconds
    initialDelaySeconds = 15
}
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入配置: $configPath"

Write-Host ''
Write-Host '下一步：完全退出并重新启动 League Akari（配置只在启动时读一次），然后保持它开着。'
Write-Host '启动后到日志目录里确认出现这一行：Loaded external shard match-sync.js'
Write-Host "日志目录: $(Join-Path $appDir 'logs')"
