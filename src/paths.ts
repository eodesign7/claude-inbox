import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export const homeDir = () => process.env.CLAUDE_INBOX_HOME ?? join(homedir(), ".claude-inbox");
export const projectsDir = () => join(homeDir(), "projects");
export const logDir = () => join(homeDir(), "log");

/** Konfigurácia Claude desktop podľa platformy. */
export function desktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.CLAUDE_INBOX_DESKTOP_CONFIG) return env.CLAUDE_INBOX_DESKTOP_CONFIG;
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    return win32.join(env.APPDATA ?? win32.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_INBOX_SETTINGS ?? join(home, ".claude", "settings.json");
}
