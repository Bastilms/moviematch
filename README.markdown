# <img src="public/assets/logo.svg" height="40px" alt="MovieMatch" />

## What is this?

Have you ever spent longer deciding on a movie than it'd take to just watch a random movie? MovieMatch is an app that helps you and your friends pick a movie to watch from a **Plex or Jellyfin media server**.

## How it works

MovieMatch connects to your Plex or Jellyfin server and gets a list of movies from any libraries marked as a movie library.

As many people as you want connect to your MovieMatch server and get a list of shuffled movies. Swipe right to 👍, swipe left to 👎.

If two (or more) people swipe right on the same movie, it'll show up in everyone's matches. The movies that the most people swiped right on will show up first.

**Rooms and ratings persist across server restarts** — thanks to SQLite, your matches and ratings are saved to disk and will be available when MovieMatch starts again.

## Getting started

### With Node.js (local)

- Ensure you have **Node.js 24 or later** installed
- Clone or download this repository
- Create a `.env` file in the repository root (see [.env.example](./.env.example) for an example)
- Run `npm ci` to install dependencies
- Run `npm run build` to compile TypeScript
- Run `node dist/index.js` to start the server

Open [localhost:8000](http://localhost:8000)

### With Docker

**Note:** This is a fork of the original MovieMatch project and does not provide pre-built images. You need to build the image locally first.

First, build the Docker image:

```bash
docker build -t moviematch:local .
```

#### Important: Directory Permissions

When mounting a host directory into the container, it **must be writable by UID 1000** (the `node` user inside the container). If the directory is not writable, the container will start but fail when the first user tries to join.

Set up the directory with the correct permissions:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

If you don't set the correct permissions, you will see an error message like:
```
Failed to initialize database.
Database path: /data/moviematch.db
Directory: /data (running as UID 1000, GID 1000)

If you mounted a host directory into the container, make sure it is writable.
Example fix: mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

#### With docker-compose (recommended)

The easiest way to run MovieMatch with Docker is using docker-compose. See the [docker-compose documentation](./docs/docker-compose.markdown) for details.

#### With Docker directly

##### Plex example:

```bash
docker run -d \
  -e BACKEND=plex \
  -e PLEX_URL=https://plex.example.com:32400 \
  -e PLEX_TOKEN=your_token_here \
  -p 8000:8000 \
  -v ./data:/data \
  moviematch:local
```

##### Jellyfin example:

```bash
docker run -d \
  -e BACKEND=jellyfin \
  -e JELLYFIN_URL=https://jellyfin.example.com \
  -e JELLYFIN_API_KEY=your_api_key_here \
  -p 8000:8000 \
  -v ./data:/data \
  moviematch:local
```

The `-v ./data:/data` flag binds a host directory to the container, so your ratings and matches persist across restarts.

## Configuration

The following variables are supported via a `.env` file or environment variables.

| Name                        | Description                                                                                                                                                           | Required | Default                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `BACKEND`                   | Which media server to use: `plex` or `jellyfin`                                                                                                                      | No       | `plex`                                                                             |
| `PLEX_URL`                  | URL of the Plex server, e.g. `https://plex.example.com:32400`                                                                                                        | Only when `BACKEND=plex` | null                                                                               |
| `PLEX_TOKEN`                | Plex authentication token ([How to find yours](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))                          | Only when `BACKEND=plex` | null                                                                               |
| `JELLYFIN_URL`              | URL of the Jellyfin server, e.g. `https://jellyfin.example.com`                                                                                                      | Only when `BACKEND=jellyfin` | null                                                                               |
| `JELLYFIN_API_KEY`          | Jellyfin API key (Dashboard → API Keys)                                                                                                                             | Only when `BACKEND=jellyfin` | null                                                                               |
| `JELLYFIN_USER_ID`          | Jellyfin user whose libraries are used. Must be a 32-character hex id or a GUID. If unset, the first user on the server is used.                                    | No       | first user                                                                         |
| `DATABASE_PATH`             | Path to the SQLite database file. The directory is created if missing.                                                                                              | No       | `./data/moviematch.db`                                                             |
| `PORT`                      | The port the server will run on                                                                                                                                       | No       | 8000                                                                               |
| `ROOT_PATH`                 | The root path to use when loading resources. For example, if MovieMatch is on a sub-path, set this to that sub-path (_without a trailing slash_)                   | No       | ''                                                                                 |
| `LIBRARY_FILTER`            | A comma-delimited list of libraries to include, e.g. `Films` or `Films,Television`. For Jellyfin, matches against library/view names.                             | No       | The first library with the type of `DEFAULT_SECTION_TYPE_FILTER`                   |
| `COLLECTION_FILTER`         | A comma-delimited list of collections to include, e.g. `Marvel` or `Marvel,HBO`. For Jellyfin, this filters by BoxSet names.                                     | No       | ''                                                                                 |
| `DEFAULT_SECTION_TYPE_FILTER` | The first library with this type will be chosen as a default library. For Jellyfin: `movie` → movies, `show` → tvshows, `artist` → music, `photo` → homevideos | No       | `movie`                                                                            |
| `LINK_TYPE`                 | The method to use for opening match links (**Plex only**; Jellyfin always links to its web UI)                                                                     | No       | `app` (can be `app`, `http`, or `plex.tv`)                                         |
| `LOG_LEVEL`                 | How much the server should log                                                                                                                                        | No       | `INFO` (can be `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`)                 |
| `MOVIE_BATCH_SIZE`          | How many movies to load initially. Leave this alone unless you run out of cards really quickly.                                                                    | No       | 25                                                                                 |
| `RATE_LIMIT_ENABLED`        | Enable rate limiting to protect against abuse. When enabled, requests exceeding the per-minute limits will not receive a response and will time out.               | No       | `true`                                                                             |
| `RATE_LIMIT_HTTP_PER_MINUTE` | Maximum HTTP requests per IP address per minute                                                                                                                    | No       | 300                                                                                |
| `RATE_LIMIT_WS_PER_MINUTE`   | Maximum WebSocket connection attempts per IP address per minute                                                                                                   | No       | 20                                                                                 |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | Maximum WebSocket messages per IP address per minute                                                                                                           | No       | 300                                                                                |
| `TRUST_PROXY`               | Trust `X-Forwarded-For` header for client IP detection. **Only enable if MovieMatch runs behind a trusted reverse proxy** (nginx, HAProxy, Apache). When disabled, each rate limit applies per proxy IP. When enabled, limits apply per origin IP. | No       | `false`                                                                            |

## Share and Export

### Share Room Link

When viewing matches, a **Share** button in the top-right corner lets you share the room with others:
- On devices that support it, opens the native share menu
- Otherwise, copies the link to your clipboard

The link includes the room code as a URL parameter (`?room=<CODE>`) and will pre-fill the code when someone joins.

### Export Matches to CSV

Matches can be exported to CSV format via:
```
GET /api/rooms/<CODE>/matches.csv
```

The CSV contains the following columns: `Title`, `Year`, `Director`, `Rating`, `Type`, `Likes`, `Users`, `Link`.

An **Export** button in the matches view provides convenient access to this endpoint.

## FAQ

### Can a user get my media server credentials?

No. The client never talks directly to your media server. All requests that need authentication (querying content, retrieving images, etc.) are made by the MovieMatch server itself.

Only a subset of the server response is sent to the client to minimize the chance of sensitive information leaking.

### Can it do TV shows too?

Yes, you can include a TV library in your `LIBRARY_FILTER` list or set `DEFAULT_SECTION_TYPE_FILTER=show`.

### What data does MovieMatch store?

MovieMatch uses SQLite to persist:
- Room metadata (room codes, creation time)
- User ratings for each movie (which users swiped right/left on which movies)
- Matches (when two or more users swiped right on the same movie)

The database file is stored at the path specified by `DATABASE_PATH` (default: `./data/moviematch.db`). Deleting this file will erase all saved ratings and matches.

All other data is kept in memory while the server runs.

### Do you gather any data outside the database?

No. The server is entirely local to you and will work offline.

### Do you support languages other than English?

Yes. The server will use your browser's preferred language by default if it's supported. Otherwise it'll fall back to English.

The translations can be found [in the i18n folder](./i18n).

The file names follow [BCP47](https://tools.ietf.org/html/bcp47) naming. Feel free to submit a Pull Request if you'd like your language to be supported.

### Can I run MovieMatch behind a reverse proxy?

Yes, you can read some documentation [here](./docs/reverse-proxy.markdown)

---

## ⚠️ Security Notice

**MovieMatch does not include authentication.** Anyone with access to the room code (or who can guess the CSV export endpoint) can view the matches and ratings for that room.

Do **not** expose an unprotected MovieMatch instance to the public internet. Use a reverse proxy with authentication, a firewall, or run it on a private network only.

### Jellyfin User Authentication

MovieMatch supports optional authentication with a Jellyfin user account. When this feature is used, the user's password is transmitted from the browser to the MovieMatch server and then to the Jellyfin server. On unsecured connections (plain HTTP), the password travels in cleartext and can be intercepted — **HTTPS is strongly recommended** for this feature.

MovieMatch does not store passwords or persist Jellyfin credentials. The access token returned by Jellyfin is kept only in server memory for the duration of the connection and is not saved to disk or the database.
