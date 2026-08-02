@echo off
chcp 65001 >nul
echo.
echo ============================================
echo   My Study Table - 打包工具
echo ============================================
echo.
echo 请选择打包方式：
echo.
echo  [1] 快速打包（zip 压缩，无需管理员权限）- 推荐
echo  [2] 完整打包（NSIS 安装程序，需管理员权限）
echo  [3] 仅构建解压版（--dir 模式）
echo  [4] 发布构建（NSIS 安装程序并上传 GitHub Releases）
echo.
set /p choice="请输入选项 (1/2/3/4): "

if "%choice%"=="1" goto zip
if "%choice%"=="2" goto full
if "%choice%"=="3" goto dir
if "%choice%"=="4" goto publish
echo 无效输入，退出。
pause
exit /b

::zip
echo.
echo 正在打包解压版为 zip...
if not exist "dist\win-unpacked" (
  echo 错误：dist\win-unpacked 不存在，请先运行 build
  pause
  exit /b
)
for /f "usebackq tokens=2 delims=:," %%a in (`findstr /C:"\"version\"" package.json`) do set VER=%%a
set VER=%VER: =%
set VER=%VER:"=%
powershell -Command "Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath 'dist\My_Study_Table_v%VER%.zip' -Force"
if %ERRORLEVEL% EQU 0 (
  echo 打包成功！输出文件：dist\My_Study_Table_v%VER%.zip
) else (
  echo 打包失败
)
pause
exit /b

::full
echo.
echo 正在构建完整安装程序（需要管理员权限）...
echo 如果失败，请右键点击本脚本选择"以管理员身份运行"
echo.
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx.cmd electron-builder --win
if %ERRORLEVEL% EQU 0 (
  echo 构建成功！
) else (
  echo 构建失败，请尝试以管理员身份运行
)
pause
exit /b

::dir
echo.
echo 正在构建解压版...
call npx.cmd electron-builder --win --dir
if %ERRORLEVEL% EQU 0 (
  echo 构建成功！输出目录：dist\win-unpacked
) else (
  echo 构建失败
)
pause
exit /b

::publish
echo.
echo 正在构建并发布到 GitHub Releases...
echo.
echo 要求：
echo   1) 已配置 GitHub 访问令牌（环境变量 GH_TOKEN）
echo   2) package.json 的 build.publish 已配置正确的 owner/repo
echo   3) 本机已安装 git 命令行工具
echo.
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx.cmd electron-builder --win nsis --publish always
if %ERRORLEVEL% EQU 0 (
  echo 发布成功！请到 GitHub Releases 页面确认。
) else (
  echo 发布失败。常见原因：未配置 GH_TOKEN、网络不通、或 git 未安装。
)
pause
exit /b
