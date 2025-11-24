@echo off
REM Sync local project to GitHub

cd /d "C:\Users\Master_PC\Desktop\IPtv_projects\Projects Eldad\JumpFitPro\webapp_Main" || goto cd_error

echo.
echo ================================
echo Pulling latest from GitHub...
echo ================================
echo.

git pull origin main
if errorlevel 1 goto git_error

echo.
echo ================================
echo Adding and committing changes...
echo ================================
echo.

git add .
git commit -m "Update from Genspark"
git push origin main

echo.
echo Git push completed successfully.
pause
goto end

:git_error
echo.
echo WARNING: git pull failed. Check your repository or network.
pause
goto end

:cd_error
echo Failed to change directory to project folder.
pause

:end
