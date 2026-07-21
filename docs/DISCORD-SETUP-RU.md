# Настройка Discord-приложения и бота

Discord-бот встроен в тот же Node.js-процесс, что и портал. Отдельный Railway-сервис не требуется.

## 1. Создание приложения

1. Откройте Discord Developer Portal.
2. Нажмите **New Application** и задайте имя бота.
3. Скопируйте **Application ID** в `DISCORD_CLIENT_ID`.
4. На странице **OAuth2** создайте Client Secret и добавьте его в `DISCORD_CLIENT_SECRET`.
5. На странице **Bot** создайте бота, сбросьте/скопируйте токен и добавьте его в `DISCORD_BOT_TOKEN`.

Токен является паролем бота. Не отправляйте его в чат, не храните в GitHub и не помещайте в DLL.

## 2. Привязка Discord к личному кабинету

В **OAuth2 → Redirects** добавьте точный адрес:

```text
https://foundation-portal-production-081c.up.railway.app/api/integrations/discord/callback
```

В Railway задайте:

```env
APP_BASE_URL=https://foundation-portal-production-081c.up.railway.app
```

Для привязки аккаунта используется OAuth2 scope `identify`.

## 3. Установка бота на Discord-сервер

В разделе **Installation** включите установку на сервер и задайте:

Scopes:

- `bot`
- `applications.commands`

Права бота:

- View Channels
- Send Messages
- Embed Links
- Read Message History

После установки убедитесь, что эти права разрешены именно в каналах ивентов и журнала.

## 4. Получение ID

В Discord включите **Режим разработчика** и скопируйте:

```env
DISCORD_GUILD_ID=ID_ВАШЕГО_DISCORD_СЕРВЕРА
DISCORD_EVENT_CHANNEL_ID=ID_КАНАЛА_ИВЕНТОВ
DISCORD_LOG_CHANNEL_ID=ID_СЛУЖЕБНОГО_ЖУРНАЛА
```

`DISCORD_LOG_CHANNEL_ID` необязателен. Если он пустой, служебные записи в Discord не отправляются.

## 5. Переменные Railway

Полный набор:

```env
APP_BASE_URL=https://foundation-portal-production-081c.up.railway.app
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_EVENT_CHANNEL_ID=
DISCORD_LOG_CHANNEL_ID=
```

После сохранения переменных выполните **Redeploy**.

## 6. Команды бота

После запуска бот автоматически регистрирует команды на указанном сервере:

- `/profile` — личное досье, баллы и статистика;
- `/warnings` — активные устные предупреждения и строгие выговоры;
- `/events` — последние завершённые ивенты;
- `/event-top` — рейтинг организаторов;
- `/event-active` — активные ивенты;
- `/link` — ссылка на привязку Discord к порталу.

Личные сведения в `/profile` и `/warnings` выводятся скрытым сообщением.

## 7. Автоматические сообщения

При начале ивента бот публикует карточку в канале ивентов. При завершении или отмене он обновляет ту же карточку. Если исходное сообщение удалено, бот создаст новое.

Для работы достаточно `Guilds Intent`; доступ к содержимому обычных сообщений не используется.
