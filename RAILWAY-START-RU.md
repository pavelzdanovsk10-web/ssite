# Railway: быстрый старт

Подробная инструкция находится в `docs/RAILWAY-DEPLOY-RU.md`.

Критически важные настройки:

```env
NODE_ENV=production
APP_BASE_URL=https://ваш-домен.up.railway.app
DATA_DIR=/app/data
JWT_SECRET=случайная-длинная-строка
GAME_API_KEY=отдельный-ключ-игрового-сервера
```

Подключите Volume к `/app/data`.
