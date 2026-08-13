# ============================================================
# DeepSeek Harness 启动器 - 创建桌面快捷方式
# 由 create-desktop-shortcut.bat 调用；也可直接:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1
# 注意：本文件必须保持 UTF-8 带 BOM（PowerShell 5.1 无 BOM 会按 ANSI 读取导致中文乱码）
# ============================================================

$ErrorActionPreference = "Stop"

# 启动器根目录（脚本位于 scripts/ 下）
$root = Split-Path -Parent $PSScriptRoot
$batPath = Join-Path $root "start-launcher.bat"
$iconPath = Join-Path $root "public\favicon.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "DeepSeek Harness 启动器.lnk"

if (-not (Test-Path $batPath)) {
    Write-Host "[错误] 未找到 start-launcher.bat：$batPath"
    exit 1
}
if (-not (Test-Path $iconPath)) {
    Write-Host "[提示] 未找到 public\favicon.ico（快捷方式将使用默认图标），先运行: node scripts/generate-icons.mjs"
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $batPath
$sc.WorkingDirectory = $root
if (Test-Path $iconPath) { $sc.IconLocation = "$iconPath,0" }
$sc.Description = "DeepSeek Harness 启动器"
$sc.Save()

Write-Host "已创建: $lnkPath"
