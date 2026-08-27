/**
 * Path resolution
 *
 * dear-claude runs as a stdio MCP server, which means it is spawned by the MCP
 * client (Claude Code) and inherits that client's working directory. Anything
 * resolved against process.cwd() therefore lands in whatever project the user
 * happened to open, so all persistent state resolves to a fixed per-user
 * location instead.
 */

import { homedir } from "os";
import { join } from "path";

/**
 * Directory holding the database, workspaces and instance contexts.
 *
 * Resolution order:
 *   1. DEAR_CLAUDE_DATA_DIR   explicit override
 *   2. $XDG_DATA_HOME/dear-claude
 *   3. ~/.local/share/dear-claude
 */
export function getDataDir(): string {
  const override = process.env.DEAR_CLAUDE_DATA_DIR;
  if (override) return override;

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) return join(xdgDataHome, "dear-claude");

  return join(homedir(), ".local", "share", "dear-claude");
}
