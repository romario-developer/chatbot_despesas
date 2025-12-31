@echo off
setlocal enabledelayedexpansion

REM ===== CONFIGURE AQUI =====
REM Coloque a URL do seu serviço Render (a principal)
set "RENDER_URL=https://chatbot-despesas.onrender.com"
REM Branch padrão do seu repo (master ou main)
set "BRANCH=master"
REM ===========================

echo.
echo ===== DEPLOY (GitHub -> Render) =====
echo Repo branch: %BRANCH%
echo Render URL  : %RENDER_URL%
echo.

REM 0) Checagem rápida do status
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERRO: voce nao esta dentro de um repositorio Git.
  goto :fail
)

REM 1) Puxa status e verifica se tem mudanca
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i
if "%CHANGES%"=="0" (
  echo Nenhuma mudanca detectada. Nada para deploy.
  goto :done
)

REM 2) Bloqueia se schema.prisma mudou (para evitar quebrar producao)
for /f "delims=" %%A in ('git diff --name-only') do (
  if /I "%%A"=="prisma/schema.prisma" (
    echo.
    echo BLOQUEADO: prisma/schema.prisma foi alterado.
    echo Isso normalmente exige migrations. Para evitar quebrar producao, o deploy foi cancelado.
    echo Se foi intencional, me chame aqui e eu te passo o comando certo para gerar a migration.
    echo.
    goto :fail
  )
)

REM 3) Build local (garante que nao vai quebrar no Render)
echo Rodando npm ci...
call npm ci
if errorlevel 1 goto :fail

echo Rodando build (tsc)...
call npm run build
if errorlevel 1 goto :fail

REM 4) Pede mensagem de commit
echo.
set /p COMMIT_MSG="Mensagem do commit (enter para usar padrao): "

if "%COMMIT_MSG%"=="" (
  REM data/hora em formato simples
  for /f "tokens=1-3 delims=/" %%a in ("%date%") do set D=%%c-%%b-%%a
  for /f "tokens=1-2 delims=:" %%a in ("%time%") do set T=%%a%%b
  set "COMMIT_MSG=deploy: update %D% %T%"
)

echo.
echo Commit message: "%COMMIT_MSG%"
echo.

REM 5) Add e commit
echo Adicionando arquivos (respeitando .gitignore)...
git add -A
if errorlevel 1 goto :fail

echo Fazendo commit...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo.
  echo Nada para commitar (talvez so arquivos ignorados). Encerrando.
  goto :done
)

REM 6) Push
echo Enviando para o GitHub...
git push origin %BRANCH%
if errorlevel 1 goto :fail

echo.
echo SUCESSO: Push enviado. O Render vai iniciar o deploy automaticamente.
echo Acompanhe em: %RENDER_URL%
echo.
echo Dica: teste o health: %RENDER_URL%/health
echo.
goto :done

:fail
echo.
echo Falhou. Veja o erro acima.
echo.
exit /b 1

:done
exit /b 0
