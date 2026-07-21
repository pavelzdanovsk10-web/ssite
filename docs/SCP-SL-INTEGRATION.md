# Интеграция SCP:SL / EXILED с порталом

Игровой сервер передаёт запросы с заголовком:

```http
X-API-Key: значение GAME_API_KEY
Content-Type: application/json
```

SteamID может передаваться как `7656119...` или `7656119...@steam`.

## Начало ивента

```http
POST /api/game/events/start
```

```json
{
  "eventId": "server-1-unique-event-id",
  "serverId": "scp-main-1",
  "eventName": "Прятки",
  "hostSteamId": "76561198000000000@steam",
  "startedAt": "2026-07-21T19:30:00Z"
}
```

Ответ:

```json
{
  "success": true,
  "eventId": "server-1-unique-event-id",
  "hostLinked": true,
  "hostUserId": 12,
  "hostName": "AdminName"
}
```

На одном `serverId` разрешён только один активный ивент.

## Завершение ивента

```http
POST /api/game/events/finish
```

```json
{
  "eventId": "server-1-unique-event-id",
  "serverId": "scp-main-1",
  "durationSeconds": 2520,
  "finishedAt": "2026-07-21T20:12:00Z"
}
```

Ответ:

```json
{
  "success": true,
  "eventId": "server-1-unique-event-id",
  "durationSeconds": 2520,
  "pointsAwarded": 3,
  "totalPoints": 28,
  "hostLinked": true
}
```

## Отмена

```http
POST /api/game/events/cancel
```

```json
{
  "eventId": "server-1-unique-event-id",
  "reason": "Ивент отменён руководителем"
}
```

Отменённый ивент получает 0 баллов.

## Проверка активного ивента

```http
GET /api/game/events/active?serverId=scp-main-1
```

## Пример клиента C#

```csharp
using System.Net.Http;
using System.Text;
using System.Text.Json;

public sealed class PortalApiClient
{
    private readonly HttpClient _http;

    public PortalApiClient(string baseUrl, string apiKey)
    {
        _http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/") };
        _http.DefaultRequestHeaders.Add("X-API-Key", apiKey);
    }

    public async Task StartEventAsync(
        string eventId,
        string serverId,
        string eventName,
        string hostSteamId,
        CancellationToken cancellationToken = default)
    {
        var payload = new
        {
            eventId,
            serverId,
            eventName,
            hostSteamId,
            startedAt = DateTimeOffset.UtcNow
        };

        await SendAsync("api/game/events/start", payload, cancellationToken);
    }

    public async Task FinishEventAsync(
        string eventId,
        string serverId,
        int durationSeconds,
        CancellationToken cancellationToken = default)
    {
        var payload = new
        {
            eventId,
            serverId,
            durationSeconds,
            finishedAt = DateTimeOffset.UtcNow
        };

        await SendAsync("api/game/events/finish", payload, cancellationToken);
    }

    private async Task SendAsync(string path, object payload, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(payload);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(path, content, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
}
```

В EventPanel вызов начала нужно ставить после успешного создания ивента, а завершение — после фактического `EndEvent`. Сетевой запрос не должен блокировать основной игровой поток.
