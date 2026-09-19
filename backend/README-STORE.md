# Shared store — how it works

`server.js` serves the static site **and** `/api/store`, the shared data store that
makes the app multi-user. Without it every browser keeps its own `localStorage`
and nobody sees anybody else's data.

## Run it

```bash
node server.js          # or:  npm start
# default: http://0.0.0.0:8099
```

Set `PORT` to change the port.

## Storage backend

Default: **one JSON file per key** under `.rhdata/`. No database required.

To move the same data into **MySQL**, set these environment variables:

```
MYSQL_HOST=...
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=...
```

and install the driver:

```bash
npm install
```

The table is created automatically:

```sql
CREATE TABLE IF NOT EXISTS rh_store (
  k VARCHAR(190) NOT NULL PRIMARY KEY,
  v LONGTEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

If `mysql2` is missing or the connection fails, the server logs a warning and keeps
serving from JSON. **A database problem never takes the site down.**

The wire contract is identical either way, so `app.js` and every HTML page are
unaffected by the choice.

## Security

| Variable | Default | Effect |
| --- | --- | --- |
| `RH_ALLOW_RESET` | `0` (off) | `POST /api/store?reset=1` is refused unless this is `1` |
| `RH_ADMIN_TOKEN` | empty | secret required for reset (`x-rh-token` header or `?token=`) |
| `RH_STRICT_ORIGIN` | `1` (on) | rejects writes whose Origin/Referer is another host |

Before this, `?reset=1` wiped the whole store with no secret at all. It is now
disabled unless both `RH_ALLOW_RESET=1` and a matching `RH_ADMIN_TOKEN` are set.

Writes from the browser stay open on purpose — `app.js` runs in the browser and has
no secret it could present. Real per-user authorisation would require moving login
to the server; the same-origin check already blocks other sites from writing.

## Endpoints

```
GET  /api/store            -> every key
GET  /api/store?noimg=1    -> every key except the spilled image bytes (fast boot)
GET  /api/store?key=rh_x   -> one key
POST /api/store            -> { key, value }  or  { bulk: { k: v, ... } }
POST /api/store?reset=1    -> wipe (disabled by default, token required)
POST /api/steadfast        -> server-side Steadfast courier call (hides the API key)
```
