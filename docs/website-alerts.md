# Website Alerts connector

Website Alerts is an optional, read-only connector. Users add sites from Settings; Hover Island does not add or pair any site by default. Up to 12 connections are supported. Polling runs in the desktop process even when the widget is hidden.

## Security and behavior

- Remote origins must use HTTPS. Plain HTTP is accepted only for `localhost` or a loopback IP during development.
- Requests use native HTTPS with redirects disabled, a twelve-second request timeout, and a 512 KiB response limit. The client sends no cookies and does not inspect browser storage or service workers.
- Connection keys and polling cursors are encrypted using Windows DPAPI in the per-user app-data directory. Keys never appear in frontend IPC responses, app settings, or logs.
- Feed URLs and alert links must remain on the configured origin. The UI opens only HTTPS links (or localhost HTTP links) from an alert.
- Removing a connection removes its locally stored key. ERP device keys should also be revoked in the ERP's notification settings.
- The initial feed snapshot is quiet. Later new events and changed events are passed to the notification shell, where Do Not Disturb and optional sound preferences are applied.

## ERP adapter

Store Inventory ERP uses its device connection key, created while signed in from ERP Settings. The user pastes the one-time displayed `hi_` device token into Hover Island. The native connector validates it with `GET /api/integrations/hover-island/events` and then stores it encrypted. It never tries to create an ERP device or reuse browser authentication. The feed returns `{ "version": 1, "events": [], "hasMore": false, "nextCursor": null }`, may use `ETag` / `If-None-Match` and `304`, and accepts `cursor` for bounded pagination. ERP event priority values are `normal`, `high`, or `urgent`.

## Generic website feed

A website can opt into the connector with either an explicit alert-feed path entered in Settings or this discovery document:

`GET /.well-known/hover-island.json`

```json
{
  "version": 1,
  "name": "Example workspace",
  "feedPath": "/api/hover-island/events",
  "auth": "bearer"
}
```

`name` is optional metadata; the user chooses the local display name in Settings. `auth` is optional and may be `bearer` or `none`. If the feed requires bearer authentication, the user may enter its key in Settings; Hover Island sends it only as `Authorization: Bearer …` to the configured origin. The generic adapter does not provide an OAuth sign-in flow or create keys. An explicit path skips discovery. Both path and discovered feed must be an absolute same-origin path beginning with `/`, with no query or fragment.

The feed is fetched with `GET` and may return an `ETag`; respond with `304 Not Modified` when unchanged. A `200` response has this versioned shape:

```json
{
  "version": 1,
  "events": [
    {
      "id": "stable-event-id",
      "app": "Example workspace",
      "title": "Approval needed",
      "body": "A purchase needs review.",
      "timestamp": 1792000000000,
      "priority": "high",
      "url": "/approvals/123"
    }
  ]
}
```

Only `id`, `title`, `body`, and `timestamp` are required. `app`, `priority`, and `url` are optional. Timestamp is Unix time in milliseconds. Priority is `normal`, `low`, `high`, or `urgent`. IDs should remain stable across updates; changing the event's timestamp, title, body, priority, or URL is treated as an update. Keep the response to at most 100 events and under 512 KiB. Links are opened only when they resolve to the same origin.
