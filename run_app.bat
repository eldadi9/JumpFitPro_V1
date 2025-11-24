@echo off
REM Start local dev server (Vite)

cd /d "C:\Users\Master_PC\Desktop\IPtv_projects\Projects Eldad\JumpFitPro\webapp_Main" || goto cd_error

echo.
echo ================================
echo Starting local dev server...
echo URL: http://localhost:5173/
echo Close this window to stop server
echo ================================
echo.

npm run dev
pause
goto end

:cd_error
echo Failed to change directory to project folder.
pause

:end
