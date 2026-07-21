# Развёртывание на Railway

## 1. Подготовьте GitHub

1. Создайте приватный репозиторий.
2. Загрузите содержимое папки проекта в корень репозитория.
3. Не загружайте `.env`, папку `data`, базу `foundation.db` и `node_modules`.

## 2. Подключите репозиторий к Railway

1. Откройте существующий проект Railway.
2. Выберите сервис сайта.
3. В `Settings → Source` подключите нужный GitHub-репозиторий и ветку.
4. Railway определит команду запуска `npm start` из `package.json`.

## 3. Добавьте переменные

В сервисе откройте `Variables` и добавьте:

```env
NODE_ENV=production
APP_BASE_URL=https://ВАШ-ДОМЕН.up.railway.app
DATA_DIR=/app/data
JWT_SECRET=ДЛИННАЯ_СЛУЧАЙНАЯ_СТРОКА
ADMIN_LOGIN=administrator
ADMIN_PASSWORD=СЛОЖНЫЙ_ПАРОЛЬ
ALLOW_REGISTRATION=true
REGISTRATION_CODE=КОД_ПРИГЛАШЕНИЯ
GAME_API_KEY=СЕКРЕТНЫЙ_КЛЮЧ_ДЛЯ_SCP_SL

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_EVENT_CHANNEL_ID=
DISCORD_LOG_CHANNEL_ID=
STEAM_WEB_API_KEY=
```

`PORT` вручную задавать не нужно: Railway передаст его автоматически.

## 4. Подключите постоянный диск

1. Добавьте Railway Volume к сервису.
2. Укажите mount path `/app/data`.
3. Проверьте, что `DATA_DIR=/app/data`.

Без Volume база и аватары могут потеряться при новом развёртывании.

## 5. Перезапустите сервис

После добавления переменных нажмите `Deploy` или `Redeploy`.

## Обновление существующего портала

Новая версия выполняет миграции старой SQLite-базы автоматически. Перед первым обновлением всё равно создайте резервную копию Volume.
