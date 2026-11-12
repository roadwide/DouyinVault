import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps.js";

export function registerSettingsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/api/v1/settings", async () => {
    const settings = deps.settings.get();
    const snapshot = deps.health.snapshot();
    return {
      settings,
      environment: {
        adapter: deps.config.imAdapter,
        demoMode: deps.config.demoMode,
        dtkConfigured: Boolean(deps.config.dtkBaseUrl),
        dtkMode: deps.config.dtkMode,
        ytdlpPath: deps.config.ytdlpPath,
        ytdlpCookiesConfigured: Boolean(deps.config.ytdlpCookiesPath),
        ffmpegPath: deps.config.ffmpegPath,
        ffprobePath: deps.config.ffprobePath,
        mediaAllowedHosts: deps.config.mediaAllowedHosts,
        secureCookies: deps.config.secureCookies,
        publicOrigin: deps.config.publicOrigin,
        nodeEnv: deps.config.nodeEnv,
      },
      cleanup: {
        enabled: settings.cleanup.enabled,
        lastRunAt: snapshot.cleanup.lastRunAt,
        nextRunAt: snapshot.cleanup.nextRunAt,
      },
      backup: { lastRunAt: deps.backup.lastRunAt() },
    };
  });

  app.patch("/api/v1/settings", async (request) => {
    const settings = deps.settings.update(request.body);
    return { settings };
  });

  app.post("/api/v1/cleanup/run", async () => {
    const result = await deps.cleanup.run("manual");
    return { result };
  });

  app.post("/api/v1/backup/run", async () => {
    const result = await deps.backup.run();
    return {
      path: result.path.replace(deps.paths.backupsDir, "backups"),
      bytes: result.bytes,
    };
  });
}
