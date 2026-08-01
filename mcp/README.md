# Dockyard MCP Server

A Model Context Protocol (MCP) server that exposes Dockyard management tools
to MCP-compatible clients (e.g., Claude Desktop). It runs over stdio and
imports `server/src/services/*` directly rather than going through HTTP.

## How to start

```bash
npm --workspace mcp run dev
```

## Architecture

The MCP server shares the same SQLite database, Docker socket, and MinIO client
as the main Express server. It imports service-layer functions directly from
`server/src/` — it does not make HTTP calls to the REST API.

## Relationship to the main server

- Uses `server/src/db.js` for database access.
- Uses `server/src/docker.js` for container operations.
- Uses `server/src/minio.js` for object storage.
- Uses `server/src/tool-schemas.js` for shared tool definitions.
