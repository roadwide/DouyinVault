const base = (process.env.VAULT_URL ?? "http://127.0.0.1:18760").replace(/\/+$/, "");

async function main(): Promise<void> {
  const response = await fetch(`${base}/healthz`, {
    signal: AbortSignal.timeout(5000),
  });
  const payload = (await response.json()) as { ok?: boolean; version?: string; uptimeSeconds?: number };
  if (!response.ok || !payload.ok) {
    console.error(`健康检查失败：HTTP ${response.status}`, payload);
    process.exit(1);
  }
  console.log(`OK  ${base}  v${payload.version}  运行 ${payload.uptimeSeconds}s`);

  const password = process.env.VAULT_ADMIN_PASSWORD;
  if (password) {
    const login = await fetch(`${base}/api/v1/session/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!login.ok) {
      console.error(`详细状态需要登录，但登录失败：HTTP ${login.status}`);
      process.exit(1);
    }
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter(Boolean)
      .join("; ");
    const status = (await (
      await fetch(`${base}/api/v1/system/status`, { headers: { Cookie: cookie } })
    ).json()) as {
      status?: string;
      issues?: Array<{ level: string; message: string }>;
      auth?: { status?: string };
      videos?: { ready?: number };
      downloads?: { active?: number; failed?: number };
    };
    console.log(`系统状态：${status.status}  账号：${status.auth?.status}  已缓存：${status.videos?.ready}  活动下载：${status.downloads?.active}  失败：${status.downloads?.failed}`);
    for (const issue of status.issues ?? []) {
      console.log(`[${issue.level}] ${issue.message}`);
    }
    if (status.status === "error") process.exit(1);
  }
}

main().catch((error) => {
  console.error("健康检查失败：", error);
  process.exit(1);
});
