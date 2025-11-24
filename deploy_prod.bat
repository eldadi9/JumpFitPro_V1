@echo off
REM Build and deploy JumpFitPro to Cloudflare Pages + D1

cd /d "C:\Users\Master_PC\Desktop\IPtv_projects\Projects Eldad\JumpFitPro\webapp_Main" || goto cd_error

echo.
echo ================================
echo Migrating DB on Cloudflare (D1)...
echo ================================
echo.

npm run db:migrate:prod
if errorlevel 1 goto error

echo.
echo ================================
echo Building and deploying to Cloudflare...
echo ================================
echo.

npm run deploy:prod
if errorlevel 1 goto error

echo.
echo Deployment finished successfully.
echo Production URL: https://jumpfitpro.pages.dev
pause
goto end

:cd_error
echo Failed to change directory to project folder.
pause
goto end

:error
echo.
echo ERROR: One of the commands failed. Check the log above.
pause

:end
