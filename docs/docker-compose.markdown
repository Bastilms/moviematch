# Docker Compose

This project includes a `docker-compose.yml` file for easy deployment. First, build the Docker image locally:

```bash
docker build -t moviematch:local .
```

Then, create a `.env` file from the template:

```bash
cp .env.example .env
```

Edit the `.env` file with your media server configuration, then start the services:

```bash
docker compose up
```

The application will be available at `http://localhost:8000`.

## Configuration

The `docker-compose.yml` uses environment variables from a `.env` file. See [.env.example](./.env.example) for all available configuration options.

### Example configurations

#### Plex

```ini
BACKEND=plex
PLEX_URL=https://plex.example.com:32400
PLEX_TOKEN=your_token_here
```

#### Jellyfin

```ini
BACKEND=jellyfin
JELLYFIN_URL=https://jellyfin.example.com
JELLYFIN_API_KEY=your_api_key_here
```

## Persistent data

The docker-compose configuration creates a named volume `moviematch-data` that persists your ratings and matches across container restarts. The database file is stored at `/data/moviematch.db` inside the container.
